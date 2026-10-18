import type { DbHandle } from "./client.js";
import pg from "pg";

/** Nonblocking, cross-process lock. Never exhaust the pool with waiting duplicate requests. */
export async function tryLocked<T>(db: DbHandle, key: string, action: () => Promise<T>) {
  // Use a dedicated connection: holding a pool slot while action() queries the same pool can
  // deadlock when distinct operations fill every slot. Closing also releases the session lock.
  const client = new pg.Client(db.pool.options);
  let locked = false;
  try {
    await client.connect();
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 727012)) as locked",
      [key],
    );
    locked = result.rows[0]?.locked === true;
    return locked ? { locked: true as const, value: await action() } : { locked: false as const };
  } finally {
    try {
      if (locked)
        await client.query("select pg_advisory_unlock(hashtextextended($1, 727012))", [key]);
    } finally {
      await client.end();
    }
  }
}
