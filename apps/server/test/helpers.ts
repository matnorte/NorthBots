import { randomUUID } from "node:crypto";
import pg from "pg";
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

/**
 * Tests use their own database (northbot_test) on the compose Postgres, so the running
 * server never sees (or resumes) test data.
 */
async function testDatabaseUrl(): Promise<string> {
  const base = new URL(process.env.DATABASE_URL ?? "postgres://northbot:northbot@localhost:5432/northbot");
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname = 'northbot_test'");
    if (exists.rowCount === 0) await admin.query("create database northbot_test").catch(() => {});
  } finally {
    await admin.end();
  }
  base.pathname = "/northbot_test";
  return base.toString();
}

/** Boots the real app against the test database on the compose Postgres. */
export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const DATABASE_URL = await testDatabaseUrl();
  const config = loadConfig({ ...process.env, DATABASE_URL, LOG_LEVEL: "silent", AUTH_RATE_LIMIT_PER_MIN: "1000", ...env });
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
