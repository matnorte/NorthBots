import type {
  BrowserAction,
  BrowserResult,
  BrowserSession,
  ExecOptions,
  ExecResult,
  PtySession,
  Sandbox,
  SandboxInfo,
  SandboxSpec,
  SandboxState,
  Tab,
} from "./types.js";
import { READONLY_ROOT } from "./types.js";

interface FakeBox {
  state: SandboxState;
  files: Map<string, string>;
  tabs: Tab[];
  active: string | null;
  egress: string[];
  readonly: Set<string>;
}

export type ExecHook = (id: string, command: string, opts: ExecOptions) => ExecResult | undefined;

const ok = (stdout = "", exitCode = 0, stderr = ""): ExecResult => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
  durationMs: 1,
  truncated: false,
});

const titleOf = (url: string): string => {
  const m = decodeURIComponent(url).match(/<title>([^<]*)<\/title>/i);
  return m?.[1] ?? url;
};

/**
 * In-memory sandbox for tests: a tiny shell (echo, cat, ls, rm, pwd, curl) with a private
 * file map per computer, and a browser that knows tab titles. `pages` maps URLs to page text.
 */
export class FakeSandbox implements Sandbox {
  private boxes = new Map<string, FakeBox>();
  private hooks: ExecHook[] = [];
  readonly pages = new Map<string, { title: string; text: string }>();
  readonly calls: { id: string; op: string; arg?: string }[] = [];

  onExec(hook: ExecHook): void {
    this.hooks.push(hook);
  }

  egressOf(id: string): string[] {
    return this.box(id).egress;
  }

  private box(id: string): FakeBox {
    const b = this.boxes.get(id);
    if (!b) throw new Error(`no sandbox ${id}`);
    return b;
  }

  private running(id: string): FakeBox {
    const b = this.box(id);
    if (b.state !== "running") throw new Error(`sandbox ${id} is ${b.state}`);
    return b;
  }

  async create(spec: SandboxSpec): Promise<SandboxInfo> {
    this.boxes.set(spec.id, { state: "running", files: new Map(), tabs: [], active: null, egress: [], readonly: new Set() });
    this.calls.push({ id: spec.id, op: "create" });
    return { id: spec.id, containerId: `fake-${spec.id}`, network: `net-${spec.id}`, volume: `vol-${spec.id}`, state: "running" };
  }

  async start(id: string) {
    this.box(id).state = "running";
    this.calls.push({ id, op: "start" });
  }

  async hibernate(id: string) {
    this.box(id).state = "hibernated";
    this.calls.push({ id, op: "hibernate" });
  }

  async wake(id: string) {
    this.box(id).state = "running";
    this.calls.push({ id, op: "wake" });
  }

  async snapshot(id: string) {
    this.calls.push({ id, op: "snapshot" });
    return { snapshotId: `${id}-snap` };
  }

  async destroy(id: string) {
    this.boxes.delete(id);
    this.calls.push({ id, op: "destroy" });
  }

  async state(id: string): Promise<SandboxState> {
    return this.boxes.get(id)?.state ?? "missing";
  }

  async exec(id: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const b = this.running(id);
    this.calls.push({ id, op: "exec", arg: command });
    for (const h of this.hooks) {
      const r = h(id, command, opts);
      if (r) return r;
    }
    const outputs: string[] = [];
    for (const part of command.split(/\s*(?:&&|;)\s*/)) {
      // A real wait, so tests can stop a command that is still running.
      const sleep = part.trim().match(/^sleep\s+(\d+(?:\.\d+)?)$/);
      if (sleep) {
        await new Promise((r) => setTimeout(r, Number(sleep[1]) * 1000));
        continue;
      }
      const r = this.run(b, part.trim());
      if (r.exitCode !== 0) return { ...r, stdout: outputs.join("") + r.stdout };
      outputs.push(r.stdout);
    }
    return ok(outputs.join(""));
  }

