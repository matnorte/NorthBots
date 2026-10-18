import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Provider } from "@northbot/llm-router";
import { apiKeyRoutes } from "./apikeys/routes.js";
import { ApiKeyStore } from "./apikeys/store.js";
import { requireAuth } from "./auth/guard.js";
import { passkeyRoutes } from "./auth/passkey-routes.js";
import { authRoutes } from "./auth/routes.js";
import { SessionStore } from "./auth/sessions.js";
import { DEV_MASTER_KEY, VERSION, type Config } from "./config.js";
import type { DbHandle } from "./db/client.js";
import { EventLog } from "./events/log.js";
import { eventRoutes } from "./events/routes.js";
import { llmSettingsRoutes } from "./llm/routes.js";
import { LlmService } from "./llm/service.js";
import { healthRoutes } from "./routes/health.js";
import type { Services } from "./services.js";
import { settingsRoutes } from "./settings/routes.js";
import { SecretBox } from "./vault/crypto.js";
import { vaultRoutes } from "./vault/routes.js";
import { MemorySecretSink, type SecretSink } from "./vault/sink.js";
import { Vault } from "./vault/vault.js";
import { v1Routes } from "./v1/routes.js";

export interface AppDeps {
  config: Config;
  db: DbHandle;
  secretSink?: SecretSink;
  /** Test hook: providers that replace configured ones by name. */
  llmProviders?: Record<string, Provider>;
}

export interface App {
  app: FastifyInstance;
  services: Services;
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const { config, db } = deps;
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never log credentials that may travel in headers or bodies.
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-api-key']",
        "res.headers['set-cookie']",
      ],
    },
  }).withTypeProvider<ZodTypeProvider>();

  if (config.NORTHBOT_MASTER_KEY === DEV_MASTER_KEY) {
    app.log.warn("NORTHBOT_MASTER_KEY is the built-in development key. Set a real one in production.");
  }

  const events = new EventLog(db, config.DATABASE_URL);
  await events.start();
  const sessions = new SessionStore(db, config.SESSION_TTL_HOURS);
  const box = await SecretBox.create(config.NORTHBOT_MASTER_KEY);
  const vault = new Vault(db, box, deps.secretSink ?? new MemorySecretSink());
  const apiKeys = new ApiKeyStore(db);
  const llm = new LlmService(db, events, vault, deps.llmProviders);
  const services: Services = { config, db, events, sessions, vault, apiKeys, llm, auth: requireAuth(sessions) };
  app.addHook("onClose", async () => events.stop());

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("me", null);

  await app.register(swagger, {
    openapi: { info: { title: "NorthBot API", version: VERSION } },
    transform: jsonSchemaTransform,
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(cookie);
  await app.register(websocket);

  await app.register(healthRoutes, { config, db });
  await app.register(authRoutes, services);
  await app.register(passkeyRoutes, services);
  await app.register(settingsRoutes, services);
  await app.register(vaultRoutes, services);
  await app.register(eventRoutes, services);
  await app.register(llmSettingsRoutes, services);
  await app.register(apiKeyRoutes, services);
  await app.register(v1Routes, services);
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  return { app, services };
}
