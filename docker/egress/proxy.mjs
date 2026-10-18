// Egress proxy: the only way out of an agent computer. Agents sit on internal-only Docker
// networks; their HTTP(S)_PROXY points here with per-sandbox credentials. Every connection
// is written to the event log as an `egress` event attributed to the agent.
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import pg from "pg";

const PORT = Number(process.env.EGRESS_PORT ?? 3128);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const log = (...a) => console.error("[egress]", ...a);

const cache = new Map(); // "id:token" -> { sandbox, until }

async function authenticate(header) {
  if (!header?.startsWith("Basic ")) return null;
  const creds = Buffer.from(header.slice(6), "base64").toString();
  const hit = cache.get(creds);
  if (hit && hit.until > Date.now()) return hit.sandbox;
  const i = creds.indexOf(":");
  const [id, token] = [creds.slice(0, i), creds.slice(i + 1)];
  const { rows } = await pool.query(
    "select id, workspace_id, agent_id from sandboxes where id = $1 and egress_token_hash = $2 and state <> 'destroyed'",
    [id, sha256(token)],
  );
  const sandbox = rows[0] ?? null;
  if (sandbox) cache.set(creds, { sandbox, until: Date.now() + 60_000 });
  return sandbox;
}

async function record(sandbox, e) {
  try {
    await pool.query(
      "insert into events (workspace_id, agent_id, type, payload) values ($1, $2, 'egress', $3)",
      [sandbox.workspace_id, sandbox.agent_id, JSON.stringify({ sandboxId: sandbox.id, ...e })],
    );
  } catch (err) {
    log("could not record event:", err.message);
  }
}

function deny(socketOrRes, isSocket) {
  const msg = "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"northbot\"\r\nContent-Length: 0\r\n\r\n";
  if (isSocket) socketOrRes.end(msg);
  else socketOrRes.writeHead(407, { "proxy-authenticate": 'Basic realm="northbot"' }).end();
}

const server = createServer(async (req, res) => {
  // Plain HTTP: the request line carries an absolute URL.
  const sandbox = await authenticate(req.headers["proxy-authorization"]).catch(() => null);
  if (!sandbox) return deny(res, false);
  let target;
  try {
    target = new URL(req.url);
  } catch {
    return res.writeHead(400).end();
  }
  const started = Date.now();
  let up = 0;
  let down = 0;
  const headers = { ...req.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const upstream = httpRequest(
    { host: target.hostname, port: Number(target.port || 80), method: req.method, path: target.pathname + target.search, headers },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.on("data", (c) => (down += c.length));
      ur.pipe(res);
      ur.on("end", () =>
        record(sandbox, { method: req.method, host: target.hostname, port: Number(target.port || 80), status: "ok", httpStatus: ur.statusCode ?? 0, bytesUp: up, bytesDown: down, durationMs: Date.now() - started }),
      );
    },
  );
  req.on("data", (c) => (up += c.length));
  req.pipe(upstream);
  upstream.on("error", (err) => {
    record(sandbox, { method: req.method, host: target.hostname, port: Number(target.port || 80), status: "error", error: err.message, bytesUp: up, bytesDown: down, durationMs: Date.now() - started });
    if (!res.headersSent) res.writeHead(502).end();
  });
});

server.on("connect", async (req, client, head) => {
  // HTTPS and other TLS: a CONNECT tunnel; the proxy sees host and port, never content.
  const sandbox = await authenticate(req.headers["proxy-authorization"]).catch(() => null);
  if (!sandbox) return deny(client, true);
  const [host, portStr] = (req.url ?? "").split(":");
  const port = Number(portStr || 443);
  const started = Date.now();
  let up = head.length;
  let down = 0;
  let error = null;
  const upstream = connect(port, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("data", (c) => (down += c.length));
  client.on("data", (c) => (up += c.length));
  upstream.on("error", (err) => {
    error = err.message;
    client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  client.on("error", () => upstream.destroy());
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    record(sandbox, { method: "CONNECT", host, port, status: error ? "error" : "ok", ...(error ? { error } : {}), bytesUp: up, bytesDown: down, durationMs: Date.now() - started });
  };
  upstream.on("close", finish);
  client.on("close", finish);
});

server.listen(PORT, () => log(`listening on :${PORT}`));
