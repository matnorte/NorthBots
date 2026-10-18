import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { AgentdClient } from "./agentd-client.js";
import { agentdBrowser, openAgentdPty } from "./sessions.js";
import { tarOneFile } from "./tar.js";
import type {
  BrowserSession,
  ExecOptions,
  ExecResult,
  PtySession,
  Sandbox,
  SandboxInfo,
  SandboxSpec,
  SandboxState,
} from "./types.js";
import { READONLY_ROOT } from "./types.js";

export interface DockerSandboxOptions {
  docker?: Docker;
  image?: string;
  /** Name of the egress proxy container; it joins every sandbox network as `egress`. */
  egressContainer: string;
  memoryMb?: number;
  cpus?: number;
}

const OUTPUT_LIMIT = 1024 * 1024;
const names = (id: string) => ({
  container: `nb-agent-${id}`,
  network: `nb-net-${id}`,
  volume: `nb-home-${id}`,
});
const LABEL = "northbot.sandbox";

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === 404;
}

/**
 * Agent computers as Docker containers: one internal-only network, one home volume and one
 * container per agent. No published ports; the server talks to agentd through `docker exec`.
 */
export class DockerSandbox implements Sandbox {
  private readonly docker: Docker;
  private readonly image: string;
  private clients = new Map<string, Promise<AgentdClient>>();

  constructor(private readonly opts: DockerSandboxOptions) {
    this.docker = opts.docker ?? new Docker();
    this.image = opts.image ?? "northbot/agent:dev";
  }

  private container(id: string) {
    return this.docker.getContainer(names(id).container);
  }

