// bridge: run by the server via `docker exec -i` (as root). Pipes newline-delimited JSON
// between stdin/stdout and agentd's unix-socket WebSocket, adding the token.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import WebSocket from "ws";

const TOKEN_FILE = "/run/agentd/token";
const SOCKET = "/run/agentd/agentd.sock";
const DEADLINE = Date.now() + 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Right after the computer starts, agentd may still be loading: wait for its token and socket.
while (!(existsSync(TOKEN_FILE) && existsSync(SOCKET))) {
  if (Date.now() > DEADLINE) {
    console.error("[bridge] agentd did not start in time");
    process.exit(1);
  }
  await sleep(100);
}
const token = readFileSync(TOKEN_FILE, "utf8").trim();

function connect() {
  const ws = new WebSocket(`ws+unix://${SOCKET}:/`, { headers: { authorization: `Bearer ${token}` } });
  let opened = false;
  ws.on("error", (err) => {
    if (!opened && Date.now() < DEADLINE) setTimeout(connect, 200);
    else {
      console.error(`[bridge] ${err.message}`);
      process.exit(1);
    }
  });
  ws.on("open", () => {
    opened = true;
    process.stdout.write(`${JSON.stringify({ ev: "bridge.ready" })}\n`);
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => line && ws.send(line));
    rl.on("close", () => ws.close());
  });
  ws.on("message", (data) => process.stdout.write(`${String(data)}\n`));
  ws.on("close", () => opened && process.exit(0));
}

connect();
