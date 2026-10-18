import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AllProvidersFailedError,
  BudgetExceededError,
  NoProviderError,
  PrivacyError,
  RouterError,
  type CallContext,
  type StreamEvent,
} from "@northbot/llm-router";
import type { ApiKeyPrincipal } from "../apikeys/store.js";
import { sha256 } from "../auth/sessions.js";
import type { Services } from "../services.js";
import {
  ChatCompletionBody,
  finishReason,
  fromChatCompletion,
  fromResponses,
  ResponsesBody,
  toChatCompletion,
  toResponse,
} from "./format.js";

declare module "fastify" {
  interface FastifyRequest {
    apiKey: ApiKeyPrincipal | null;
  }
}

const OAError = z.object({ error: z.object({ message: z.string(), type: z.string(), code: z.string().nullable() }) });
const Loose = z.object({}).passthrough();

function oaError(err: unknown): { status: number; body: z.infer<typeof OAError> } {
  const make = (status: number, type: string, message: string) => ({ status, body: { error: { message, type, code: type } } });
  if (err instanceof BudgetExceededError) return make(402, "budget_exceeded", err.message);
  if (err instanceof PrivacyError) return make(403, "privacy_violation", err.message);
  if (err instanceof NoProviderError) return make(404, "model_not_found", err.message);
  if (err instanceof AllProvidersFailedError) return make(502, "provider_error", err.message);
  if (err instanceof RouterError) return make(400, err.code, err.message);
  throw err;
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** NorthBot routing hints come from x-northbot-* headers or `metadata.northbot_*` in the body. */
function callContext(req: FastifyRequest, key: ApiKeyPrincipal, metadata: Record<string, string> = {}): CallContext {
  const pick = (h: string, m: string) => header(req, h) ?? metadata[m];
  const budget = pick("x-northbot-task-budget-usd", "northbot_task_budget_usd");
  return {
    workspaceId: key.workspaceId,
    apiKeyId: key.id,
    agentId: pick("x-northbot-agent-id", "northbot_agent_id") ?? null,
    taskId: pick("x-northbot-task-id", "northbot_task_id") ?? null,
    taskBudgetUsd: budget ? Number(budget) : null,
    privacy: pick("x-northbot-privacy", "northbot_privacy") === "sensitive" ? "sensitive" : "normal",
  };
}

export const v1Routes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["openai-compatible"];
  app.decorateRequest("apiKey", null);

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = header(req, "authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : header(req, "x-api-key");
    const key = token ? await s.apiKeys.authenticate(token) : null;
    if (!key || !key.scopes.includes("llm")) {
      await reply.code(401).send({
        error: { message: "Missing or invalid NorthBot API key.", type: "invalid_api_key", code: "invalid_api_key" },
      });
      return;
    }
    req.apiKey = key;
  });

  // Per-key rate limit (the global limiter is per IP).
  const rateLimit = {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => sha256(header(req, "authorization") ?? header(req, "x-api-key") ?? req.ip),
  };
  const principal = (req: FastifyRequest): ApiKeyPrincipal => {
    if (!req.apiKey) throw new Error("api key guard did not run");
    return req.apiKey;
  };

  app.get(
    "/v1/models",
    { config: { rateLimit }, schema: { tags, response: { 200: Loose } } },
    async (req) => ({
      object: "list",
      data: (await s.llm.models(principal(req).workspaceId)).map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: m.provider ?? "northbot",
      })),
    }),
  );

  app.post(
    "/v1/chat/completions",
    { config: { rateLimit }, schema: { tags, body: ChatCompletionBody, response: { 200: Loose, "4xx": OAError, "5xx": OAError } } },
    async (req, reply) => {
      const key = principal(req);
      const ctx = callContext(req, key, req.body.metadata);
      const chatReq = fromChatCompletion(req.body);
      const opts = { apiKeyDailyUsd: key.dailyBudgetUsd };

      if (!req.body.stream) {
        try {
          return toChatCompletion(await s.llm.chat(chatReq, ctx, opts));
        } catch (err) {
          const e = oaError(err);
          return reply.code(e.status).send(e.body);
        }
      }

      // Streaming: pull the first event before committing to a 200, so routing errors stay JSON.
      const it = s.llm.stream(chatReq, ctx, opts)[Symbol.asyncIterator]();
      let first: IteratorResult<StreamEvent>;
      try {
        first = await it.next();
      } catch (err) {
        const e = oaError(err);
        return reply.code(e.status).send(e.body);
      }
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const id = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const send = (choices: unknown[], extra: object = {}) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: req.body.model, choices, ...extra })}\n\n`);
      send([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
      try {
        for (let ev = first; !ev.done; ev = await it.next()) {
          const e = ev.value;
          if (e.type === "text") {
            send([{ index: 0, delta: { content: e.text }, finish_reason: null }]);
            continue;
          }
          const r = e.result;
          const toolCalls = r.toolCalls.map((c, index) => ({
            index,
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          }));
          send([{ index: 0, delta: toolCalls.length ? { tool_calls: toolCalls } : {}, finish_reason: finishReason(r.finishReason) }]);
          if (req.body.stream_options?.include_usage) {
            send([], {
              usage: {
                prompt_tokens: r.usage.inputTokens,
                completion_tokens: r.usage.outputTokens,
                total_tokens: r.usage.inputTokens + r.usage.outputTokens,
              },
            });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "stream failed";
        res.write(`data: ${JSON.stringify({ error: { message: msg, type: "provider_error", code: "provider_error" } })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    },
  );

  app.post(
    "/v1/responses",
    { config: { rateLimit }, schema: { tags, body: ResponsesBody, response: { 200: Loose, "4xx": OAError, "5xx": OAError } } },
    async (req, reply) => {
      if (req.body.stream) {
        return reply.code(400).send({
          error: { message: "Streaming is not supported on /v1/responses yet; use /v1/chat/completions.", type: "unsupported", code: "unsupported" },
        });
      }
      const key = principal(req);
      try {
        const r = await s.llm.chat(fromResponses(req.body), callContext(req, key, req.body.metadata), {
          apiKeyDailyUsd: key.dailyBudgetUsd,
        });
        return toResponse(r);
      } catch (err) {
        const e = oaError(err);
        return reply.code(e.status).send(e.body);
      }
    },
  );
};
