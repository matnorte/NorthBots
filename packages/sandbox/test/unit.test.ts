import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AgentdClient, FakeSandbox } from "../src/index.js";

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
