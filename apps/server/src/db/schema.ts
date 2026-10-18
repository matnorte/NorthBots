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
    /** Room whose board the task is on (M7). */
    roomId: uuid("room_id"),
    /** Letter the task answers; its report goes back as a reply letter (M7). */
    letterId: uuid("letter_id"),
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

/** pgvector column without a fixed size; rows carry the embedding model that produced them. */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (s) => JSON.parse(s) as number[],
});

export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Null = shared memory; otherwise private to this agent. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    sourceEventId: bigint("source_event_id", { mode: "number" }),
    source: text("source"),
    /** Facts this one was derived from; forgetting all of them forgets this too. */
    derivedFrom: uuid("derived_from").array().notNull().default(sql`'{}'::uuid[]`),
    embedding: vector("embedding").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: tsz("created_at").notNull().defaultNow(),
    expiresAt: tsz("expires_at"),
  },
  (t) => [index("facts_scope").on(t.workspaceId, t.agentId)],
);

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Null = every agent can use it. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    activeVersion: integer("active_version"),
    embedding: vector("embedding").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("skills_name").on(t.workspaceId, t.name)],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    files: jsonb("files").$type<Record<string, string>>().notNull(),
    /** draft | approved | rejected */
    status: text("status").notNull().default("draft"),
    /** repeated | corrected | demonstrated | human */
    trigger: text("trigger").notNull(),
    exampleTaskId: uuid("example_task_id"),
    /** Most an agent can do with it (read/write/send/...), from its scripts. */
    rights: text("rights").notNull(),
    scan: jsonb("scan").$type<Record<string, unknown>>().notNull(),
    dryRun: jsonb("dry_run").$type<Record<string, unknown>>(),
    diff: text("diff").notNull().default(""),
    createdBy: text("created_by").notNull(),
    decidedBy: uuid("decided_by"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    decidedAt: tsz("decided_at"),
  },
  (t) => [uniqueIndex("skill_versions_v").on(t.skillId, t.version)],
);

/** Group chats with humans and agents (M7). Talks run in a room of kind "talk". */
export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    goal: text("goal").notNull().default(""),
    /** The pinned brief every agent sees first. */
    brief: text("brief").notNull().default(""),
    /** room | talk */
    kind: text("kind").notNull().default("room"),
    coordinatorAgentId: uuid("coordinator_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** coordinator | mentions */
    turnRule: text("turn_rule").notNull().default("coordinator"),
    costCapUsd: numeric("cost_cap_usd", { precision: 12, scale: 4 }).notNull().default("1"),
    spentUsd: numeric("spent_usd", { precision: 12, scale: 4 }).notNull().default("0"),
    /** open | closed */
    status: text("status").notNull().default("open"),
    createdBy: uuid("created_by"),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [index("rooms_workspace").on(t.workspaceId, t.createdAt)],
);

export const roomMembers = pgTable(
  "room_members",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** member | coordinator | presenter | dissenter | listener */
    role: text("role").notNull().default("member"),
  },
  (t) => [uniqueIndex("room_members_pk").on(t.roomId, t.agentId)],
);

export const roomMessages = pgTable(
  "room_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /** user | agent | system */
    authorKind: text("author_kind").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    userId: uuid("user_id"),
    content: text("content").notNull(),
    /** message | slide | question | answer | challenge | vote | decision | quiz | task */
    kind: text("kind").notNull().default("message"),
    mentions: uuid("mentions").array().notNull().default(sql`'{}'::uuid[]`),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [index("room_messages_room").on(t.roomId, t.createdAt)],
);

/** Letters: requests, questions, ideas, urgent notes and FYIs, routed by the mail agent. */
export const letters = pgTable(
  "letters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** request | question | idea | urgent | fyi */
    type: text("type").notNull(),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull(),
    attachments: jsonb("attachments").$type<{ id: string; name: string; size: number; mime: string }[]>().notNull().default(sql`'[]'::jsonb`),
    /** user | agent | system */
    fromKind: text("from_kind").notNull(),
    fromAgentId: uuid("from_agent_id").references(() => agents.id, { onDelete: "set null" }),
    fromUserId: uuid("from_user_id"),
    /** Who it went to: an agent, or the humans (to_agent_id null). */
    toAgentId: uuid("to_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** new | routed | needs_human | answered | delivered */
    status: text("status").notNull().default("new"),
    /** The mail agent's stamp: who handled it and why, with confidence and candidate scores. */
    stamp: jsonb("stamp").$type<Record<string, unknown>>(),
    replyToId: uuid("reply_to_id"),
    taskId: uuid("task_id"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    readAt: tsz("read_at"),
  },
  (t) => [index("letters_workspace").on(t.workspaceId, t.createdAt)],
);

/** The idea bin: tossed ideas wait here (30 days by default) until restored or a trigger fires. */
export const ideas = pgTable(
  "ideas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    /** When it should come back: { kind: "after", at } | { kind: "memory", text } | { kind: "event", type, contains? } */
    trigger: jsonb("trigger").$type<Record<string, unknown>>(),
    /** binned | restored | expired */
    status: text("status").notNull().default("binned"),
    sourceTaskId: uuid("source_task_id"),
    tossedAt: tsz("tossed_at").notNull().defaultNow(),
    expiresAt: tsz("expires_at").notNull(),
    restoredAt: tsz("restored_at"),
    /** "bin-picker" or a user id */
    restoredBy: text("restored_by"),
    restoreNote: text("restore_note"),
  },
  (t) => [index("ideas_workspace").on(t.workspaceId, t.status)],
);

/** Talks: a presenter, an audience and a budget, through brief → … → decision record. */
export const talks = pgTable("talks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  question: text("question").notNull(),
  presenterAgentId: uuid("presenter_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  dissenterAgentId: uuid("dissenter_agent_id").references(() => agents.id, { onDelete: "set null" }),
  audience: uuid("audience").array().notNull().default(sql`'{}'::uuid[]`),
  /** vote | human */
  decisionMode: text("decision_mode").notNull().default("vote"),
  budgetUsd: numeric("budget_usd", { precision: 12, scale: 4 }).notNull().default("1"),
  spentUsd: numeric("spent_usd", { precision: 12, scale: 4 }).notNull().default("0"),
  /** brief | prepare | present | qa | challenge | decide | record | learn | done | stopped */
  stage: text("stage").notNull().default("brief"),
  deck: jsonb("deck").$type<Record<string, unknown>>(),
  qa: jsonb("qa").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
  challenge: jsonb("challenge").$type<Record<string, unknown>>(),
  votes: jsonb("votes").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
  decision: jsonb("decision").$type<Record<string, unknown>>(),
  error: text("error"),
  createdBy: uuid("created_by"),
  createdAt: tsz("created_at").notNull().defaultNow(),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
});
