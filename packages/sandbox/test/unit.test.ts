import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AgentdClient, FakeSandbox, poolSubnet } from "../src/index.js";

describe("AgentdClient", () => {
  it("matches replies to calls, forwards events, and fails pending calls on close", async () => {
    const fromAgentd = new PassThrough();
    const toAgentd = new PassThrough();
    const client = new AgentdClient(fromAgentd, toAgentd);
    const sent: Record<string, unknown>[] = [];
    toAgentd.on("data", (b: Buffer) => b.toString().split("\n").filter(Boolean).forEach((l) => sent.push(JSON.parse(l))));
    fromAgentd.write('{"ev":"bridge.ready"}\n');
    await client.ready;

    const events: unknown[] = [];
    client.on("event", (e) => events.push(e));
    const p = client.call<{ pong: boolean }>("ping");
    await new Promise((r) => setImmediate(r));
    expect(sent[0]).toMatchObject({ op: "ping", id: 1 });
    fromAgentd.write('{"ev":"pty.data","name":"main","data":"hi"}\n');
    fromAgentd.write('{"id":1,"ok":true,"result":{"pong":true}}\n');
    await expect(p).resolves.toEqual({ pong: true });
    expect(events).toEqual([{ ev: "pty.data", name: "main", data: "hi" }]);

    const failing = client.call("browser.tabs");
    fromAgentd.end();
    await expect(failing).rejects.toThrow(/closed/);
    expect(client.isClosed).toBe(true);
  });

  it("rejects calls that agentd answers with an error", async () => {
    const fromAgentd = new PassThrough();
    const client = new AgentdClient(fromAgentd, new PassThrough());
    const p = client.call("nope");
    fromAgentd.write('{"id":1,"ok":false,"error":"unknown op: nope"}\n');
    await expect(p).rejects.toThrow("unknown op: nope");
  });
});

describe("FakeSandbox", () => {
  it("keeps each computer's files private", async () => {
    const sb = new FakeSandbox();
    await sb.create({ id: "a", egressProxyUrl: "" });
    await sb.create({ id: "b", egressProxyUrl: "" });
    expect((await sb.exec("a", "echo hi > a.txt && cat a.txt")).stdout).toBe("hi\n");
    expect((await sb.exec("b", "cat a.txt")).exitCode).toBe(1);
  });

  it("refuses commands while hibernated and keeps state across wake", async () => {
    const sb = new FakeSandbox();
    await sb.create({ id: "a", egressProxyUrl: "" });
    await sb.exec("a", "echo x > f");
    const browser = await sb.browserSession("a");
    await browser.act({ action: "goto", url: "data:text/html,<title>Hello</title>" });
    await sb.hibernate("a");
    await expect(sb.exec("a", "cat f")).rejects.toThrow(/hibernated/);
    await sb.wake("a");
    expect((await sb.exec("a", "cat f")).stdout).toBe("x\n");
    expect((await browser.tabs()).pages[0]?.title).toBe("Hello");
  });

  it("records egress for curl and web pages", async () => {
    const sb = new FakeSandbox();
    await sb.create({ id: "a", egressProxyUrl: "" });
    await sb.exec("a", "curl -s https://example.com/x");
    await (await sb.browserSession("a")).act({ action: "goto", url: "https://shop.test/" });
    expect(sb.egressOf("a")).toEqual(["example.com", "shop.test"]);
  });
});

describe("FakeSandbox scripts and read-only files", () => {
  it("runs scripts and refuses to overwrite installed read-only files", async () => {
    const sb = new FakeSandbox();
    await sb.create({ id: "a", egressProxyUrl: "" });
    await sb.writeReadonly("a", "tool/run.sh", Buffer.from("#!/bin/bash\nset -e\necho one\necho two\n"));
    expect((await sb.exec("a", "bash /opt/northbot-skills/tool/run.sh")).stdout).toBe("one\ntwo\n");
    expect((await sb.exec("a", "echo evil > /opt/northbot-skills/tool/run.sh")).exitCode).toBe(1);
  });
});

describe("poolSubnet", () => {
  it("carves a /16 into consecutive, non-overlapping /28 agent networks", () => {
    expect(poolSubnet("10.213.0.0/16", 0)).toBe("10.213.0.0/28");
    expect(poolSubnet("10.213.0.0/16", 1)).toBe("10.213.0.16/28");
    expect(poolSubnet("10.213.0.0/16", 16)).toBe("10.213.1.0/28");
    expect(poolSubnet("10.213.0.0/16", 4095)).toBe("10.213.255.240/28");
  });
});
