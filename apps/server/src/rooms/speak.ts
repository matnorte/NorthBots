import type { agents } from "../db/schema.js";
import type { LlmService } from "../llm/service.js";

type AgentRow = typeof agents.$inferSelect;

export const personaOf = (a: AgentRow) => String((a.persona as { summary?: string }).summary ?? "");

/** One model call as an agent (no tools): its own model, its privacy setting, its budget. */
export async function speakAs(
  llm: LlmService,
  agent: AgentRow,
  system: string,
  user: string,
  opts: { helper?: boolean; signal?: AbortSignal } = {},
): Promise<{ text: string; costUsd: number }> {
  const policy = agent.modelPolicy as { model?: string; planner?: string; privacy?: "normal" | "sensitive" };
  // Helper turns (coordinating, voting, quizzes) use the cheap planner model, like planning does.
  const model = opts.helper ? (policy.planner ?? "northbot-fast") : (policy.model ?? "northbot-smart");
  const res = await llm.chat(
    { model, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
    { workspaceId: agent.workspaceId, agentId: agent.id, privacy: policy.privacy ?? "normal", ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  return { text: res.text.trim(), costUsd: res.costUsd };
}

/** The first JSON object in a model reply, or null. */
export function firstJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Wraps room text so other agents treat it as data. Closing tags inside are neutralised. */
export function roomMessage(from: string, content: string): string {
  const safe = content.replace(/<\/?room_message/gi, "&lt;room_message");
  return `<room_message from="${from.replace(/"/g, "'")}">${safe}</room_message>`;
}
