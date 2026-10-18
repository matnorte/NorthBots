import {vaultBrowserShim} from "./vault-shim.mjs";
// agentd: the only daemon in an agent computer. It owns the shells and the browser so they
// survive server reconnects. It listens on a root-only unix socket (no network port) and
// also requires a token; the server reaches it through `docker exec ... bridge.mjs`.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import pty from "node-pty";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

const SOCKET = "/run/agentd/agentd.sock";
const TOKEN_FILE = "/run/agentd/token";
const AGENT_UID = 1001;
const HOME = "/home/agent";
// On the agent's own disk, but root-owned (0700) so the agent's shell cannot read the cookies.
const PROFILE = "/home/agent/.northbot-browser";
const SCROLLBACK = 64 * 1024;

mkdirSync("/run/agentd", { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString("hex");
writeFileSync(TOKEN_FILE, token, { mode: 0o600 });

const log = (...a) => console.error("[agentd]", ...a);

// Environment for the agent's shells: container env minus anything agentd-specific.
const shellEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AGENTD_"))),
  HOME,
  USER: "agent",
  LOGNAME: "agent",
  SHELL: "/bin/bash",
  TERM: "xterm-256color",
};

// ---------- shells ----------
const ptys = new Map(); // name -> { proc, buf, clients:Set, exited }

function openPty(name, cols, rows) {
  let p = ptys.get(name);
  if (p && !p.exited) {
    p.proc.resize(cols, rows);
    return p;
  }
  const proc = pty.spawn("/bin/bash", ["-l"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: HOME,
    env: shellEnv,
    uid: AGENT_UID,
    gid: AGENT_UID,
  });
  p = { proc, buf: "", clients: new Set(), exited: false };
  proc.onData((data) => {
    p.buf = (p.buf + data).slice(-SCROLLBACK);
    for (const c of p.clients) send(c, { ev: "pty.data", name, data });
  });
  proc.onExit(({ exitCode }) => {
    p.exited = true;
    for (const c of p.clients) send(c, { ev: "pty.exit", name, code: exitCode });
  });
  ptys.set(name, p);
  return p;
}

// ---------- browser ----------
let context = null;
let launching = null;
const pages = new Map(); // pageId -> page
const cdpSessions = new Map(); // pageId -> CDPSession
let vaultOwner=null;
const vaultPending=new Map();
let activePageId = null;
let nextPageId = 1;

function proxyFromEnv() {
  const raw = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!raw) return undefined;
  const u = new URL(raw);
  return {
    server: `${u.protocol}//${u.host}`,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    bypass: "localhost,127.0.0.1",
  };
}

function register(page) {
  for (const [id, p] of pages) if (p === page) return id;
  const id = `p${nextPageId++}`;
  pages.set(id, page);
  activePageId = id;
  page.on("close", () => {
    pages.delete(id);
    cdpSessions.delete(id);
    if (activePageId === id) activePageId = [...pages.keys()].at(-1) ?? null;
  });
  return id;
}

