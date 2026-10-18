import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { connectDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

export interface TestApp {
  app: FastifyInstance;
  db: DbHandle;
  close(): Promise<void>;
}

/** Boots the real app against the compose Postgres (DATABASE_URL or localhost default). */
export async function startTestApp(): Promise<TestApp> {
  const config = loadConfig({ ...process.env, LOG_LEVEL: "silent" });
  const db = connectDb(config.DATABASE_URL);
  await runMigrations(db);
  const app = await buildApp({ config, db });
  await app.ready();
  return {
    app,
    db,
    async close() {
      await app.close();
      await db.close();
    },
  };
}
