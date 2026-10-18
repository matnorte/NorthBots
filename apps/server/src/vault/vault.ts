import { and, asc, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.js";
import { secrets } from "../db/schema.js";
import type { SecretBox } from "./crypto.js";
import type { SecretSink } from "./sink.js";

export interface SecretMeta {
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Encrypted secret storage. There is deliberately no method that returns a value to a caller:
 * values only leave through a SecretSink (into a sandbox) or `withSecret` (server-side use).
 */
export class Vault {
  constructor(
    private readonly db: DbHandle,
    private readonly box: SecretBox,
    private sink: SecretSink,
  ) {}

  setSink(sink: SecretSink): void {
    this.sink = sink;
  }

  async put(workspaceId: string, name: string, value: string): Promise<void> {
    const sealed = this.box.seal(workspaceId, value);
    await this.db.db
      .insert(secrets)
      .values({ workspaceId, name, ...sealed })
      .onConflictDoUpdate({
        target: [secrets.workspaceId, secrets.name],
        set: { ...sealed, updatedAt: new Date() },
      });
  }

  async listNames(workspaceId: string): Promise<SecretMeta[]> {
    return this.db.db
      .select({ name: secrets.name, createdAt: secrets.createdAt, updatedAt: secrets.updatedAt })
      .from(secrets)
      .where(eq(secrets.workspaceId, workspaceId))
      .orderBy(asc(secrets.name));
  }

  async delete(workspaceId: string, name: string): Promise<boolean> {
    const rows = await this.db.db
      .delete(secrets)
      .where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.name, name)))
      .returning({ id: secrets.id });
    return rows.length > 0;
  }

  async useInSandbox(
    workspaceId: string,
    name: string,
    opts: { sandboxId: string; as: "env" | "file"; target: string },
  ): Promise<boolean> {
    return this.withSecret(workspaceId, name, async (value) => {
      await this.sink.inject({ ...opts, name, value });
      return true;
    }).then((r) => r ?? false);
  }

  /** Server-internal use (e.g. provider API keys). The callback must not log or return the value. */
  async withSecret<T>(
    workspaceId: string,
    name: string,
    fn: (value: string) => Promise<T>,
  ): Promise<T | null> {
    const [row] = await this.db.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.name, name)));
    if (!row) return null;
    return fn(this.box.open(workspaceId, row));
  }
}
