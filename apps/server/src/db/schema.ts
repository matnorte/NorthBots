import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const tsz = (name: string) => timestamp(name, { withTimezone: true });

/** Key/value table for workspace-wide metadata (schema version, install id). */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/Sao_Paulo"),
  locale: text("locale").notNull().default("en"),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  /** When set, the kill switch is on: every agent is stopped and no task may start. */
  killSwitchAt: tsz("kill_switch_at"),
  createdAt: tsz("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("owner"),
  createdAt: tsz("created_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  /** sha256 of the cookie token; the token itself is never stored. */
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: tsz("expires_at").notNull(),
  createdAt: tsz("created_at").notNull().defaultNow(),
});

export const passkeys = pgTable("passkeys", {
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  publicKey: bytea("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  transports: jsonb("transports").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: tsz("created_at").notNull().defaultNow(),
});

export const webauthnChallenges = pgTable("webauthn_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  challenge: text("challenge").notNull(),
  expiresAt: tsz("expires_at").notNull(),
});

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nonce: bytea("nonce").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("secrets_workspace_name").on(t.workspaceId, t.name)],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: tsz("ts").notNull().defaultNow(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id"),
    roomId: uuid("room_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }).notNull().default("0"),
  },
  (t) => [
    index("events_workspace_id").on(t.workspaceId, t.id),
    index("events_agent_id").on(t.agentId, t.id),
    index("events_type").on(t.type),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameLocked: boolean("name_locked").notNull().default(false),
    avatar: jsonb("avatar").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    persona: jsonb("persona").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** e.g. { model: "northbot-smart", privacy: "normal" } */
    modelPolicy: jsonb("model_policy").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    autonomyLevel: text("autonomy_level").notNull().default("ask_first"),
    budgetDailyUsd: numeric("budget_daily_usd", { precision: 12, scale: 4 }).notNull().default("1"),
    status: text("status").notNull().default("idle"),
    sandboxId: text("sandbox_id"),
    mood: text("mood").notNull().default("content"),
    /** Per-agent off switch for moods (the workspace has a global one in settings). */
    moodsEnabled: boolean("moods_enabled").notNull().default(true),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agents_workspace_name").on(t.workspaceId, sql`lower(${t.name})`)],
);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** First characters of the key, shown in the UI so people can tell keys apart. */
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  dailyBudgetUsd: numeric("daily_budget_usd", { precision: 12, scale: 4 }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: tsz("created_at").notNull().defaultNow(),
  lastUsedAt: tsz("last_used_at"),
  revokedAt: tsz("revoked_at"),
});

export const sandboxes = pgTable("sandboxes", {
  id: text("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  driver: text("driver").notNull(),
  containerId: text("container_id"),
  state: text("state").notNull().default("running"),
  /** sha256 of the egress proxy password given to this computer. */
  egressTokenHash: text("egress_token_hash").notNull(),
  createdAt: tsz("created_at").notNull().defaultNow(),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    goal: text("goal").notNull(),
    /** queued | running | waiting_approval | done | failed | killed | blocked */
    status: text("status").notNull().default("queued"),
    createdBy: text("created_by").notNull().default("user"),
    userId: uuid("user_id"),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 4 }),
    /** The runner's resumable state (messages, plan, counters). */
    state: jsonb("state").$type<Record<string, unknown>>(),
    report: jsonb("report").$type<Record<string, unknown>>(),
    error: text("error"),
    /** Set by schedules (M9): the same key never creates a second task. */
    idempotencyKey: text("idempotency_key").unique(),
    /** Optional due time; a near deadline makes the agent overwhelmed. */
    deadline: tsz("deadline"),
    /** Chat thread the task came from; its report is posted back there. */
    threadId: uuid("thread_id"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
    finishedAt: tsz("finished_at"),
  },
  (t) => [index("tasks_agent").on(t.agentId, t.createdAt), index("tasks_status").on(t.status)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    reason: text("reason").notNull(),
    action: jsonb("action").$type<Record<string, unknown>>().notNull(),
    /** pending | approved | denied | cancelled */
    status: text("status").notNull().default("pending"),
    decision: text("decision"),
    decidedBy: uuid("decided_by"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    decidedAt: tsz("decided_at"),
  },
  (t) => [index("approvals_pending").on(t.workspaceId, t.status)],
);

export const permissionRules = pgTable("permission_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Null = applies to every agent in the workspace. */
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  rule: jsonb("rule").$type<Record<string, unknown>>().notNull(),
  source: text("source").notNull().default("user"),
  createdBy: uuid("created_by"),
  createdAt: tsz("created_at").notNull().defaultNow(),
});

/** Idempotency ledger: a write/spend/send/delete/login action runs at most once per key. */
export const actions = pgTable("actions", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  taskId: uuid("task_id"),
  summary: text("summary").notNull(),
  /** started | done | failed */
  status: text("status").notNull().default("started"),
  result: text("result"),
  createdAt: tsz("created_at").notNull().defaultNow(),
  finishedAt: tsz("finished_at"),
});

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: tsz("created_at").notNull().defaultNow(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("threads_agent").on(t.agentId, t.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** user | agent | system */
    role: text("role").notNull(),
    content: text("content").notNull(),
    attachments: jsonb("attachments").$type<{ id: string; name: string; size: number; mime: string }[]>().notNull().default(sql`'[]'::jsonb`),
    taskId: uuid("task_id"),
    userId: uuid("user_id"),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [index("messages_thread").on(t.threadId, t.createdAt)],
);

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  data: bytea("data").notNull(),
  uploadedBy: uuid("uploaded_by"),
  createdAt: tsz("created_at").notNull().defaultNow(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    /** Held back until this time during quiet hours. */
    deliverAt: tsz("deliver_at").notNull().defaultNow(),
    readAt: tsz("read_at"),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [index("notifications_ws").on(t.workspaceId, t.deliverAt)],
);
