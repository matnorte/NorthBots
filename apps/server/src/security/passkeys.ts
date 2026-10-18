import { decide, type Autonomy, type ProposedAction } from "@northbot/agent-runtime";
import { agents } from "../db/schema.js";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { SoftAuthenticator } from "../auth/soft/authenticator.js";
import { agentPasskeys } from "../db/schema.js";
import type { Services } from "../services.js";
import type { GrantService } from "./grants.js";
export class PasskeyVault {
  private connections = new Map<string, () => void>();
  close() {
    for (const off of this.connections.values()) off();
    this.connections.clear();
  }
  async connect(ws: string, id: string, agentId: string) {
    const [row] = await this.s.db.db
      .select()
      .from(agentPasskeys)
      .where(
        and(
          eq(agentPasskeys.id, id),
          eq(agentPasskeys.workspaceId, ws),
          eq(agentPasskeys.agentId, agentId),
        ),
      );
    if (!row) throw new Error("No such passkey");
    const browser = await this.s.computers.browser({ workspaceId: ws, agentId });
    if (!browser.enableVault) throw new Error("This browser driver does not support vault signing");
    const key = `${ws}:${agentId}`;
    this.connections.get(key)?.();
    const off = await browser.enableVault(async (request) => {
      if (
        request.origin !== row.origin ||
        request.rpId !== row.rpId ||
        (request.allowCredentials.length && !request.allowCredentials.includes(row.credentialId))
      )
        throw new Error("Site does not match the connected passkey");
      const action: ProposedAction = {
        kind: "login",
        tool: "browser",
        args: { action: "passkey", passkeyId: id },
        summary: `Sign in to ${row.rpId} with the agent passkey`,
        targets: [row.rpId],
      };
      const agent = (await this.s.db.db.select().from(agents).where(eq(agents.id, agentId)))[0];
      const permission = decide(
        action,
        await this.s.rules.forAgent(ws, agentId),
        (agent?.autonomyLevel as Autonomy) ?? "ask_first",
      );
      if (permission.decision === "block") throw new Error("Login blocked by permissions");
      this.s.computers.hold({ workspaceId: ws, agentId });
      try {
        if (permission.decision === "ask") {
          const approval = await this.s.approvals.open(
            { workspaceId: ws, agentId, taskId: null },
            action,
            permission.reason,
          );
          if (
            (await this.s.approvals.wait(ws, approval.id, AbortSignal.timeout(240000))) === "deny"
          )
            throw new Error("Login denied");
        }
        return await this.sign(ws, id, agentId, request.challenge);
      } finally {
        this.s.computers.unhold({ workspaceId: ws, agentId });
      }
    });
    this.connections.set(key, off);
    return { connected: true };
  }
  constructor(
    private s: Pick<
      Services,
      "db" | "vault" | "events" | "computers" | "tasks" | "approvals" | "rules"
    >,
    private grants: GrantService,
  ) {}
  private async site(ws: string, agentId: string, rpId: string, origin: string) {
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin ||
      parsed.hostname !== rpId ||
      !(
        parsed.protocol === "https:" ||
        (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))
      )
    )
      throw new Error("Passkeys require the exact site origin and relying party");
    const browser = await this.s.computers.browser({ workspaceId: ws, agentId });
    try {
      const tabs = await browser.tabs();
      const active = tabs.pages.find((p) => p.pageId === tabs.activePageId);
      if (!active || new URL(active.url).origin !== origin)
        throw new Error("The agent browser must be on this site");
    } finally {
      browser.close();
    }
    if (await this.s.tasks.killSwitchOn(ws)) throw new Error("Kill switch is on");
  }
  async register(input: {
    workspaceId: string;
    agentId: string;
    rpId: string;
    origin: string;
    challenge: string;
    userHandle: string;
    ownerId: string;
  }) {
    await this.site(input.workspaceId, input.agentId, input.rpId, input.origin);
    const auth = new SoftAuthenticator(input.origin, input.rpId);
    const response = auth.create({ challenge: input.challenge, user: { id: input.userHandle } });
    const cred = auth.credentials[0]!;
    const [row] = await this.s.db.db
      .insert(agentPasskeys)
      .values({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        rpId: input.rpId,
        origin: input.origin,
        credentialId: response.id,
        ownerId: input.ownerId,
      })
      .returning();
    if (!row) throw new Error("Passkey already registered");
    const name = `AGENT_PASSKEY_${row.id.replaceAll("-", "")}`;
    try {
      await this.s.vault.put(
        input.workspaceId,
        name,
        JSON.stringify({
          privateKey: cred.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
          publicKey: cred.publicKey.export({ format: "pem", type: "spki" }).toString(),
          userHandle: cred.userHandle,
        }),
      );
      await this.grants.grant({
        workspaceId: input.workspaceId,
        resource: `passkey:${row.id}`,
        subjectKind: "agent",
        subjectId: input.agentId,
        role: "use-only",
        expiresAt: new Date(Date.now() + 86400000),
        createdBy: input.ownerId,
      });
    } catch (e) {
      await this.s.db.db.delete(agentPasskeys).where(eq(agentPasskeys.id, row.id));
      throw e;
    }
    await this.s.events.write(input.workspaceId, {
      type: "security.passkey",
      agentId: input.agentId,
      payload: { passkeyId: row.id, operation: "registered", rpId: row.rpId },
    });
    return { id: row.id, response };
  }
  async sign(ws: string, id: string, agentId: string, challenge: string) {
    // Lock the row: concurrent signatures wait their turn, so counters never repeat.
    return this.s.db.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(agentPasskeys)
        .where(
          and(
            eq(agentPasskeys.id, id),
            eq(agentPasskeys.workspaceId, ws),
            eq(agentPasskeys.agentId, agentId),
          ),
        )
        .for("update");
      if (!row) throw new Error("No such passkey");
      if (!(await this.grants.authorize(ws, `passkey:${id}`, "agent", agentId)))
        throw new Error("Passkey access revoked or expired");
      await this.site(ws, agentId, row.rpId, row.origin);
      const response = await this.s.vault.withSecret(
        ws,
        `AGENT_PASSKEY_${row.id.replaceAll("-", "")}`,
        async (sealed) => {
          const data = JSON.parse(sealed) as {
            privateKey: string;
            publicKey: string;
            userHandle: string;
          };
          const auth = new SoftAuthenticator(row.origin, row.rpId);
          auth.credentials.push({
            id: Buffer.from(row.credentialId, "base64url"),
            privateKey: createPrivateKey(data.privateKey),
            publicKey: createPublicKey(data.publicKey),
            userHandle: data.userHandle,
            signCount: row.counter,
          });
          return auth.get({ challenge, allowCredentials: [{ id: row.credentialId }] });
        },
        "signing",
      );
      if (!response) throw new Error("Credential unavailable");
      await tx
        .update(agentPasskeys)
        .set({ counter: row.counter + 1 })
        .where(eq(agentPasskeys.id, id));
      await this.s.events.write(ws, {
        type: "security.passkey",
        agentId,
        payload: { passkeyId: id, operation: "signed", rpId: row.rpId },
      });
      return response;
    });
  }
}
