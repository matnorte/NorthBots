import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { extractTargets } from "@northbot/agent-runtime";
import type { Services } from "../services.js";
import { agents, canaryTokens, dataLabels, events, files, notifications } from "../db/schema.js";
export class DataGuard {
  constructor(private s: Pick<Services, "db" | "events">) {}
  async label(
    ws: string,
    type: "file" | "memory" | "agent",
    id: string,
    label: "public" | "private" | "secret",
    destinations: string[],
  ) {
    const table = type === "file" ? "files" : type === "memory" ? "facts" : "agents";
    if (
      !(
        await this.s.db.pool.query(`select id from ${table} where id=$1 and workspace_id=$2`, [
          id,
          ws,
        ])
      ).rowCount
    )
      throw new Error("No such resource");
    if (
      destinations.some(
        (x) =>
          x.length > 300 ||
          (!x.startsWith("agent:") &&
            !x.startsWith("model:") &&
            !x.startsWith("client:") &&
            !/^[a-z0-9.-]+$/i.test(x)),
      )
    )
      throw new Error("Use exact hosts, agent:UUID or model:local destinations");
    const [row] = await this.s.db.db
      .insert(dataLabels)
      .values({ workspaceId: ws, resourceType: type, resourceId: id, label, destinations })
      .onConflictDoUpdate({
        target: [dataLabels.workspaceId, dataLabels.resourceType, dataLabels.resourceId],
        set: { label, destinations },
      })
      .returning();
    await this.s.events.write(ws, {
      type: "security.label",
      payload: { resourceType: type, resourceId: id, label, destinations },
    });
    return row;
  }
  async check(ws: string, type: string, id: string, destination: string) {
    const [row] = await this.s.db.db
      .select()
      .from(dataLabels)
      .where(
        and(
          eq(dataLabels.workspaceId, ws),
          eq(dataLabels.resourceType, type),
          eq(dataLabels.resourceId, id),
        ),
      );
    if (!row || row.label === "public") return;
    if (row.destinations.includes(destination)) return;
    // Private data may stay in its workspace/assigned computer; secret destinations must all be explicit.
    if (row.label === "private" && destination.startsWith("agent:")) {
      if (
        (
          await this.s.db.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.workspaceId, ws), eq(agents.id, destination.slice(6))))
        )[0]
      )
        return;
    }
    await this.alert(
      ws,
      "data_flow_blocked",
      id,
      `Blocked ${row.label} data flowing to an unapproved destination.`,
    );
    throw new Error(
      "Data label blocks this destination. Ask an owner to review allowed destinations.",
    );
  }
  async receiveFiles(ws: string, agentId: string, ids: string[], type: "file" | "memory" = "file") {
    for (const id of ids) {
      await this.check(ws, type, id, `agent:${agentId}`);
      const [row] = await this.s.db.db
        .select()
        .from(dataLabels)
        .where(
          and(
            eq(dataLabels.workspaceId, ws),
            eq(dataLabels.resourceType, type),
            eq(dataLabels.resourceId, id),
          ),
        );
      if (row && row.label !== "public") {
        const [current] = await this.s.db.db
          .select()
          .from(dataLabels)
          .where(
            and(
              eq(dataLabels.workspaceId, ws),
              eq(dataLabels.resourceType, "agent"),
              eq(dataLabels.resourceId, agentId),
            ),
          );
        const rank = { public: 0, private: 1, secret: 2 };
        const stronger =
          !current ||
          (rank[row.label as keyof typeof rank] ?? 2) >
            (rank[current.label as keyof typeof rank] ?? 2);
        await this.label(
          ws,
          "agent",
          agentId,
          stronger ? (row.label as "private" | "secret") : (current!.label as "private" | "secret"),
          current
            ? current.destinations.filter((x) => row.destinations.includes(x))
            : row.destinations.filter((x) => !x.startsWith("agent:")),
        );
      }
    }
  }
  async command(ws: string, agentId: string, command: string) {
    await this.observe(ws, command);
    for (const destination of extractTargets(command))
      await this.check(ws, "agent", agentId, destination);
  }
  async model(ws: string, agentId: string | null, text: string) {
    await this.observe(ws, text);
    if (!agentId) return "normal" as const;
    const [row] = await this.s.db.db
      .select()
      .from(dataLabels)
      .where(
        and(
          eq(dataLabels.workspaceId, ws),
          eq(dataLabels.resourceType, "agent"),
          eq(dataLabels.resourceId, agentId),
        ),
      );
    return row && row.label !== "public" ? ("sensitive" as const) : ("normal" as const);
  }
  async createCanary(ws: string, name: string) {
    const token = `nb_canary_${randomBytes(24).toString("hex")}`;
    const [row] = await this.s.db.db
      .insert(canaryTokens)
      .values({
        workspaceId: ws,
        name,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      })
      .returning();
    return { id: row!.id, token };
  }
  async observe(ws: string | null, text: string) {
    for (const token of new Set(text.match(/nb_canary_[a-f0-9]{48}/g) ?? [])) {
      const rows = await this.s.db.db
        .update(canaryTokens)
        .set({ triggeredAt: new Date() })
        .where(
          and(
            eq(canaryTokens.tokenHash, createHash("sha256").update(token).digest("hex")),
            ws ? eq(canaryTokens.workspaceId, ws) : undefined,
            isNull(canaryTokens.triggeredAt),
          ),
        )
        .returning();
      for (const row of rows)
        await this.alert(
          row.workspaceId,
          "canary_triggered",
          row.id,
          "A canary token was used. Review recent activity.",
        );
    }
  }
  async alert(ws: string, code: string, id: string | null, summary: string) {
    await this.s.events.write(ws, {
      type: "security.alert",
      payload: { code, resourceId: id, summary },
    });
    await this.s.db.db
      .insert(notifications)
      .values({ workspaceId: ws, kind: "security.alert", body: summary });
  }
  async egress(ws: string) {
    return this.s.db.pool
      .query(
        "select agent_id, payload->>'host' host, count(*)::int connections, max(ts) last_seen, count(*) filter(where payload->>'status'='error')::int failures from events where workspace_id=$1 and type='egress' group by 1,2 order by last_seen desc limit 200",
        [ws],
      )
      .then((r) => r.rows);
  }
  async labels(ws: string) {
    return this.s.db.db.select().from(dataLabels).where(eq(dataLabels.workspaceId, ws));
  }
  async file(ws: string, id: string) {
    return (
      await this.s.db.db
        .select()
        .from(files)
        .where(and(eq(files.workspaceId, ws), eq(files.id, id)))
    )[0];
  }
  async alerts(ws: string) {
    return this.s.db.db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, ws), eq(events.type, "security.alert")))
      .limit(100);
  }
}
