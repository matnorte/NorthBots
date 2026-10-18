import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxSecretSink } from "../src/computer/secret-sink.js";
import { signup, startTestApp, type TestApp } from "./helpers.js";

const VALUE = "sk-shop-canary-77ab12cd34ef";

describe("SandboxSecretSink", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => t.close());

  async function agent() {
    const s = await signup(t.app);
    const a = (await t.app.inject({ method: "POST", url: "/agents", headers: { cookie: s.cookie }, payload: { name: "Vee" } })).json();
    return { ...s, sandboxId: a.sandboxId as string };
  }

  it("passes the value only through the exec environment", async () => {
    const { me, sandboxId } = await agent();
    const seen: { command: string; env?: Record<string, string> }[] = [];
    t.sandbox.onExec((_id, command, opts) => {
      if (!command.includes("NB_VALUE")) return undefined;
      seen.push({ command, env: opts.env });
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, truncated: false };
    });
    const sink = new SandboxSecretSink(t.db, t.sandbox);
    await sink.inject({ workspaceId: me.workspaceId, sandboxId, name: "SHOP_TOKEN", value: VALUE, as: "env", target: "SHOP_TOKEN" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).not.toContain(VALUE);
    expect(seen[0]?.env).toMatchObject({ NB_VALUE: VALUE, NB_VAR: "SHOP_TOKEN" });
  });

  it("refuses another workspace's computer and unsafe targets", async () => {
    const owner = await agent();
    const other = await signup(t.app);
    const sink = new SandboxSecretSink(t.db, t.sandbox);
    const base = { name: "X", value: VALUE, as: "file" as const };
    await expect(sink.inject({ ...base, workspaceId: other.me.workspaceId, sandboxId: owner.sandboxId, target: "x.txt" })).rejects.toThrow(
      /no such computer/,
    );
    await expect(sink.inject({ ...base, workspaceId: owner.me.workspaceId, sandboxId: owner.sandboxId, target: "../etc/passwd" })).rejects.toThrow(
      /bad target/,
    );
  });
});
