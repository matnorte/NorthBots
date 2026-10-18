import type { Services } from "../services.js";
/** Fixed table/column allowlist: personal-data requests never interpolate user-controlled SQL. */
const SOURCES = [
  {
    table: "room_messages",
    scope: "room_id in (select id from rooms where workspace_id=$1)",
    columns: ["content", "meta"],
  },
  {
    table: "letters",
    scope: "workspace_id=$1",
    columns: ["subject", "body", "attachments", "stamp"],
  },
  {
    table: "ideas",
    scope: "workspace_id=$1",
    columns: ["title", "reason", "trigger", "restore_note"],
  },
  {
    table: "talks",
    scope: "workspace_id=$1",
    columns: ["title", "question", "deck", "qa", "challenge", "votes", "decision", "error"],
  },
  {
    table: "schedules",
    scope: "workspace_id=$1",
    columns: ["definition"],
    pause: "enabled=false,approved_hash=null",
  },
  {
    table: "skills",
    scope: "workspace_id=$1",
    columns: ["name", "description"],
    pause: "active_version=null",
  },
  {
    table: "skill_versions",
    scope: "skill_id in (select id from skills where workspace_id=$1)",
    columns: ["files", "scan", "dry_run", "diff"],
    pause: "status='draft'",
  },
  { table: "security_recordings", scope: "workspace_id=$1", columns: ["frames"] },
  {
    table: "approvals",
    scope: "workspace_id=$1",
    columns: ["summary", "reason", "action"],
    pause: "status='cancelled'",
  },
  {
    table: "actions",
    key: "idempotency_key",
    scope: "workspace_id=$1",
    columns: ["summary", "result"],
  },
] as const;
export class PersonRecords {
  constructor(private s: Pick<Services, "db" | "computers">) {}
  async find(ws: string, query: string) {
    const result: Record<string, { id: string; data: Record<string, unknown> }[]> = {};
    for (const source of SOURCES) {
      const projection = source.columns.map((c) => `'${c}',${c}`).join(",");
      const rows = await this.s.db.pool.query<{ id: string; data: Record<string, unknown> }>(
        `select ${"key" in source ? source.key : "id"} as id,jsonb_build_object(${projection}) data from ${source.table} where ${source.scope}`,
        [ws],
      );
      result[source.table] = rows.rows.filter((r) =>
        JSON.stringify(r.data).toLowerCase().includes(query.toLowerCase()),
      );
    }
    return result;
  }
  async erase(ws: string, query: string, found: Awaited<ReturnType<PersonRecords["find"]>>) {
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const redact = (value: unknown): unknown =>
      typeof value === "string"
        ? value.replace(pattern, "[Erased]")
        : Array.isArray(value)
          ? value.map(redact)
          : value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]))
            : value;
    const counts: Record<string, number> = {};
    for (const source of SOURCES) {
      const rows = found[source.table] ?? [];
      counts[source.table] = rows.length;
      for (const row of rows) {
        const values = source.columns.map((c) => redact(row.data[c]));
        const set = source.columns.map((c, i) => `${c}=$${i + 2}`).join(",");
        await this.s.db.pool.query(
          `update ${source.table} set ${set}${"pause" in source ? `,${source.pause}` : ""} where ${"key" in source ? source.key : "id"}=$${values.length + 2} and ${source.scope}`,
          [ws, ...values, row.id],
        );
      }
    }
    return counts;
  }
}
