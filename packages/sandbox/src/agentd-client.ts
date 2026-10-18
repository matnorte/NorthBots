import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AgentdEvent {
  ev: string;
  [k: string]: unknown;
}

/**
 * JSON-lines RPC client for agentd, over any pair of streams (in production: the stdio of
 * `docker exec bridge.mjs`). Emits "event" for unsolicited messages and "close" at the end.
 */
export class AgentdClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  readonly ready: Promise<void>;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly onClose?: () => void,
    private readonly timeoutMs = 60_000,
  ) {
    super();
    let markReady: () => void = () => {};
    let failReady: (e: Error) => void = () => {};
    this.ready = new Promise((res, rej) => {
      markReady = res;
      failReady = rej;
    });
    const rl = createInterface({ input });
    rl.on("line", (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.ev === "bridge.ready") return markReady();
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error ?? "agentd error")));
        return;
      }
      if (typeof msg.ev === "string") this.emit("event", msg as AgentdEvent);
    });
    rl.on("close", () => {
      this.closed = true;
      failReady(new Error("agentd connection closed before it was ready"));
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("agentd connection closed"));
      }
      this.pending.clear();
      this.emit("close");
      this.onClose?.();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Fire-and-forget message (pty input, resize). */
  notify(op: string, params: Record<string, unknown> = {}): void {
    if (!this.closed) this.output.write(`${JSON.stringify({ op, ...params })}\n`);
  }

  call<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new Error("agentd connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agentd ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.output.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
  }

  close(): void {
    this.output.end();
  }
}
