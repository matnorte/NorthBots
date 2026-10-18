import { createHash, randomBytes, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { ExtraTool } from "@northbot/agent-runtime";
import type { DbHandle } from "../db/client.js";
import { companionDevices, companionPairings, files } from "../db/schema.js";
import type { EventLog } from "../events/log.js";
import type { TaskService } from "../tasks/service.js";

type Device = typeof companionDevices.$inferSelect;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const POWERS = ["view", "view+click", "full"] as const;
export type Power = (typeof POWERS)[number];
const READS = ["screenshot", "list_windows", "list_folder", "read_file"] as const;
const ACTS = ["click", "type", "key", "launch_app", "write_file"] as const;
export const ACTIONS = [...READS, ...ACTS] as const;
export type Action = (typeof ACTIONS)[number];

/** Same table as the companion's own check; the server refuses early, the device decides. */
export function powerAllows(power: string, action: string): boolean {
  if ((READS as readonly string[]).includes(action)) return POWERS.includes(power as Power);
  if (["click", "type", "key"].includes(action)) return power === "view+click" || power === "full";
  if (["launch_app", "write_file"].includes(action)) return power === "full";
  return false;
}

const PAIRING_MINUTES = 10;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
/** Readable pairing codes: no 0/O/1/I. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
interface Live {
  socket: Socket;
  workspaceId: string;
  power: string;
  pending: Map<string, { resolve: (m: Frame) => void; timer: NodeJS.Timeout }>;
}
interface Frame {
  type: string;
  id?: string;
  ok?: boolean;
  data?: unknown;
  error?: string;
  kind?: string;
}

export class CompanionError extends Error {
  constructor(
    readonly code: "not_found" | "offline" | "not_allowed" | "timeout" | "refused",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The server end of the Windows companion: pairing, the outbound tunnel each device keeps open,
 * commands (from people or agents), the screenshot trail, Wake-on-LAN and the kill switch.
 */
export class CompanionHub {
  private live = new Map<string, Live>();
  private off: (() => void) | null = null;

  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
    tasks: TaskService,
  ) {
    tasks.provideTools((ctx) => this.toolsFor(ctx));
    // The workspace kill switch also stops every paired computer.
    this.off = events.subscribeAll((workspaceId, e) => {
      if (e.type === "killswitch.engaged") void this.killAll(workspaceId, null);
    });
  }

  close(): void {
    this.off?.();
    for (const l of this.live.values()) l.socket.close(1001, "server stopping");
    this.live.clear();
  }

  async createPairing(
    workspaceId: string,
    userId: string,
  ): Promise<{ code: string; expiresAt: string }> {
    const raw = Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");
    const code = `NB-${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = new Date(Date.now() + PAIRING_MINUTES * 60_000);
    await this.db.db
      .insert(companionPairings)
      .values({ workspaceId, codeHash: sha256(code), createdBy: userId, expiresAt });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /** Trades a one-time code for a device token. The token is shown once; only its hash is kept. */
  async pair(input: {
    code: string;
    deviceName: string;
    os: string;
    mac?: string;
  }): Promise<{ deviceId: string; token: string } | null> {
    const [pairing] = await this.db.db
      .update(companionPairings)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(companionPairings.codeHash, sha256(input.code.trim().toUpperCase())),
          isNull(companionPairings.usedAt),
          gt(companionPairings.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!pairing) return null;
    const token = `nbc_${randomBytes(32).toString("base64url")}`;
    const mac =
      input.mac && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(input.mac)
        ? input.mac.toLowerCase().replace(/-/g, ":")
        : null;
    const [device] = await this.db.db
      .insert(companionDevices)
      .values({
        workspaceId: pairing.workspaceId,
        name: input.deviceName.slice(0, 80) || "Computer",
        os: input.os.slice(0, 20),
        mac,
        tokenHash: sha256(token),
      })
      .returning();
    if (!device) throw new Error("device insert failed");
    await this.events.write(pairing.workspaceId, {
      type: "companion.paired",
      payload: { deviceId: device.id, name: device.name, os: device.os, userId: pairing.createdBy },
    });
    return { deviceId: device.id, token };
  }

  /** The device behind a tunnel token, unless revoked. */
  async authenticate(token: string): Promise<Device | null> {
    const [d] = await this.db.db
      .select()
      .from(companionDevices)
      .where(
        and(eq(companionDevices.tokenHash, sha256(token)), isNull(companionDevices.revokedAt)),
      );
    return d ?? null;
  }

  isOnline(deviceId: string): boolean {
    return this.live.has(deviceId);
  }

  /** Runs one tunnel connection until it closes. */
  attach(
    device: Device,
    socket: Socket & {
      on(ev: "message", fn: (data: unknown) => void): void;
      on(ev: "close", fn: () => void): void;
    },
  ): void {
    const previous = this.live.get(device.id);
    previous?.socket.close(4000, "replaced by a newer connection");
    const live: Live = {
      socket,
      workspaceId: device.workspaceId,
      power: device.power,
      pending: new Map(),
    };
    let greeted = false;
    socket.on("message", (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(data)) as Frame;
      } catch {
        return;
      }
      if (!greeted) {
        if (frame.type !== "hello") return socket.close(4002, "say hello first");
        greeted = true;
        this.live.set(device.id, live);
        void this.hello(device, live, frame.data);
        return;
      }
      if (frame.type === "result" && frame.id) {
        const p = live.pending.get(frame.id);
        if (p) {
          clearTimeout(p.timer);
          live.pending.delete(frame.id);
          p.resolve(frame);
        }
      } else if (frame.type === "event") void this.deviceEvent(device, frame);
    });
    socket.on("close", () => {
      for (const p of live.pending.values()) {
        clearTimeout(p.timer);
        p.resolve({ type: "result", ok: false, error: "the computer disconnected" });
      }
      if (this.live.get(device.id) === live) {
        this.live.delete(device.id);
        void this.events
          .write(device.workspaceId, {
            type: "companion.disconnected",
            payload: { deviceId: device.id },
          })
          .catch(() => {});
      }
    });
  }

  private async hello(device: Device, live: Live, data: unknown): Promise<void> {
    const h = (data ?? {}) as { power?: string; folders?: unknown; apps?: unknown; os?: string };
    const power = POWERS.includes(h.power as Power) ? (h.power as Power) : "view";
    const list = (v: unknown) =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.slice(0, 260))
            .slice(0, 50)
        : [];
    live.power = power;
    const folders = list(h.folders);
    const apps = list(h.apps);
    await this.db.db
      .update(companionDevices)
      .set({
        power,
        folders,
        apps,
        lastSeenAt: new Date(),
        ...(h.os ? { os: h.os.slice(0, 20) } : {}),
      })
      .where(eq(companionDevices.id, device.id));
    await this.events.write(device.workspaceId, {
      type: "companion.connected",
      payload: { deviceId: device.id, power, folders: folders.length, apps: apps.length },
    });
  }

  private async deviceEvent(device: Device, frame: Frame): Promise<void> {
    const d = (frame.data ?? {}) as { png?: string; action?: string };
    if (frame.kind === "screenshot" && typeof d.png === "string") {
      const png = Buffer.from(d.png, "base64");
      if (
        png.length === 0 ||
        png.length > MAX_SCREENSHOT_BYTES ||
        png.subarray(1, 4).toString() !== "PNG"
      )
        return;
      const [file] = await this.db.db
        .insert(files)
        .values({
          workspaceId: device.workspaceId,
          name: `companion-${device.id.slice(0, 8)}-${Date.now()}.png`,
          mime: "image/png",
          size: png.length,
          sha256: createHash("sha256").update(png).digest("hex"),
          data: png,
        })
        .returning({ id: files.id });
      if (file)
        await this.events.write(device.workspaceId, {
          type: "companion.screenshot",
          payload: {
            deviceId: device.id,
            fileId: file.id,
            action: String(d.action ?? "").slice(0, 40),
          },
        });
    } else if (
      frame.kind &&
      ["control_taken_back", "control_resumed", "killed"].includes(frame.kind)
    ) {
      await this.events.write(device.workspaceId, {
        type: "companion.control",
        payload: { deviceId: device.id, kind: frame.kind },
      });
    }
  }

  async device(workspaceId: string, id: string): Promise<Device | null> {
    const [d] = await this.db.db
      .select()
      .from(companionDevices)
      .where(
        and(
          eq(companionDevices.id, id),
          eq(companionDevices.workspaceId, workspaceId),
          isNull(companionDevices.revokedAt),
        ),
      );
    return d ?? null;
  }

  async list(workspaceId: string): Promise<(Device & { online: boolean })[]> {
    const rows = await this.db.db
      .select()
      .from(companionDevices)
      .where(
        and(eq(companionDevices.workspaceId, workspaceId), isNull(companionDevices.revokedAt)),
      );
    return rows.map((d) => ({ ...d, online: this.live.has(d.id) }));
  }

  /** Sends one command and waits for the device's answer. */
  async command(
    workspaceId: string,
    deviceId: string,
    action: Action,
    args: Record<string, unknown>,
    who: { by: "user" | "agent"; taskId?: string | null },
  ): Promise<unknown> {
    const device = await this.device(workspaceId, deviceId);
    if (!device) throw new CompanionError("not_found", "No such computer.");
    const live = this.live.get(deviceId);
    if (!live) throw new CompanionError("offline", `${device.name} is not connected.`);
    if (!powerAllows(live.power, action))
      throw new CompanionError(
        "not_allowed",
        `${device.name} only allows "${live.power}"; ${action} needs more.`,
      );
    const id = randomUUID();
    const answer = await new Promise<Frame>((resolve) => {
      const timer = setTimeout(() => {
        live.pending.delete(id);
        resolve({ type: "result", ok: false, error: "the computer did not answer in time" });
      }, COMMAND_TIMEOUT_MS);
      live.pending.set(id, { resolve, timer });
      live.socket.send(JSON.stringify({ type: "command", id, action, args }));
    });
    await this.events.write(workspaceId, {
      type: "companion.command",
      payload: {
        deviceId,
        action,
        ok: Boolean(answer.ok),
        by: who.by,
        taskId: who.taskId ?? null,
        error: answer.ok ? null : (answer.error ?? "failed").slice(0, 300),
      },
    });
    if (!answer.ok) throw new CompanionError("refused", answer.error ?? "The computer refused.");
    return answer.data ?? null;
  }

  async update(
    workspaceId: string,
    deviceId: string,
    patch: { agentId?: string | null; enabled?: boolean; name?: string },
    userId: string,
  ): Promise<Device | null> {
    const [d] = await this.db.db
      .update(companionDevices)
      .set(patch)
      .where(
        and(
          eq(companionDevices.id, deviceId),
          eq(companionDevices.workspaceId, workspaceId),
          isNull(companionDevices.revokedAt),
        ),
      )
      .returning();
    if (d)
      await this.events.write(workspaceId, {
        type: "companion.updated",
        payload: { deviceId, agentId: d.agentId, enabled: d.enabled, userId },
      });
    return d ?? null;
  }

  async revoke(workspaceId: string, deviceId: string, userId: string): Promise<boolean> {
    const [d] = await this.db.db
      .update(companionDevices)
      .set({ revokedAt: new Date(), enabled: false })
      .where(
        and(
          eq(companionDevices.id, deviceId),
          eq(companionDevices.workspaceId, workspaceId),
          isNull(companionDevices.revokedAt),
        ),
      )
      .returning();
    if (!d) return false;
    this.live.get(deviceId)?.socket.close(4001, "unpaired");
    await this.events.write(workspaceId, {
      type: "companion.revoked",
      payload: { deviceId, userId },
    });
    return true;
  }

  async kill(workspaceId: string, deviceId: string, userId: string | null): Promise<boolean> {
    const live = this.live.get(deviceId);
    if (!live || live.workspaceId !== workspaceId) return false;
    live.socket.send(JSON.stringify({ type: "kill" }));
    await this.events.write(workspaceId, {
      type: "companion.killed",
      payload: { deviceId, userId },
    });
    return true;
  }

  private async killAll(workspaceId: string, userId: string | null): Promise<void> {
    for (const [id, l] of this.live)
      if (l.workspaceId === workspaceId) await this.kill(workspaceId, id, userId).catch(() => {});
  }

  /** Sends a Wake-on-LAN magic packet for the device's network card. */
  async wake(
    workspaceId: string,
    deviceId: string,
    userId: string,
    target = { address: "255.255.255.255", port: 9 },
  ): Promise<boolean> {
    const device = await this.device(workspaceId, deviceId);
    if (!device?.mac) return false;
    const packet = magicPacket(device.mac);
    const sock = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(() => {
        sock.setBroadcast(true);
        sock.send(packet, target.port, target.address, (err) => (err ? reject(err) : resolve()));
      });
    }).finally(() => sock.close());
    await this.events.write(workspaceId, {
      type: "companion.wake",
      payload: { deviceId, mac: device.mac, userId },
    });
    return true;
  }

  /** Desktop tools for an agent, only when a human assigned it a computer and switched it on. */
  private toolsFor(ctx: { workspaceId: string; agentId: string; taskId: string }): ExtraTool[] {
    const run = async (args: Record<string, unknown>, allowed: readonly string[]) => {
      const [device] = await this.db.db
        .select()
        .from(companionDevices)
        .where(
          and(
            eq(companionDevices.workspaceId, ctx.workspaceId),
            eq(companionDevices.agentId, ctx.agentId),
            eq(companionDevices.enabled, true),
            isNull(companionDevices.revokedAt),
          ),
        );
      if (!device)
        return {
          output:
            "No computer is enabled for you. Ask a human to enable one in Settings → Companion.",
          ok: false,
        };
      const action = String(args.action ?? "");
      if (!allowed.includes(action)) return { output: `Unknown action "${action}".`, ok: false };
      const { action: _a, ...rest } = args;
      try {
        const data = await this.command(ctx.workspaceId, device.id, action as Action, rest, {
          by: "agent",
          taskId: ctx.taskId,
        });
        if (action === "screenshot") {
          const d = data as { width?: number; height?: number };
          return {
            output: `Took a ${d.width}×${d.height} screenshot (kept in the audit log).`,
            ok: true,
          };
        }
        return { output: data == null ? "Done." : JSON.stringify(data).slice(0, 8000), ok: true };
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), ok: false };
      }
    };
    const params = (actions: readonly string[]) => ({
      type: "object",
      properties: {
        action: { type: "string", enum: [...actions] },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string" },
        key: { type: "string" },
        app: { type: "string" },
        path: { type: "string" },
        data: { type: "string", description: "base64 file content" },
      },
      required: ["action"],
    });
    return [
      {
        def: {
          name: "desktop_look",
          description:
            "Look at the human's paired Windows computer: screenshot, list shared app windows, list or read files in shared folders.",
          parameters: params(READS),
        },
        kind: "read",
        run: (args) => run(args, READS),
      },
      {
        def: {
          name: "desktop_act",
          description:
            "Act on the human's paired Windows computer inside the apps and folders they shared: click, type, key, launch_app, write_file.",
          parameters: params(ACTS),
        },
        kind: "write",
        run: (args) => run(args, ACTS),
      },
    ];
  }
}

/** 6 × 0xFF, then the MAC address 16 times. */
export function magicPacket(mac: string): Buffer {
  const bytes = mac.split(/[:-]/).map((h) => parseInt(h, 16));
  if (bytes.length !== 6 || bytes.some((b) => Number.isNaN(b))) throw new Error("bad MAC address");
  return Buffer.concat([
    Buffer.alloc(6, 0xff),
    ...Array.from({ length: 16 }, () => Buffer.from(bytes)),
  ]);
}
