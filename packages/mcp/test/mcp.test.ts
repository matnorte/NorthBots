import { describe, it, expect } from "vitest";
import { toolHash, FakeOAuthProvider } from "../src/index.js";
import { createHash } from "node:crypto";
describe("MCP pinning", () => {
  it("pins order-independent schemas and versions", () => {
    const a = {
      name: "read",
      inputSchema: { type: "object" as const, properties: { x: { type: "string" } } },
    };
    expect(toolHash([a], "1")).toBe(toolHash([{ inputSchema: a.inputSchema, name: a.name }], "1"));
    expect(toolHash([a], "2")).not.toBe(toolHash([a], "1"));
    expect(toolHash([{ ...a, description: "new" }], "1")).not.toBe(toolHash([a], "1"));
  });
  it("checks the PKCE verifier and consumes codes", async () => {
    const p = new FakeOAuthProvider();
    const url = new URL(
      await p.authorize("state", createHash("sha256").update("verifier").digest("base64url")),
    );
    const code = url.searchParams.get("code")!;
    await expect(p.exchange(code, "wrong")).rejects.toThrow();
    await expect(p.exchange(code, "verifier")).rejects.toThrow();
  });
});
