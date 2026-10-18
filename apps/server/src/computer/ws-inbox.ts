import type { WebSocket } from "ws";

export type Msg = Record<string, unknown> & { type: string };

/**
 * Collects a socket's messages from the moment it connects. Route handlers do async setup
 * (open the pty, start the screencast) before they can act on input; without this, anything
 * the client sends on `open` would be lost. Malformed messages are dropped.
 */
export function inbox(socket: WebSocket) {
  const queue: Msg[] = [];
  let handler: ((m: Msg) => void | Promise<void>) | null = null;
  let chain = Promise.resolve();

  const deliver = (m: Msg) => {
    // Handle in arrival order even when the handler is async.
    chain = chain.then(() => handler?.(m)).catch(() => {});
  };

  socket.on("message", (raw) => {
    let m: Msg;
    try {
      m = JSON.parse(String(raw)) as Msg;
    } catch {
      return;
    }
    if (typeof m?.type !== "string") return;
    if (handler) deliver(m);
    else queue.push(m);
  });

  return {
    /** Starts handling: queued messages first, then live ones. */
    handle(fn: (m: Msg) => void | Promise<void>): void {
      handler = fn;
      for (const m of queue.splice(0)) deliver(m);
    },
  };
}
