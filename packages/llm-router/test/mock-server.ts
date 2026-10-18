import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

type Handler = (req: Recorded, res: ServerResponse) => void;

/** A local HTTP server that records request bodies, for testing provider adapters offline. */
export async function mockServer(handler: Handler) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rec = { path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      requests.push(rec);
      handler(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Writes Server-Sent Events. `event` is optional (OpenAI omits it, Anthropic uses it). */
export function sse(res: ServerResponse, events: { event?: string; data: unknown }[], done = false): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    res.write(`${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`);
  }
  if (done) res.write("data: [DONE]\n\n");
  res.end();
}
