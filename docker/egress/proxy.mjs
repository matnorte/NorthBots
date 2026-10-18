// Egress proxy: the only way out of an agent computer. Agents sit on internal-only Docker
// networks; their HTTP(S)_PROXY points here with per-sandbox credentials. Every connection
// is written to the event log as an `egress` event attributed to the agent.
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { BlockList, connect, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import pg from "pg";

const PORT = Number(process.env.EGRESS_PORT ?? 3128);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const log = (...a) => console.error("[egress]", ...a);

// Agents may only reach the public internet: never this host, the compose network (the
// database, the server), other agent networks, cloud metadata, or anything else private.
const PRIVATE = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]])
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]]) PRIVATE.addSubnet(net, bits, "ipv6");
const ALLOW_PRIVATE = process.env.EGRESS_ALLOW_PRIVATE === "true";

/** The address to connect to if the host is public; null if it is private; throws if unknown. */
async function publicAddress(host) {
  const h = host.replace(/^\[|\]$/g, "");
  const found = isIP(h) ? [{ address: h, family: isIP(h) }] : await lookup(h, { all: true });
  if (!found.length) throw new Error("no address");
  if (!ALLOW_PRIVATE && found.some((a) => PRIVATE.check(a.address, a.family === 6 ? "ipv6" : "ipv4"))) return null;
  // Connect to the address that was checked, so a second DNS answer cannot point elsewhere.
  return found[0].address;
}

async function blockPrivate(sandbox, method, host, port) {
  await record(sandbox, { method, host, port, status: "blocked", error: "private address", bytesUp: 0, bytesDown: 0, durationMs: 0 });
}

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
  const msg =
    'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="northbot"\r\nContent-Length: 0\r\n\r\n';
  if (isSocket) socketOrRes.end(msg);
  else socketOrRes.writeHead(407, { "proxy-authenticate": 'Basic realm="northbot"' }).end();
}

async function permitted(sandbox, host) {
  const { rows } = await pool.query(
    "select w.kill_switch_at,l.label,l.destinations from workspaces w left join data_labels l on l.workspace_id=w.id and l.resource_type='agent' and l.resource_id=$2 where w.id=$1",
    [sandbox.workspace_id, sandbox.agent_id],
  );
  const rule = rows[0];
  if (
    rule &&
    !rule.kill_switch_at &&
    (!rule.label || rule.label === "public" || rule.destinations.includes(host))
  )
    return true;
  await record(sandbox, {
    method: "POLICY",
    host,
    port: 0,
    status: "blocked",
    bytesUp: 0,
    bytesDown: 0,
    durationMs: 0,
  });
  await pool.query(
    "insert into events(workspace_id,agent_id,type,payload) select $1,$2,'security.alert',$3 where not exists(select 1 from events where workspace_id=$1 and agent_id=$2 and type='security.alert' and payload->>'code'='egress_blocked' and ts>now()-interval '5 minutes')",
    [
      sandbox.workspace_id,
      sandbox.agent_id,
      JSON.stringify({
        code: "egress_blocked",
        resourceId: sandbox.agent_id,
        summary: "The egress policy blocked an unapproved destination.",
      }),
    ],
  );
  return false;
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
  if (!(await permitted(sandbox, target.hostname).catch(() => false)))
    return res.writeHead(403).end();
  const address = await publicAddress(target.hostname).catch(() => undefined);
  if (address === undefined) return res.writeHead(502).end();
  if (address === null) {
    await blockPrivate(sandbox, req.method, target.hostname, Number(target.port || 80));
    return res.writeHead(403).end();
  }
  const started = Date.now();
  let up = 0;
  let down = 0;
  const headers = { ...req.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const upstream = httpRequest(
    {
      host: address,
      port: Number(target.port || 80),
      method: req.method,
      path: target.pathname + target.search,
      headers,
    },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.on("data", (c) => (down += c.length));
      ur.pipe(res);
      ur.on("end", () =>
        record(sandbox, {
          method: req.method,
          host: target.hostname,
          port: Number(target.port || 80),
          status: "ok",
          httpStatus: ur.statusCode ?? 0,
          bytesUp: up,
          bytesDown: down,
          durationMs: Date.now() - started,
        }),
      );
    },
  );
  req.on("data", (c) => (up += c.length));
  req.pipe(upstream);
  upstream.on("error", (err) => {
    record(sandbox, {
      method: req.method,
      host: target.hostname,
      port: Number(target.port || 80),
      status: "error",
      error: err.message,
      bytesUp: up,
      bytesDown: down,
      durationMs: Date.now() - started,
    });
    if (!res.headersSent) res.writeHead(502).end();
  });
});

server.on("connect", async (req, client, head) => {
  // HTTPS and other TLS: a CONNECT tunnel; the proxy sees host and port, never content.
  const sandbox = await authenticate(req.headers["proxy-authorization"]).catch(() => null);
  if (!sandbox) return deny(client, true);
  const parsed = (req.url ?? "").match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (!parsed) return client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
  const host = parsed[1];
  const port = Number(parsed[2]);
  if (!(await permitted(sandbox, host).catch(() => false)))
    return client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  const address = await publicAddress(host).catch(() => undefined);
  if (address === undefined) return client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  if (address === null) {
    await blockPrivate(sandbox, "CONNECT", host, port);
    return client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  }
  const started = Date.now();
  let up = head.length;
  let down = 0;
  let error = null;
  const upstream = connect(port, address, () => {
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
    record(sandbox, {
      method: "CONNECT",
      host,
      port,
      status: error ? "error" : "ok",
      ...(error ? { error } : {}),
      bytesUp: up,
      bytesDown: down,
      durationMs: Date.now() - started,
    });
  };
  upstream.on("close", finish);
  client.on("close", finish);
});

server.listen(PORT, () => log(`listening on :${PORT}`));
