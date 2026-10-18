import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bigserial,
  customType,
  index,
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
