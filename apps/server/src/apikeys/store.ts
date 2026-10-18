import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "../db/client.js";
import { apiKeys } from "../db/schema.js";
import { sha256 } from "../auth/sessions.js";

export interface ApiKeyPrincipal {
  id: string;
  workspaceId: string;
  scopes: string[];
  dailyBudgetUsd: number | null;
}

export const API_KEY_PREFIX = "nb_";

/** API keys for the /v1 endpoint and MCP. Only a sha256 of each key is stored. */
export class ApiKeyStore {
  constructor(private readonly db: DbHandle) {}

  async create(input: {
    workspaceId: string;
    name: string;
    scopes: string[];
    dailyBudgetUsd: number | null;
    createdBy: string;
  }) {
    const key = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
    const [row] = await this.db.db
      .insert(apiKeys)
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        prefix: key.slice(0, 10),
        keyHash: sha256(key),
        scopes: input.scopes,
        dailyBudgetUsd: input.dailyBudgetUsd === null ? null : String(input.dailyBudgetUsd),
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error("api key insert failed");
    return { row, key };
  }

  async list(workspaceId: string) {
    return this.db.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt));
  }

  async revoke(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }

  async authenticate(key: string): Promise<ApiKeyPrincipal | null> {
    if (!key.startsWith(API_KEY_PREFIX)) return null;
    const [row] = await this.db.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, sha256(key)), isNull(apiKeys.revokedAt)));
    if (!row) return null;
    void this.db.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => {});
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      scopes: row.scopes,
      dailyBudgetUsd: row.dailyBudgetUsd === null ? null : Number(row.dailyBudgetUsd),
    };
  }
}
