// bridge: run by the server via `docker exec -i` (as root). Pipes newline-delimited JSON
// between stdin/stdout and agentd's unix-socket WebSocket, adding the token.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import WebSocket from "ws";

const token = readFileSync("/run/agentd/token", "utf8").trim();

function connect(attempt = 0) {
  const ws = new WebSocket("ws+unix:///run/agentd/agentd.sock:/", {
    headers: { authorization: `Bearer ${token}` },
  });
  ws.on("error", (err) => {
    // agentd may still be starting right after the container starts.
    if (attempt < 50 && ws.readyState !== WebSocket.OPEN) setTimeout(() => connect(attempt + 1), 200);
    else {
      console.error(`[bridge] ${err.message}`);
      process.exit(1);
    }
  });
  ws.on("open", () => {
    process.stdout.write(`${JSON.stringify({ ev: "bridge.ready" })}\n`);
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => line && ws.send(line));
    rl.on("close", () => ws.close());
  });
  ws.on("message", (data) => process.stdout.write(`${String(data)}\n`));
  ws.on("close", () => process.exit(0));
}

connect();
