import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Key/value table for workspace-wide metadata (schema version, install id). */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
