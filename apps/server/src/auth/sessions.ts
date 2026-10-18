import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Me } from "@northbot/shared";
import type { DbHandle } from "../db/client.js";
import { sessions, users } from "../db/schema.js";

export const SESSION_COOKIE = "nb_session";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export class SessionStore {
  constructor(
    private readonly db: DbHandle,
    private readonly ttlHours: number,
  ) {}

  /** Creates a session and returns the raw token (only ever placed in the cookie). */
  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.ttlHours * 3600_000);
    await this.db.db.insert(sessions).values({ tokenHash: sha256(token), userId, expiresAt });
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<Me | null> {
    const [row] = await this.db.db
      .select({ userId: users.id, workspaceId: users.workspaceId, email: users.email })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
    return row ?? null;
  }

  async destroy(token: string): Promise<void> {
    await this.db.db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  }
}
