import type { Services } from "../services.js";
import { jsonArray, scanRows, matching } from "./stream.js";
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
  private rows(ws: string, query: string, source: (typeof SOURCES)[number]) {
    const key = "key" in source ? source.key : "id";
    const projection = source.columns.map((c) => `'${c}',${c}`).join(",");
    const rows = scanRows(
      async (after: string | undefined) =>
        (
          await this.s.db.pool.query<{ id: string; data: Record<string, unknown> }>(
            `select ${key} as id,jsonb_build_object(${projection}) data from ${source.table} where ${source.scope}${after === undefined ? "" : ` and ${key}>$2`} order by ${key} limit 100`,
            after === undefined ? [ws] : [ws, after],
          )
        ).rows,
    );
    return matching(rows, (r) =>
      JSON.stringify(r.data).toLowerCase().includes(query.toLowerCase()),
    );
  }
  async *json(ws: string, query: string) {
    yield "{";
    let first = true;
    for (const source of SOURCES) {
      yield `${first ? "" : ","}${JSON.stringify(source.table)}:`;
      yield* jsonArray(this.rows(ws, query, source));
      first = false;
    }
    yield "}";
  }
  async erase(ws: string, query: string) {
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
      counts[source.table] = 0;
      for await (const row of this.rows(ws, query, source)) {
        const data = Object.fromEntries(source.columns.map((c) => [c, redact(row.data[c])]));
        // A single JSON parameter preserves arrays/objects and lets PostgreSQL restore each
        // allowlisted column's actual type. pg otherwise encodes JS arrays as SQL arrays.
        const set = source.columns
          .map((c) => `${c}=(jsonb_populate_record(null::${source.table},$2::jsonb)).${c}`)
          .join(",");
        await this.s.db.pool.query(
          `update ${source.table} set ${set}${"pause" in source ? `,${source.pause}` : ""} where ${"key" in source ? source.key : "id"}=$3 and ${source.scope}`,
          [ws, JSON.stringify(data), row.id],
        );
        counts[source.table] = (counts[source.table] ?? 0) + 1;
      }
    }
    return counts;
  }
}
