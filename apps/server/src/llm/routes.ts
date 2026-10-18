import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { me } from "../auth/guard.js";
import type { Services } from "../services.js";
import { LlmSettings, loadLlmSettings, saveLlmSettings } from "./settings.js";

/** Provider, alias, budget and privacy settings. Only vault secret *names* appear here. */
export const llmSettingsRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["settings"];
  app.addHook("preHandler", s.auth);

  app.get("/settings/llm", { schema: { tags, response: { 200: LlmSettings } } }, async (req) => {
    return (await loadLlmSettings(s.db, me(req).workspaceId)).settings;
  });

  app.put(
    "/settings/llm",
    { schema: { tags, body: LlmSettings, response: { 200: LlmSettings } } },
    async (req) => {
      const m = me(req);
      await saveLlmSettings(s.db, m.workspaceId, req.body);
      await s.events.write(m.workspaceId, { type: "llm.settings_updated", payload: { userId: m.userId } });
      return req.body;
    },
  );
};
