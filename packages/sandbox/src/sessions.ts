import type { AgentdClient, AgentdEvent } from "./agentd-client.js";
import type {
  BrowserAction,
  BrowserResult,
  BrowserSession,
  PtySession,
  ScreencastFrame,
  Tab,
} from "./types.js";

export async function openAgentdPty(
  client: AgentdClient,
  opts: { name?: string; cols?: number; rows?: number },
): Promise<PtySession> {
  const name = opts.name ?? "main";
  const res = await client.call<{ name: string; scrollback: string }>("pty.open", {
    name,
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
  });
  const dataCbs = new Set<(d: string) => void>();
  const exitCbs = new Set<(c: number) => void>();
  const onEvent = (e: AgentdEvent) => {
    if (e.name !== name) return;
    if (e.ev === "pty.data") for (const cb of dataCbs) cb(String(e.data));
    if (e.ev === "pty.exit") for (const cb of exitCbs) cb(Number(e.code));
  };
  client.on("event", onEvent);
  return {
    name,
    scrollback: res.scrollback,
    write: (data) => client.notify("pty.input", { name, data }),
    resize: (cols, rows) => client.notify("pty.resize", { name, cols, rows }),
    onData(cb) {
      dataCbs.add(cb);
      return () => dataCbs.delete(cb);
    },
    onExit(cb) {
      exitCbs.add(cb);
      return () => exitCbs.delete(cb);
    },
    detach() {
      client.off("event", onEvent);
      void client.call("pty.detach", { name }).catch(() => {});
    },
  };
}

export function agentdBrowser(client: AgentdClient): BrowserSession {
  let frameHandler: ((e: AgentdEvent) => void) | null = null;
  const BROWSER_TIMEOUT = 90_000;
  return {
    tabs: () => client.call("browser.tabs", {}, BROWSER_TIMEOUT),
    async enableVault(handler) {
      const listener = (e: AgentdEvent) => {
        if (e.ev !== "webauthn.request") return;
        void handler({
          origin: String(e.origin),
          rpId: String(e.rpId),
          challenge: String(e.challenge),
          allowCredentials: Array.isArray(e.allowCredentials) ? e.allowCredentials.map(String) : [],
        })
          .then((response) => client.call("webauthn.answer", { requestId: e.requestId, response }))
          .catch(() =>
            client.call("webauthn.answer", {
              requestId: e.requestId,
              error: "Vault signing denied",
            }),
          )
          .catch(() => {});
      };
      client.on("event", listener);
      try {
        await client.call("webauthn.enable");
      } catch (e) {
        client.off("event", listener);
        throw e;
      }
      return () => {
        client.off("event", listener);
        void client.call("webauthn.disable").catch(() => {});
      };
    },
    act: (a: BrowserAction) => client.call<BrowserResult>("browser.act", { ...a }, BROWSER_TIMEOUT),
    newTab: (url?: string) =>
      client.call<Tab>("browser.newTab", url ? { url } : {}, BROWSER_TIMEOUT),
    activate: async (pageId) => void (await client.call("browser.activate", { pageId })),
    closeTab: async (pageId) => void (await client.call("browser.closeTab", { pageId })),
    cdp: (method, params = {}, pageId) =>
      client.call("cdp", { method, params, ...(pageId ? { pageId } : {}) }),
    async startScreencast(onFrame: (f: ScreencastFrame) => void, opts = {}) {
      if (frameHandler) client.off("event", frameHandler);
      frameHandler = (e) => {
        if (e.ev === "screencast.frame") {
          onFrame({
            pageId: String(e.pageId),
            data: String(e.data),
            metadata: (e.metadata ?? {}) as Record<string, unknown>,
          });
        }
      };
      client.on("event", frameHandler);
      await client.call("screencast.start", opts, BROWSER_TIMEOUT);
    },
    async stopScreencast() {
      if (frameHandler) client.off("event", frameHandler);
      frameHandler = null;
      await client.call("screencast.stop").catch(() => {});
    },
    close() {
      void this.stopScreencast();
    },
  };
}
