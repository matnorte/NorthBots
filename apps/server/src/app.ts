import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import type { DbHandle } from "./db/client.js";
import { healthRoutes } from "./routes/health.js";

export interface AppDeps {
  config: Config;
  db: DbHandle;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      // Never log credentials that may travel in headers.
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-api-key']"],
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: { info: { title: "NorthBot API", version: "0.0.0" } },
    transform: jsonSchemaTransform,
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  await app.register(healthRoutes, deps);
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  return app;
}
