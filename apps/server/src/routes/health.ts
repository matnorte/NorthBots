import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { HealthResponse } from "@northbot/shared";
import { VERSION } from "../config.js";
import type { AppDeps } from "../app.js";

/** Public liveness route: no auth by design so load balancers and install.sh can probe it. */
export const healthRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, deps) => {
  app.get(
    "/health",
    { schema: { response: { 200: HealthResponse, 503: HealthResponse } } },
    async (_req, reply) => {
      const dbOk = await deps.db.ping();
      const body: HealthResponse = {
        status: dbOk ? "ok" : "degraded",
        db: dbOk ? "ok" : "down",
        version: VERSION,
      };
      return reply.code(dbOk ? 200 : 503).send(body);
    },
  );
};