async function ensureBrowser() {
  if (context) return context;
  launching ??= (async () => {
    mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
    // A crashed browser can leave a lock behind; the profile is ours alone.
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(`${PROFILE}/${f}`, { force: true });
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      proxy: proxyFromEnv(),
      viewport: { width: 1280, height: 800 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    ctx.on("page", register);
    ctx.on("close", () => {
      context = null;
      launching = null;
      pages.clear();
      cdpSessions.clear();
    });
    ctx.pages().forEach(register);
    if (pages.size === 0) register(await ctx.newPage());
    context = ctx;
    return ctx;
  })();
  try {
    return await launching;
  } catch (err) {
    launching = null;
    throw err;
  }
}

async function page(pageId) {
  await ensureBrowser();
  const id = pageId ?? activePageId;
  const p = id ? pages.get(id) : undefined;
  if (!p) throw new Error(`no such tab: ${pageId}`);
  return { id, p };
}

async function cdp(pageId) {
  const { id, p } = await page(pageId);
  let s = cdpSessions.get(id);
  if (!s) {
    s = await context.newCDPSession(p);
    cdpSessions.set(id, s);
  }
  return { id, s };
}

async function tabs() {
  await ensureBrowser();
  const list = [];
  for (const [pageId, p] of pages) list.push({ pageId, url: p.url(), title: await p.title().catch(() => "") });
  return { pages: list, activePageId };
}

const TEXT_LIMIT = 20_000;

async function act(msg) {
  const { id, p } = await page(msg.pageId);
  const timeout = msg.timeoutMs ?? 15_000;
  switch (msg.action) {
    case "goto": {
      const res = await p.goto(msg.url, { waitUntil: "load", timeout });
      return { pageId: id, url: p.url(), title: await p.title(), status: res?.status() ?? null };
    }
    case "click":
      await p.click(msg.selector, { timeout });
      return { pageId: id, url: p.url() };
    case "fill":
      await p.fill(msg.selector, msg.text ?? "", { timeout });
      return { pageId: id };
    case "press":
      await p.keyboard.press(msg.key);
      return { pageId: id };
    case "read": {
      const text = msg.selector
        ? await p.locator(msg.selector).first().innerText({ timeout })
        : // eslint-disable-next-line no-undef -- this callback runs in the page, not in Node
          await p.evaluate(() => document.body?.innerText ?? "");
      return { pageId: id, url: p.url(), title: await p.title(), text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT };
    }
    case "screenshot":
      return { pageId: id, png: (await p.screenshot({ type: "png" })).toString("base64") };
    case "back":
      await p.goBack({ timeout });
      return { pageId: id, url: p.url() };
    case "forward":
      await p.goForward({ timeout });
      return { pageId: id, url: p.url() };
    case "reload":
      await p.reload({ timeout });
      return { pageId: id, url: p.url() };
    case "scroll":
      await p.mouse.wheel(0, msg.dy ?? 600);
      return { pageId: id };
    default:
      throw new Error(`unknown browser action: ${msg.action}`);
  }
}

// ---------- protocol ----------
function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

async function handle(ws, state, msg) {
  switch (msg.op) {
    case "ping":
      return { pong: true };
    case "pty.open": {
      const name = msg.name ?? "main";
      const p = openPty(name, msg.cols ?? 120, msg.rows ?? 32);
      p.clients.add(ws);
      state.ptys.add(name);
      return { name, scrollback: p.buf };
    }
    case "pty.input":
      ptys.get(msg.name)?.proc.write(msg.data);
      return null;
    case "pty.resize":
      ptys.get(msg.name)?.proc.resize(msg.cols, msg.rows);
      return null;
    case "pty.detach":
      ptys.get(msg.name)?.clients.delete(ws);
      return {};
    case "pty.kill": {
      const p = ptys.get(msg.name);
      p?.proc.kill();
      ptys.delete(msg.name);
      return {};
    }
    case "browser.tabs":
      return tabs();
    case "browser.newTab": {
      const ctx = await ensureBrowser();
      const p = await ctx.newPage();
      const id = register(p);
      if (msg.url) await p.goto(msg.url, { waitUntil: "load", timeout: msg.timeoutMs ?? 15_000 });
      return { pageId: id, url: p.url(), title: await p.title() };
    }
    case "browser.activate":
      await page(msg.pageId);
      activePageId = msg.pageId;
      return tabs();
    case "browser.closeTab": {
      const { p } = await page(msg.pageId);
      await p.close();
      return tabs();
    }
    case "browser.act":
      return act(msg);
    case "cdp": {
      const { s } = await cdp(msg.pageId);
      return s.send(msg.method, msg.params ?? {});
    }
    case "webauthn.enable": {
      const ctx=await ensureBrowser();
      if(!ctx.__vaultInstalled){
        await ctx.exposeBinding("__northbotVaultSign",async(source,request)=>{
          if(!vaultOwner)throw new Error("Vault is disconnected");
          const origin=new URL(source.frame.url()).origin;
          if(source.frame!==source.page.mainFrame())throw new Error("Cross-frame signing is blocked");
          const requestId=String(Date.now())+"-"+Math.random();
          return new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{vaultPending.delete(requestId);reject(new Error("Signing timed out"));},300000);
            vaultPending.set(requestId,{resolve,reject,timer,owner:vaultOwner});
            send(vaultOwner,{ev:"webauthn.request",requestId,origin,rpId:String(request.rpId),challenge:String(request.challenge),allowCredentials:request.allowCredentials});
          });
        });
        await ctx.addInitScript(vaultBrowserShim);
        for(const p of ctx.pages())await p.evaluate(vaultBrowserShim);
        ctx.__vaultInstalled=true;
      }
      vaultOwner=ws;return {};
    }
    case "webauthn.answer": {
      const pending=vaultPending.get(msg.requestId);
      if(!pending||pending.owner!==ws)throw new Error("No pending vault request");
      clearTimeout(pending.timer);vaultPending.delete(msg.requestId);
      if(msg.error)pending.reject(new Error("Vault signing denied"));else pending.resolve(msg.response);
      return {};
    }
    case "webauthn.disable": {if(vaultOwner===ws)vaultOwner=null;return {};}
    case "screencast.start": {
      const { id, s } = await cdp(msg.pageId);
      if (!state.screencast) {
        const onFrame = (f) => {
          send(ws, { ev: "screencast.frame", pageId: id, data: f.data, metadata: f.metadata });
          s.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
        };
        s.on("Page.screencastFrame", onFrame);
        state.screencast = { s, onFrame };
      }
      await s.send("Page.startScreencast", { format: "jpeg", quality: msg.quality ?? 60, maxWidth: msg.maxWidth ?? 1280, everyNthFrame: 1 });
      return { pageId: id };
    }
    case "screencast.stop":
      await stopScreencast(state);
      return {};
    default:
      throw new Error(`unknown op: ${msg.op}`);
  }
}

async function stopScreencast(state) {
  if (!state.screencast) return;
  const { s, onFrame } = state.screencast;
  state.screencast = null;
  s.off("Page.screencastFrame", onFrame);
  await s.send("Page.stopScreencast").catch(() => {});
}

if (existsSync(SOCKET)) rmSync(SOCKET);
const http = createServer((_req, res) => res.writeHead(426).end());
const wss = new WebSocketServer({
  server: http,
  verifyClient: (info) => info.req.headers.authorization === `Bearer ${token}`,
});

wss.on("connection", (ws) => {
  const state = { ptys: new Set(), screencast: null };
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    try {
      const result = await handle(ws, state, msg);
      if (msg.id !== undefined && result !== null) send(ws, { id: msg.id, ok: true, result });
    } catch (err) {
      if (msg.id !== undefined) send(ws, { id: msg.id, ok: false, error: String(err?.message ?? err) });
    }
  });
  ws.on("close", () => {
    for (const name of state.ptys) ptys.get(name)?.clients.delete(ws);
    void stopScreencast(state);
  });
});

http.listen(SOCKET, () => {
  chmodSync(SOCKET, 0o600);
  log(`listening on ${SOCKET}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    await context?.close().catch(() => {});
    process.exit(0);
  });
}