  /** Home-relative paths are stored as given; ~/x and /home/agent/x mean the same file. */
  private key(path: string): string {
    return path.replace(/^~\//, "").replace(/^\/home\/agent\//, "");
  }

  private run(b: FakeBox, cmd: string, depth = 0): ExecResult {
    let m: RegExpMatchArray | null;
    if ((m = cmd.match(/^echo\s+(.*?)\s*(>>?)\s*(\S+)$/))) {
      const path = this.key(m[3] ?? "");
      if (path.startsWith(READONLY_ROOT) || b.readonly.has(path)) return ok("", 1, `bash: ${path}: Permission denied\n`);
      const text = `${(m[1] ?? "").replace(/^["']|["']$/g, "")}\n`;
      const prev = m[2] === ">>" ? (b.files.get(path) ?? "") : "";
      b.files.set(path, prev + text);
      return ok();
    }
    if ((m = cmd.match(/^echo\s*(.*)$/))) return ok(`${(m[1] ?? "").replace(/^["']|["']$/g, "")}\n`);
    if ((m = cmd.match(/^cat\s+(\S+)$/))) {
      const f = b.files.get(this.key(m[1] ?? ""));
      return f === undefined ? ok("", 1, `cat: ${m[1]}: No such file or directory\n`) : ok(f);
    }
    if ((m = cmd.match(/^(?:bash|sh)\s+(\S+)/)) && depth < 3) {
      // Run a script line by line with this same tiny shell.
      const script = b.files.get(this.key(m[1] ?? ""));
      if (script === undefined) return ok("", 127, `bash: ${m[1]}: No such file or directory\n`);
      let out = "";
      for (const line of script.split(/\r?\n/)) {
        const l = line.trim();
        if (!l || l.startsWith("#") || /^set\b/.test(l)) continue;
        const r = this.run(b, l, depth + 1);
        out += r.stdout;
        if (r.exitCode !== 0) return { ...r, stdout: out };
      }
      return ok(out);
    }
    if (cmd === "ls" || cmd === "ls -1") return ok([...b.files.keys()].sort().map((f) => `${f}\n`).join(""));
    if ((m = cmd.match(/^rm\s+(?:-f\s+)?(\S+)$/))) {
      b.files.delete(m[1] ?? "");
      return ok();
    }
    if (cmd === "pwd") return ok("/home/agent\n");
    if ((m = cmd.match(/^curl\b.*?(https?:\/\/\S+)/))) {
      b.egress.push(new URL(m[1] ?? "").host);
      return ok(this.pages.get(m[1] ?? "")?.text ?? "");
    }
    if (cmd === "true" || cmd === "") return ok();
    return ok("", 127, `bash: ${cmd.split(" ")[0]}: command not found\n`);
  }

  async writeFile(id: string, path: string, data: Buffer): Promise<void> {
    if (path.split("/").includes("..")) throw new Error("bad path");
    this.running(id).files.set(path.replace(/^\/+/, ""), data.toString("utf8"));
  }

  async writeReadonly(id: string, path: string, data: Buffer): Promise<void> {
    if (path.split("/").includes("..")) throw new Error("bad path");
    const full = `${READONLY_ROOT}/${path.replace(/^\/+/, "")}`;
    const b = this.running(id);
    b.files.set(full, data.toString("utf8"));
    b.readonly.add(full);
  }

  async openPty(id: string, opts: { name?: string } = {}): Promise<PtySession> {
    this.running(id);
    const dataCbs = new Set<(d: string) => void>();
    let line = "";
    return {
      name: opts.name ?? "main",
      scrollback: "",
      write: (data) => {
        line += data;
        if (!line.includes("\r")) return;
        const cmd = line.replace(/\r.*$/s, "");
        line = "";
        void this.exec(id, cmd).then((r) => dataCbs.forEach((cb) => cb(r.stdout + r.stderr + "$ ")));
      },
      resize: () => {},
      onData: (cb) => {
        dataCbs.add(cb);
        return () => dataCbs.delete(cb);
      },
      onExit: () => () => {},
      detach: () => {},
    };
  }

  async browserSession(id: string): Promise<BrowserSession> {
    const b = this.running(id);
    const ensure = (): Tab => {
      const t = b.tabs.find((x) => x.pageId === b.active) ?? b.tabs[0];
      if (t) return t;
      const created = { pageId: "p1", url: "about:blank", title: "" };
      b.tabs.push(created);
      b.active = created.pageId;
      return created;
    };
    const visit = (tab: Tab, url: string) => {
      tab.url = url;
      tab.title = this.pages.get(url)?.title ?? titleOf(url);
      if (/^https?:/.test(url)) b.egress.push(new URL(url).host);
    };
    return {
      tabs: async () => {
        ensure();
        return { pages: b.tabs.map((t) => ({ ...t })), activePageId: b.active };
      },
      act: async (a: BrowserAction): Promise<BrowserResult> => {
        this.running(id);
        const tab = a.pageId ? b.tabs.find((t) => t.pageId === a.pageId) : ensure();
        if (!tab) throw new Error(`no such tab: ${a.pageId}`);
        if (a.action === "goto") visit(tab, a.url);
        if (a.action === "read") {
          const text = this.pages.get(tab.url)?.text ?? decodeURIComponent(tab.url).replace(/<[^>]+>/g, " ");
          return { pageId: tab.pageId, url: tab.url, title: tab.title, text, truncated: false };
        }
        if (a.action === "screenshot") return { pageId: tab.pageId, png: "" };
        return { pageId: tab.pageId, url: tab.url, title: tab.title, status: 200 };
      },
      newTab: async (url) => {
        const tab = { pageId: `p${b.tabs.length + 1}`, url: "about:blank", title: "" };
        b.tabs.push(tab);
        b.active = tab.pageId;
        if (url) visit(tab, url);
        return { ...tab };
      },
      activate: async (pageId) => {
        b.active = pageId;
      },
      closeTab: async (pageId) => {
        b.tabs = b.tabs.filter((t) => t.pageId !== pageId);
      },
      cdp: async () => ({}),
      startScreencast: async () => {},
      stopScreencast: async () => {},
      close: () => {},
    };
  }
}
