import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export { DockerStdioTransport } from "./stdio.js";
export const McpConfig = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string().min(1).max(300),
    args: z.array(z.string().max(2000)).max(40).default([]),
  }),
  z.object({
    transport: z.literal("http"),
    url: z.string().url(),
    tokenSecret: z.string().nullable().default(null),
  }),
]);
export type McpConfig = z.infer<typeof McpConfig>;
export const ToolPolicy = z.object({
  effect: z.enum(["allow", "ask", "block"]).default("ask"),
  kind: z.enum(["read", "write", "send", "spend", "login", "delete"]).default("write"),
  costUsd: z.number().min(0).max(100).default(0),
});
export type ToolPolicy = z.infer<typeof ToolPolicy>;
export interface PinnedTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
export const toolHash = (tools: PinnedTool[], version: string) =>
  createHash("sha256")
    .update(canonical({ version, tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)) }))
    .digest("hex");
/** OAuth provider boundary. The fake models one-use codes and state, never a production login. */
export interface OAuthProvider {
  authorize(state: string, challenge: string): Promise<string>;
  exchange(code: string, verifier: string): Promise<string>;
}
export class FakeOAuthProvider implements OAuthProvider {
  private codes = new Map<string, string>();
  async authorize(state: string, challenge: string) {
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, challenge);
    return `https://fake-oauth.invalid/callback?state=${encodeURIComponent(state)}&code=${code}`;
  }
  async exchange(code: string, verifier: string) {
    const challenge = this.codes.get(code);
    this.codes.delete(code);
    if (!challenge || challenge !== createHash("sha256").update(verifier).digest("base64url"))
      throw new Error("Invalid or reused authorization code");
    return randomBytes(32).toString("base64url");
  }
}
