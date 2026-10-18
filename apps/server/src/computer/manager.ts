import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { BrowserAction, BrowserResult, BrowserSession, ExecResult, PtySession, Sandbox, SandboxState } from "@northbot/sandbox";
import { scrubSecrets } from "@northbot/shared";
import { sha256 } from "../auth/sessions.js";
import type { Config } from "../config.js";
import type { DbHandle } from "../db/client.js";
import { agents, sandboxes } from "../db/schema.js";
import type { EventLog } from "../events/log.js";

export type Actor = "user" | "agent" | "system";

export interface AgentRef {
  workspaceId: string;
  agentId: string;
}

const PREVIEW = 500;

/** Owns every agent computer: lifecycle, commands and browser, each step written as an event. */
export class ComputerManager {
  /** Sandboxes a human has taken over; the agent runtime pauses its tool calls on these. */
  private readonly takenOver = new Map<string, string>();

  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
    readonly sandbox: Sandbox,
    private readonly config: Config,
  ) {}

  private async row(ref: AgentRef) {
    const [row] = await this.db.db
      .select({ sandbox: sandboxes })
      .from(agents)
      .innerJoin(sandboxes, eq(sandboxes.id, agents.sandboxId))
      .where(and(eq(agents.id, ref.agentId), eq(agents.workspaceId, ref.workspaceId)));
    if (!row) throw new ComputerError("not_found", "That agent has no computer.");
    return row.sandbox;
  }

  async createFor(ref: AgentRef): Promise<string> {
    const id = `sbx${randomBytes(6).toString("hex")}`;
    const token = randomBytes(24).toString("base64url");
    await this.db.db.insert(sandboxes).values({
      id,
      workspaceId: ref.workspaceId,
      agentId: ref.agentId,
      driver: this.config.SANDBOX_DRIVER,
      egressTokenHash: sha256(token),
    });
    const info = await this.sandbox.create({
      id,
      egressProxyUrl: `http://${id}:${token}@${this.config.EGRESS_HOST}:${this.config.EGRESS_PORT}`,
      labels: { "northbot.workspace": ref.workspaceId, "northbot.agent": ref.agentId },
    });
    await this.db.db.update(sandboxes).set({ containerId: info.containerId }).where(eq(sandboxes.id, id));
    await this.db.db.update(agents).set({ sandboxId: id }).where(eq(agents.id, ref.agentId));
    await this.events.write(ref.workspaceId, {
      type: "sandbox.created",
      agentId: ref.agentId,
      payload: { sandboxId: id, driver: this.config.SANDBOX_DRIVER },
    });
    return id;
  }

  private async setState(id: string, state: SandboxState) {
    await this.db.db.update(sandboxes).set({ state, updatedAt: new Date() }).where(eq(sandboxes.id, id));
  }

  async state(ref: AgentRef): Promise<SandboxState> {
    return this.sandbox.state((await this.row(ref)).id);
  }

  async hibernate(ref: AgentRef, reason: string): Promise<void> {
    const sb = await this.row(ref);
    if ((await this.sandbox.state(sb.id)) !== "running") return;
    await this.sandbox.hibernate(sb.id);
    await this.setState(sb.id, "hibernated");
    await this.events.write(ref.workspaceId, { type: "sandbox.hibernated", agentId: ref.agentId, payload: { sandboxId: sb.id, reason } });
  }

  /** Wakes the computer if it is hibernated or stopped. Returns true if it had to wake. */
  async ensureAwake(ref: AgentRef, reason: string): Promise<boolean> {
    const sb = await this.row(ref);
    const state = await this.sandbox.state(sb.id);
    if (state === "running") return false;
    if (state === "missing" || state === "destroyed") throw new ComputerError("gone", "This agent's computer no longer exists.");
    await this.sandbox.wake(sb.id);
    await this.setState(sb.id, "running");
    await this.events.write(ref.workspaceId, { type: "sandbox.woken", agentId: ref.agentId, payload: { sandboxId: sb.id, reason } });
    return true;
  }

  async snapshot(ref: AgentRef): Promise<string> {
    const sb = await this.row(ref);
    const { snapshotId } = await this.sandbox.snapshot(sb.id);
    await this.events.write(ref.workspaceId, { type: "sandbox.snapshot", agentId: ref.agentId, payload: { sandboxId: sb.id, snapshotId } });
    return snapshotId;
  }

  async destroy(ref: AgentRef): Promise<void> {
    const sb = await this.row(ref).catch(() => null);
    if (!sb) return;
    await this.sandbox.destroy(sb.id);
    await this.setState(sb.id, "destroyed");
    await this.events.write(ref.workspaceId, { type: "sandbox.destroyed", agentId: ref.agentId, payload: { sandboxId: sb.id } });
  }

  async exec(ref: AgentRef, command: string, by: Actor, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const sb = await this.row(ref);
    await this.ensureAwake(ref, `${by} ran a command`);
    const r = await this.sandbox.exec(sb.id, command, opts);
    await this.events.write(ref.workspaceId, {
      type: "terminal.exec",
      agentId: ref.agentId,
      payload: {
        sandboxId: sb.id,
        by,
        command: scrubSecrets(command).slice(0, 2000),
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        outputPreview: scrubSecrets(r.stdout + r.stderr).slice(0, PREVIEW),
      },
    });
    return r;
  }

  /** Stops every command an agent or user started with exec (the live shell is left alone). */
  async stopCommands(ref: AgentRef): Promise<void> {
    const sb = await this.row(ref).catch(() => null);
    if (!sb || (await this.sandbox.state(sb.id)) !== "running") return;
    // exec wraps commands in `timeout -k 2 N bash -lc ...`; TERM on the wrapper reaches the child.
    await this.sandbox.exec(sb.id, "pkill -TERM -f '^timeout -k 2 ' ; true", { raw: true, timeoutMs: 5000 }).catch(() => {});
  }

  async browser(ref: AgentRef): Promise<BrowserSession> {
    const sb = await this.row(ref);
    await this.ensureAwake(ref, "browser opened");
    return this.sandbox.browserSession(sb.id);
  }

  async browse(ref: AgentRef, action: BrowserAction, by: Actor): Promise<BrowserResult> {
    const sb = await this.row(ref);
    const session = await this.browser(ref);
    try {
      const r = await session.act(action);
      await this.events.write(ref.workspaceId, {
        type: "browser.action",
        agentId: ref.agentId,
        payload: { sandboxId: sb.id, by, action: action.action, url: r.url, title: r.title, ok: true },
      });
      return r;
    } catch (err) {
      const message = scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.events.write(ref.workspaceId, {
        type: "browser.action",
        agentId: ref.agentId,
        payload: { sandboxId: sb.id, by, action: action.action, url: "url" in action ? action.url : undefined, ok: false, error: message },
      });
      throw new ComputerError("browser_error", message);
    }
  }

  async pty(ref: AgentRef, opts: { cols?: number; rows?: number }): Promise<PtySession> {
    const sb = await this.row(ref);
    await this.ensureAwake(ref, "terminal opened");
    return this.sandbox.openPty(sb.id, { name: "main", ...opts });
  }

  async takeOver(ref: AgentRef, userId: string): Promise<void> {
    const sb = await this.row(ref);
    this.takenOver.set(sb.id, userId);
    await this.events.write(ref.workspaceId, { type: "sandbox.takeover", agentId: ref.agentId, payload: { sandboxId: sb.id, userId } });
  }

  async release(ref: AgentRef, userId: string): Promise<void> {
    const sb = await this.row(ref);
    if (!this.takenOver.delete(sb.id)) return;
    await this.events.write(ref.workspaceId, { type: "sandbox.released", agentId: ref.agentId, payload: { sandboxId: sb.id, userId } });
  }

  async isTakenOver(ref: AgentRef): Promise<boolean> {
    return this.takenOver.has((await this.row(ref)).id);
  }
}

export class ComputerError extends Error {
  constructor(
    readonly code: "not_found" | "gone" | "browser_error",
    message: string,
  ) {
    super(message);
  }
}
