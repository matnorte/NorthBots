export type SandboxState = "running" | "hibernated" | "stopped" | "destroyed" | "missing";

export interface SandboxSpec {
  /** Stable id, also used in Docker object names (`nb-agent-<id>`). */
  id: string;
  /** Proxy URL with this sandbox's credentials, e.g. http://<id>:<token>@egress:3128. */
  egressProxyUrl: string;
  labels?: Record<string, string>;
  memoryMb?: number;
  cpus?: number;
  /** Restore disk and image from a snapshot made by `snapshot()`. */
  fromSnapshot?: string;
}

export interface SandboxInfo {
  id: string;
  containerId: string;
  network: string;
  volume: string;
  state: SandboxState;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

export interface PtySession {
  readonly name: string;
  /** Output the shell produced before this attach (so a take-over sees the history). */
  readonly scrollback: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (code: number) => void): () => void;
  detach(): void;
}

export interface Tab {
  pageId: string;
  url: string;
  title: string;
}

export type BrowserAction =
  | { action: "goto"; url: string; pageId?: string }
  | { action: "click"; selector: string; pageId?: string }
  | { action: "fill"; selector: string; text: string; pageId?: string }
  | { action: "press"; key: string; pageId?: string }
  | { action: "read"; selector?: string; pageId?: string }
  | { action: "screenshot"; pageId?: string }
  | { action: "back" | "forward" | "reload"; pageId?: string }
  | { action: "scroll"; dy?: number; pageId?: string };

export interface BrowserResult {
  pageId: string;
  url?: string;
  title?: string;
  status?: number | null;
  text?: string;
  truncated?: boolean;
  /** base64 PNG for screenshots. */
  png?: string;
}

export interface ScreencastFrame {
  pageId: string;
  /** base64 JPEG. */
  data: string;
  metadata: Record<string, unknown>;
}

export interface BrowserSession {
  tabs(): Promise<{ pages: Tab[]; activePageId: string | null }>;
  act(a: BrowserAction): Promise<BrowserResult>;
  newTab(url?: string): Promise<Tab>;
  activate(pageId: string): Promise<void>;
  closeTab(pageId: string): Promise<void>;
  /** Raw Chrome DevTools Protocol command on a tab (the active one by default). */
  cdp(method: string, params?: Record<string, unknown>, pageId?: string): Promise<unknown>;
  startScreencast(onFrame: (f: ScreencastFrame) => void, opts?: { quality?: number; maxWidth?: number }): Promise<void>;
  stopScreencast(): Promise<void>;
  close(): void;
}

/** An agent computer. Implementations: Docker (real) and in-memory (tests). Firecracker later. */
export interface Sandbox {
  create(spec: SandboxSpec): Promise<SandboxInfo>;
  start(id: string): Promise<void>;
  /** Freeze the computer, keeping disk, processes, shells and open tabs. */
  hibernate(id: string): Promise<void>;
  wake(id: string): Promise<void>;
  snapshot(id: string): Promise<{ snapshotId: string }>;
  destroy(id: string): Promise<void>;
  state(id: string): Promise<SandboxState>;
  exec(id: string, command: string, opts?: ExecOptions): Promise<ExecResult>;
  openPty(id: string, opts?: { name?: string; cols?: number; rows?: number }): Promise<PtySession>;
  browserSession(id: string): Promise<BrowserSession>;
}
