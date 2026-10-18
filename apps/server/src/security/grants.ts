import { and, eq, isNull, or, gt } from "drizzle-orm";
import type { DbHandle } from "../db/client.js";
import { agents, users, vaultGrants } from "../db/schema.js";
import type { EventLog } from "../events/log.js";
export class GrantService {
  constructor(
    private db: DbHandle,
    private events: EventLog,
  ) {}
  async authorize(
    ws: string,
    resource: string,
    kind: "user" | "agent",
    id: string,
    manage: boolean | "metadata" = false,
  ) {
    if (kind === "user") {
      const [user] = await this.db.db
        .select()
        .from(users)
        .where(and(eq(users.workspaceId, ws), eq(users.id, id)));
      if (user?.role === "owner") return true;
    }
    const rows = await this.db.db
      .select()
      .from(vaultGrants)
      .where(
        and(
          eq(vaultGrants.workspaceId, ws),
          eq(vaultGrants.resource, resource),
          eq(vaultGrants.subjectKind, kind),
          eq(vaultGrants.subjectId, id),
          isNull(vaultGrants.revokedAt),
          or(isNull(vaultGrants.expiresAt), gt(vaultGrants.expiresAt, new Date())),
        ),
      );
    return rows.some((r) => manage === "metadata" ? r.role !== "use-only" : !manage || r.role === "owner");
  }
  async grant(input: {
    workspaceId: string;
    resource: string;
    subjectKind: "user" | "agent";
    subjectId: string;
    role: "owner" | "user" | "use-only";
    expiresAt: Date | null;
    createdBy: string;
  }) {
    if (!(await this.authorize(input.workspaceId, input.resource, "user", input.createdBy, true)))
      throw new Error("Only a resource owner can grant access");
    const table = input.subjectKind === "user" ? users : agents;
    if (
      !(
        await this.db.db
          .select({ id: table.id })
          .from(table)
          .where(and(eq(table.workspaceId, input.workspaceId), eq(table.id, input.subjectId)))
      )[0]
    )
      throw new Error("No such team member or agent");
    if (input.subjectKind === "agent" && input.role !== "use-only")
      throw new Error("Agents can only receive use-only grants");
    if (input.role !== "owner" && (!input.expiresAt || input.expiresAt <= new Date()))
      throw new Error("A future expiry is required");
    const [row] = await this.db.db.insert(vaultGrants).values(input).returning();
    if (!row) throw new Error("Grant failed");
    await this.events.write(input.workspaceId, {
      type: "security.grant",
      payload: { grantId: row.id, operation: "created", resource: row.resource, role: row.role },
    });
    return row;
  }
  async revoke(ws: string, id: string, userId: string) {
    const [row] = await this.db.db
      .select()
      .from(vaultGrants)
      .where(and(eq(vaultGrants.workspaceId, ws), eq(vaultGrants.id, id)));
    if (!row || !(await this.authorize(ws, row.resource, "user", userId, true)))
      throw new Error("Only an owner can revoke access");
    await this.db.db
      .update(vaultGrants)
      .set({ revokedAt: new Date() })
      .where(eq(vaultGrants.id, id));
    await this.events.write(ws, {
      type: "security.grant",
      payload: { grantId: id, operation: "revoked", resource: row.resource, role: row.role },
    });
  }
}
