import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { FakeSandbox } from "@northbot/sandbox";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { connectDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Services } from "../src/services.js";
import { MemorySecretSink } from "../src/vault/sink.js";

export interface TestApp {
  app: FastifyInstance;
  db: DbHandle;
  services: Services;
  sink: MemorySecretSink;
  sandbox: FakeSandbox;
  config: Config;
  close(): Promise<void>;
}

/** Boots the real app against the compose Postgres (DATABASE_URL or localhost default). */
export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({ ...process.env, LOG_LEVEL: "silent", AUTH_RATE_LIMIT_PER_MIN: "1000", ...env });
  const db = connectDb(config.DATABASE_URL);
  await runMigrations(db);
  const sink = new MemorySecretSink();
  const sandbox = new FakeSandbox();
  const { app, services } = await buildApp({ config, db, secretSink: sink, sandbox });
  await app.ready();
  return {
    app,
    db,
    services,
    sink,
    sandbox,
    config,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

export const uniqueEmail = (): string => `t-${randomUUID()}@example.test`;

/** Signs up a fresh account and returns the session cookie header value. */
export async function signup(app: FastifyInstance, email = uniqueEmail()) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password: "correct horse battery" },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "nb_session");
  if (!cookie) throw new Error("no session cookie");
  return { cookie: `nb_session=${cookie.value}`, email, me: res.json() as { userId: string; workspaceId: string } };
}
