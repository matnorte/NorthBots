import JSZip from "jszip";
import { z } from "zod";

/** A fact as it travels in exports. Ids are kept so links (derived_from) survive a round trip. */
export const PortableFact = z.object({
  id: z.string(),
  scope: z.enum(["private", "shared"]),
  agentName: z.string().nullable(),
  text: z.string().min(1).max(4000),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  derivedFrom: z.array(z.string()).default([]),
  source: z.string().nullable().default(null),
});
export type PortableFact = z.infer<typeof PortableFact>;

const Manifest = z.object({ format: z.literal("northbot-memory"), version: z.literal(1), facts: z.array(PortableFact) });

/** Export: memory.json (exact, for re-import) plus one readable markdown file per scope/agent. */
export async function exportMemory(facts: PortableFact[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("memory.json", JSON.stringify({ format: "northbot-memory", version: 1, facts }, null, 2));
  const groups = new Map<string, PortableFact[]>();
  for (const f of facts) {
    const key = f.scope === "shared" ? "shared" : `agent-${(f.agentName ?? "unknown").replace(/[^\w-]+/g, "_")}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const [key, list] of groups) {
    const title = key === "shared" ? "Shared memory" : `Memory of ${list[0]?.agentName ?? "an agent"}`;
    const lines = list.map((f) => `- ${f.text.replace(/\n/g, " ")}  \n  _${f.createdAt.slice(0, 10)}${f.source ? ` · ${f.source}` : ""}_`);
    zip.file(`${key}.md`, `# ${title}\n\n${lines.join("\n")}\n`);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export type ImportFormat = "northbot" | "chatgpt" | "claude" | "plain";

export interface ImportResult {
  format: ImportFormat;
  facts: Omit<PortableFact, "id">[] | PortableFact[];
}

const now = () => new Date().toISOString();
const fact = (text: string, source: string, createdAt = now()): Omit<PortableFact, "id"> => ({
  scope: "shared",
  agentName: null,
  text: text.trim().slice(0, 4000),
  createdAt,
  expiresAt: null,
  derivedFrom: [],
  source,
});

/** ChatGPT export (conversations.json): keep each conversation's title and opening request. */
function fromChatGPT(data: unknown): Omit<PortableFact, "id">[] | null {
  if (!Array.isArray(data) || !data.every((c) => c && typeof c === "object" && "mapping" in c)) return null;
  return data.flatMap((c: { title?: string; create_time?: number; mapping: Record<string, { message?: { author?: { role?: string }; content?: { parts?: unknown[] } } | null }> }) => {
    const firstUser = Object.values(c.mapping)
      .map((n) => n.message)
      .find((m) => m?.author?.role === "user" && m.content?.parts?.some((p) => typeof p === "string" && p.trim()));
    const text = firstUser?.content?.parts?.find((p): p is string => typeof p === "string") ?? "";
    if (!c.title && !text) return [];
    const when = c.create_time ? new Date(c.create_time * 1000).toISOString() : now();
    return [fact(`Past ChatGPT conversation "${c.title ?? "untitled"}": ${text.slice(0, 500)}`, "chatgpt import", when)];
  });
}

/** Claude export (conversations.json): name and first human message per conversation. */
function fromClaude(data: unknown): Omit<PortableFact, "id">[] | null {
  if (!Array.isArray(data) || !data.every((c) => c && typeof c === "object" && "chat_messages" in c)) return null;
  return data.flatMap((c: { name?: string; created_at?: string; chat_messages: { sender?: string; text?: string; content?: { type?: string; text?: string }[] }[] }) => {
    const first = c.chat_messages.find((m) => m.sender === "human");
    const text = first?.text || first?.content?.find((p) => p.type === "text")?.text || "";
    if (!c.name && !text) return [];
    return [fact(`Past Claude conversation "${c.name || "untitled"}": ${text.slice(0, 500)}`, "claude import", c.created_at ?? now())];
  });
}

/** Detects the format: a NorthBot zip, ChatGPT / Claude conversations.json (or a zip containing it), or plain JSON / lines. */
export async function importMemory(data: Buffer): Promise<ImportResult> {
  let json: unknown = null;
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const zip = await JSZip.loadAsync(data);
    const own = zip.file("memory.json");
    if (own) return { format: "northbot", facts: Manifest.parse(JSON.parse(await own.async("string"))).facts };
    const convo = zip.file("conversations.json");
    if (!convo) throw new Error("This zip has neither memory.json nor conversations.json.");
    json = JSON.parse(await convo.async("string"));
  } else {
    const text = data.toString("utf8");
    try {
      json = JSON.parse(text);
    } catch {
      const lines = text.split(/\r?\n/).map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean);
      return { format: "plain", facts: lines.map((l) => fact(l, "text import")) };
    }
  }
  const own = Manifest.safeParse(json);
  if (own.success) return { format: "northbot", facts: own.data.facts };
  const gpt = fromChatGPT(json);
  if (gpt) return { format: "chatgpt", facts: gpt };
  const claude = fromClaude(json);
  if (claude) return { format: "claude", facts: claude };
  const plain = z.object({ facts: z.array(z.union([z.string(), z.object({ text: z.string() })])) }).safeParse(json);
  if (plain.success) return { format: "plain", facts: plain.data.facts.map((f) => fact(typeof f === "string" ? f : f.text, "json import")) };
  throw new Error("Unrecognised memory file. Use a NorthBot export, a ChatGPT or Claude conversations.json, or a list of facts.");
}
