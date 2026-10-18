import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { DbHandle } from "./client.js";

/** Walks up from this file until it finds the `drizzle` migrations folder (works from src and dist). */
export function findMigrationsDir(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "drizzle");
    if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`drizzle migrations folder not found above ${start}`);
}

export async function runMigrations(handle: DbHandle): Promise<void> {
  // Advisory lock so several server instances booting together migrate once.
  const client = await handle.pool.connect();
  try {
    await client.query("select pg_advisory_lock(727001)");
    await migrate(handle.db, { migrationsFolder: findMigrationsDir() });
  } finally {
    await client.query("select pg_advisory_unlock(727001)");
    client.release();
  }
}
