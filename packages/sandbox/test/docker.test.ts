import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox } from "../src/index.js";

// Real agent computers. Needs Docker, the northbot/agent:dev image and the compose egress
// container (scripts/acceptance/lib.sh builds and starts both).
const docker = new Docker();
const sb = new DockerSandbox({ docker, egressContainer: process.env.EGRESS_CONTAINER ?? "northbot-egress-1" });
const run = Date.now().toString(36);
const A = `t${run}a`;
const B = `t${run}b`;
const spec = (id: string) => ({ id, egressProxyUrl: "http://nobody:nothing@egress:3128", labels: { "northbot.test": "1" } });

describe("DockerSandbox", () => {
  beforeAll(async () => {
    // Clean up computers left behind by an interrupted earlier run.
    const old = await docker.listContainers({ all: true, filters: { label: ["northbot.test=1"] } });
    for (const c of old) await sb.destroy(c.Labels["northbot.sandbox"] ?? "").catch(() => {});
    await sb.create(spec(A));
    await sb.create(spec(B));
  });
  afterAll(async () => {
    await sb.destroy(A).catch(() => {});
    await sb.destroy(B).catch(() => {});
  });

  it("serves the browser immediately after a computer is created (agentd may still be booting)", async () => {
    const D = `t${run}d`;
    try {
      await sb.create(spec(D));
      const tabs = await (await sb.browserSession(D)).tabs();
      expect(tabs.pages.length).toBeGreaterThan(0);
    } finally {
      await sb.destroy(D).catch(() => {});
    }
  });

  it("runs commands as the unprivileged agent user in its home", async () => {
    const r = await sb.exec(A, "whoami && pwd");
    expect(r).toMatchObject({ exitCode: 0, stdout: "agent\n/home/agent\n" });
  });

  it("keeps each computer's disk private", async () => {
    expect((await sb.exec(A, "echo hi > a.txt && cat a.txt")).stdout).toBe("hi\n");
    const other = await sb.exec(B, "cat a.txt");
    expect(other.exitCode).not.toBe(0);
    expect(other.stderr).toMatch(/No such file/);
  });

  it("cannot reach the internet or other computers directly", async () => {
    const r = await sb.exec(A, `curl -s --noproxy '*' -m 5 -o /dev/null -w '%{http_code}' https://example.com`, { timeoutMs: 15_000 });
    expect(r.exitCode).not.toBe(0);
    const peer = await sb.exec(A, `getent hosts nb-agent-${B} || echo unreachable`);
    expect(peer.stdout).toContain("unreachable");
  });

  it("writes files into the agent's home, owned by the agent", async () => {
    await sb.writeFile(A, "inbox/report.csv", Buffer.from("a,b\n1,2\n"));
    const r = await sb.exec(A, "cat inbox/report.csv && stat -c %U inbox/report.csv");
    expect(r.stdout).toBe("a,b\n1,2\nagent\n");
    await expect(sb.writeFile(A, "../etc/passwd", Buffer.from("x"))).rejects.toThrow(/bad path/);
  });

  it("kills a stuck command at its timeout", async () => {
    const r = await sb.exec(A, "sleep 30", { timeoutMs: 1000 });
    expect(r.timedOut).toBe(true);
  });

  it("can stop running commands without its own control command being caught", async () => {
    const t0 = Date.now();
    const long = sb.exec(A, "sleep 30", { timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 500));
    const stop = await sb.exec(A, "pkill -TERM -f '^timeout -k 2 ' ; true", { raw: true });
    expect(stop.exitCode).toBe(0);
    const r = await long;
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("opens a page and reads its title", async () => {
    const browser = await sb.browserSession(A);
    const r = await browser.act({ action: "goto", url: "data:text/html,<title>North Star</title><h1>hi</h1>" });
    expect(r.title).toBe("North Star");
    const read = await browser.act({ action: "read" });
    expect(read.text).toContain("hi");
  });

  it("streams a shell over the pty", async () => {
    const pty = await sb.openPty(A, { name: "test", cols: 80, rows: 24 });
    const out: string[] = [];
    const seen = new Promise<void>((resolve) =>
      pty.onData((d) => {
        out.push(d);
        if (out.join("").includes("pty-ok")) resolve();
      }),
    );
    pty.write("echo pty-$((1+0))-ok | sed s/-1-/-/\r");
    await seen;
    pty.detach();
  });

  it("keeps the disk and the open tab across hibernate and wake", async () => {
    await sb.hibernate(A);
    expect(await sb.state(A)).toBe("hibernated");
    await sb.wake(A);
    expect(await sb.state(A)).toBe("running");
    expect((await sb.exec(A, "cat a.txt")).stdout).toBe("hi\n");
    const tabs = await (await sb.browserSession(A)).tabs();
    expect(tabs.pages.map((p) => p.title)).toContain("North Star");
  });

  it("snapshots a computer and restores it into a new one", async () => {
    const { snapshotId } = await sb.snapshot(A);
    const C = `t${run}c`;
    try {
      await sb.create({ ...spec(C), fromSnapshot: snapshotId });
      expect((await sb.exec(C, "cat a.txt")).stdout).toBe("hi\n");
    } finally {
      await sb.destroy(C).catch(() => {});
      await docker.getImage(`northbot/snapshot:${snapshotId}`).remove({ force: true }).catch(() => {});
      await docker.getVolume(`nb-snap-${snapshotId}`).remove().catch(() => {});
    }
  });
});
