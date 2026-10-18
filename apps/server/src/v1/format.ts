import { z } from "zod";
import type { ChatMessage, ChatRequest, ChatResult, FinishReason } from "@northbot/llm-router";

const TextPart = z.object({ type: z.string(), text: z.string().optional() }).passthrough();
const Content = z.union([z.string(), z.array(TextPart), z.null()]).optional();

const OAToolCall = z.object({
  id: z.string(),
  type: z.literal("function").default("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

export const ChatCompletionBody = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "developer", "user", "assistant", "tool"]),
            content: Content,
            tool_calls: z.array(OAToolCall).optional(),
            tool_call_id: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1),
    tools: z
      .array(
        z.object({
          type: z.literal("function"),
          function: z.object({
            name: z.string(),
            description: z.string().default(""),
            parameters: z.record(z.unknown()).default({ type: "object", properties: {} }),
          }),
        }),
      )
      .optional(),
    stream: z.boolean().default(false),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
    metadata: z.record(z.string()).optional(),
  })
  .passthrough();
export type ChatCompletionBody = z.infer<typeof ChatCompletionBody>;

export const ResponsesBody = z
  .object({
    model: z.string().min(1),
    input: z.union([
      z.string(),
      z.array(z.object({ role: z.enum(["system", "developer", "user", "assistant"]), content: Content }).passthrough()),
    ]),
    instructions: z.string().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    stream: z.boolean().default(false),
    metadata: z.record(z.string()).optional(),
  })
  .passthrough();
export type ResponsesBody = z.infer<typeof ResponsesBody>;

export function textOf(content: z.infer<typeof Content>): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((p) => p.text ?? "").join("");
}

export function fromChatCompletion(body: ChatCompletionBody): ChatRequest {
  const messages: ChatMessage[] = body.messages.map((m): ChatMessage => {
    const content = textOf(m.content);
    switch (m.role) {
      case "system":
      case "developer":
        return { role: "system", content };
      case "user":
        return { role: "user", content };
      case "assistant":
        return {
          role: "assistant",
          content,
          toolCalls: m.tool_calls?.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
        };
      case "tool":
        return { role: "tool", toolCallId: m.tool_call_id ?? "", content };
    }
  });
  return {
    model: body.model,
    messages,
    tools: body.tools?.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature,
    effort: body.reasoning_effort,
  };
}

export function fromResponses(body: ResponsesBody): ChatRequest {
  const messages: ChatMessage[] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  if (typeof body.input === "string") messages.push({ role: "user", content: body.input });
  else {
    for (const m of body.input) {
      const content = textOf(m.content);
      if (m.role === "system" || m.role === "developer") messages.push({ role: "system", content });
      else if (m.role === "assistant") messages.push({ role: "assistant", content });
      else messages.push({ role: "user", content });
    }
  }
  return { model: body.model, messages, maxTokens: body.max_output_tokens };
}

export function finishReason(r: FinishReason): string {
  return r === "refusal" ? "content_filter" : r === "error" ? "stop" : r;
}

export function toChatCompletion(r: ChatResult) {
  return {
    id: r.id,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: r.alias ?? r.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: r.text || (r.toolCalls.length ? null : ""),
          refusal: null,
          ...(r.toolCalls.length
            ? {
                tool_calls: r.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
        finish_reason: finishReason(r.finishReason),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: r.usage.inputTokens,
      completion_tokens: r.usage.outputTokens,
      total_tokens: r.usage.inputTokens + r.usage.outputTokens,
    },
    northbot: { provider: r.provider, served_model: r.model, cost_usd: r.costUsd, fallbacks: r.fallbacks },
  };
}

export function toResponse(r: ChatResult) {
  return {
    id: `resp_${r.id.replace(/^chatcmpl-/, "")}`,
    object: "response" as const,
    created_at: Math.floor(Date.now() / 1000),
    status: "completed" as const,
    model: r.alias ?? r.model,
    output: [
      {
        type: "message" as const,
        id: `msg_${r.id.slice(-12)}`,
        status: "completed" as const,
        role: "assistant" as const,
        content: [{ type: "output_text" as const, text: r.text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: r.usage.inputTokens,
      output_tokens: r.usage.outputTokens,
      total_tokens: r.usage.inputTokens + r.usage.outputTokens,
    },
  };
}