  async create(spec: SandboxSpec): Promise<SandboxInfo> {
    if (spec.diskKey && spec.fromSnapshot)
      throw new Error(
        "Encrypted disks restore under their original agent identity through deployment volume restore.",
      );
    const n = names(spec.id);
    const labels = { [LABEL]: spec.id, ...spec.labels };
    await this.docker.createNetwork({
      Name: n.network,
      Driver: "bridge",
      Internal: true,
      Labels: labels,
    });
    await this.docker
      .getNetwork(n.network)
      .connect({ Container: this.opts.egressContainer, EndpointConfig: { Aliases: ["egress"] } });
    await this.docker.createVolume({ Name: n.volume, Labels: labels });
    let image = this.image;
    if (spec.fromSnapshot) {
      image = `northbot/snapshot:${spec.fromSnapshot}`;
      await this.copyVolume(`nb-snap-${spec.fromSnapshot}`, n.volume);
    }
    const proxy = spec.egressProxyUrl;
    const container = await this.docker.createContainer({
      name: n.container,
      Image: image,
      Hostname: "computer",
      Labels: labels,
      Env: [
        ...(spec.diskKey ? ["NORTHBOT_ENCRYPTED_HOME=1"] : []),
        `HTTP_PROXY=${proxy}`,
        `HTTPS_PROXY=${proxy}`,
        `http_proxy=${proxy}`,
        `https_proxy=${proxy}`,
        "NO_PROXY=localhost,127.0.0.1",
        "no_proxy=localhost,127.0.0.1",
      ],
      HostConfig: {
        Binds: [`${n.volume}:${spec.diskKey ? "/encrypted" : "/home/agent"}`],
        ...(spec.diskKey
          ? {
              Devices: [
                { PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" },
              ],
              Tmpfs: { "/run/agentd": "rw,nosuid,nodev,noexec,mode=0700" },
            }
          : {}),
        NetworkMode: n.network,
        Memory: (spec.memoryMb ?? this.opts.memoryMb ?? 2048) * 1024 * 1024,
        NanoCpus: Math.round((spec.cpus ?? this.opts.cpus ?? 1) * 1e9),
        PidsLimit: 1024,
        ShmSize: 256 * 1024 * 1024,
        CapDrop: ["ALL"],
        // agentd (root) needs these to run shells as the unprivileged agent user.
        CapAdd: [
          "CHOWN",
          "SETUID",
          "SETGID",
          "DAC_OVERRIDE",
          "FOWNER",
          "KILL",
          ...(spec.diskKey ? ["SYS_ADMIN"] : []),
        ],
        SecurityOpt: ["no-new-privileges", ...(spec.diskKey ? ["apparmor=unconfined"] : [])],
      },
    });
    try {
      await container.start();
      if (spec.diskKey) await this.unlock(spec.id, spec.diskKey);
    } catch (e) {
      await this.destroy(spec.id);
      throw e;
    }
    return {
      id: spec.id,
      containerId: container.id,
      network: n.network,
      volume: n.volume,
      state: "running",
      encrypted: Boolean(spec.diskKey),
    };
  }

  private async unlock(id: string, key: string) {
    const result = await this.exec(
      id,
      'for i in $(seq 1 100); do [ -p /run/agentd/disk-key ] && break; sleep 0.1; done; printf "%s" "$NB_DISK_KEY" > /run/agentd/disk-key',
      { asRoot: true, env: { NB_DISK_KEY: key }, timeoutMs: 15000 },
    );
    if (result.exitCode !== 0) throw new Error("Encrypted disk could not unlock");
    const ready = await this.exec(
      id,
      "for i in $(seq 1 150); do [ -S /run/agentd/agentd.sock ] && exit 0; sleep 0.1; done; exit 1",
      { asRoot: true, timeoutMs: 20000 },
    );
    if (ready.exitCode !== 0)
      throw new Error("Encrypted disk could not mount. Verify FUSE and the host security profile.");
  }
  async start(id: string, diskKey?: string): Promise<void> {
    const state = await this.state(id);
    if (state === "stopped") {
      await this.container(id).start();
      if (diskKey) await this.unlock(id, diskKey);
    }
    if (state === "hibernated") await this.container(id).unpause();
  }

  async hibernate(id: string): Promise<void> {
    if ((await this.state(id)) === "running") await this.container(id).pause();
  }

  async wake(id: string, diskKey?: string): Promise<void> {
    await this.start(id, diskKey);
  }

  async state(id: string): Promise<SandboxState> {
    try {
      const info = await this.container(id).inspect();
      if (info.State.Paused) return "hibernated";
      return info.State.Running ? "running" : "stopped";
    } catch (err) {
      if (isNotFound(err)) return "missing";
      throw err;
    }
  }

  /** Copies a volume with a throwaway container that has no network. */
  private async copyVolume(from: string, to: string): Promise<void> {
    const helper = await this.docker.createContainer({
      Image: this.image,
      User: "root",
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: ["cp -a /from/. /to/"],
      HostConfig: {
        Binds: [`${from}:/from:ro`, `${to}:/to`],
        NetworkMode: "none",
        AutoRemove: false,
      },
    });
    try {
      await helper.start();
      const { StatusCode } = (await helper.wait()) as { StatusCode: number };
      if (StatusCode !== 0) throw new Error(`volume copy failed with status ${StatusCode}`);
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  }

  async snapshot(id: string): Promise<{ snapshotId: string }> {
    const info = await this.container(id).inspect();
    if (info.Config.Env?.includes("NORTHBOT_ENCRYPTED_HOME=1"))
      throw new Error("Use an encrypted disk export or deployment backup for this computer.");
    const snapshotId = `${id}-${Date.now()}`;
    const wasRunning = (await this.state(id)) === "running";
    if (wasRunning) await this.container(id).pause();
    try {
      await this.container(id).commit({ repo: "northbot/snapshot", tag: snapshotId, pause: false });
      await this.docker.createVolume({ Name: `nb-snap-${snapshotId}`, Labels: { [LABEL]: id } });
      await this.copyVolume(names(id).volume, `nb-snap-${snapshotId}`);
    } finally {
      if (wasRunning) await this.container(id).unpause();
    }
    return { snapshotId };
  }

  async destroy(id: string): Promise<void> {
    const n = names(id);
    const client = this.clients.get(id);
    this.clients.delete(id);
    void client?.then((c) => c.close()).catch(() => {});
    await this.container(id)
      .remove({ force: true })
      .catch((e: unknown) => {
        if (!isNotFound(e)) throw e;
      });
    const net = this.docker.getNetwork(n.network);
    await net.disconnect({ Container: this.opts.egressContainer, Force: true }).catch(() => {});
    await net.remove().catch((e: unknown) => {
      if (!isNotFound(e)) throw e;
    });
    await this.docker
      .getVolume(n.volume)
      .remove()
      .catch((e: unknown) => {
        if (!isNotFound(e)) throw e;
      });
  }

  async exec(id: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const seconds = Math.max(1, Math.ceil((opts.timeoutMs ?? 120_000) / 1000));
    const started = Date.now();
    const exec = await this.container(id).exec({
      // coreutils `timeout` kills a stuck command; exit code 124 means it timed out.
      Cmd: opts.raw
        ? ["bash", "-lc", command]
        : ["timeout", "-k", "2", String(seconds), "bash", "-lc", command],
      AttachStdout: true,
      AttachStderr: true,
      User: opts.asRoot ? "root" : "agent",
      WorkingDir: opts.cwd ?? "/home/agent",
      Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
    });
    const stream = await exec.start({});
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const sink = (append: (s: string) => void) => {
      const pt = new PassThrough();
      pt.on("data", (c: Buffer) => append(c.toString("utf8")));
      return pt;
    };
    const out = sink((s) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += s;
      else truncated = true;
    });
    const err = sink((s) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += s;
      else truncated = true;
    });
    this.docker.modem.demuxStream(stream, out, err);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", reject);
    });
    const { ExitCode } = await exec.inspect();
    const exitCode = ExitCode ?? -1;
    return {
      exitCode,
      stdout,
      stderr,
      timedOut: exitCode === 124,
      durationMs: Date.now() - started,
      truncated,
    };
  }

  async writeFile(id: string, path: string, data: Buffer): Promise<void> {
    const clean = path.replace(/^\/+/, "");
    if (!clean || clean.split("/").includes("..")) throw new Error("bad path");
    const dir = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
    if (dir) {
      const r = await this.exec(id, 'mkdir -p "$NB_DIR"', {
        env: { NB_DIR: dir },
        timeoutMs: 10_000,
      });
      if (r.exitCode !== 0) throw new Error(`could not create ${dir}`);
    }
    const name = clean.slice(clean.lastIndexOf("/") + 1);
    await this.container(id).putArchive(tarOneFile(name, data), {
      path: dir ? `/home/agent/${dir}` : "/home/agent",
    });
  }

  async writeReadonly(id: string, path: string, data: Buffer): Promise<void> {
    const clean = path.replace(/^\/+/, "");
    if (!clean || clean.split("/").includes("..")) throw new Error("bad path");
    const full = `${READONLY_ROOT}/${clean}`;
    const dir = full.slice(0, full.lastIndexOf("/"));
    const r = await this.exec(id, 'mkdir -p "$NB_DIR" && chmod 755 "$NB_DIR"', {
      env: { NB_DIR: dir },
      asRoot: true,
      timeoutMs: 10_000,
    });
    if (r.exitCode !== 0) throw new Error(`could not create ${dir}`);
    await this.container(id).putArchive(
      tarOneFile(full.slice(full.lastIndexOf("/") + 1), data, { mode: 0o644, uid: 0 }),
      { path: dir },
    );
  }

  /** One agentd connection per sandbox, re-opened if it drops. */
  private agentd(id: string): Promise<AgentdClient> {
    const existing = this.clients.get(id);
    if (existing) return existing;
    const p = (async () => {
      const exec = await this.container(id).exec({
        Cmd: ["node", "/opt/agentd/bridge.mjs"],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        User: "root",
      });
      const stream = await exec.start({ hijack: true, stdin: true });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      this.docker.modem.demuxStream(stream, stdout, stderr);
      stream.on("end", () => stdout.end());
      const client = new AgentdClient(stdout, stream, () => {
        if (this.clients.get(id) === p) this.clients.delete(id);
      });
      await client.ready;
      return client;
    })();
    this.clients.set(id, p);
    p.catch(() => this.clients.delete(id));
    return p;
  }

  async openPty(
    id: string,
    opts: { name?: string; cols?: number; rows?: number } = {},
  ): Promise<PtySession> {
    return openAgentdPty(await this.agentd(id), opts);
  }

  async browserSession(id: string): Promise<BrowserSession> {
    return agentdBrowser(await this.agentd(id));
  }

  /** Every sandbox Docker object this host knows about (for cleanup and health checks). */
  async list(): Promise<string[]> {
    const cs = await this.docker.listContainers({ all: true, filters: { label: [LABEL] } });
    return cs.map((c) => c.Labels[LABEL] ?? "").filter(Boolean);
  }
}
