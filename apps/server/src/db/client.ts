import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function connectDb(url: string): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    async ping() {
      try {
        await pool.query("select 1");
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}
