import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ErrorBody, WorkspaceSettings } from "@northbot/shared";
import { me } from "../auth/guard.js";
import type { DbHandle } from "../db/client.js";
import { workspaces } from "../db/schema.js";
import type { Services } from "../services.js";

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const Patch = WorkspaceSettings.partial().refine((v) => !v.timezone || isValidTimezone(v.timezone), {
  message: "unknown timezone",
  path: ["timezone"],
});

interface Prefs {
  moodsEnabled?: boolean;
  quietHours?: WorkspaceSettings["quietHours"];
}

export async function readSettings(db: DbHandle, workspaceId: string): Promise<WorkspaceSettings> {
  const [ws] = await db.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new Error("workspace missing");
  const prefs = ((ws.settings as { prefs?: Prefs }).prefs ?? {}) as Prefs;
  return {
    name: ws.name,
    timezone: ws.timezone,
    locale: ws.locale as WorkspaceSettings["locale"],
    moodsEnabled: prefs.moodsEnabled ?? true,
    // null means "no quiet hours"; only a missing value falls back to the default.
    quietHours: prefs.quietHours === undefined ? { start: "22:00", end: "08:00" } : prefs.quietHours,
  };
}

export const settingsRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["settings"];
  app.addHook("preHandler", s.auth);

  app.get("/settings", { schema: { tags, response: { 200: WorkspaceSettings } } }, async (req) => readSettings(s.db, me(req).workspaceId));

  app.patch(
    "/settings",
    { schema: { tags, body: Patch, response: { 200: WorkspaceSettings, 400: ErrorBody } } },
    async (req) => {
      const m = me(req);
      const { moodsEnabled, quietHours, ...columns } = req.body;
      const changed = Object.keys(req.body);
      if (Object.keys(columns).length > 0) {
        await s.db.db.update(workspaces).set(columns).where(eq(workspaces.id, m.workspaceId));
      }
      const prefs: Prefs = {};
      if (moodsEnabled !== undefined) prefs.moodsEnabled = moodsEnabled;
      if (quietHours !== undefined) prefs.quietHours = quietHours;
      if (Object.keys(prefs).length > 0) {
        await s.db.db
          .update(workspaces)
          .set({ settings: sql`jsonb_set(${workspaces.settings}, '{prefs}', coalesce(${workspaces.settings}->'prefs', '{}'::jsonb) || ${JSON.stringify(prefs)}::jsonb)` })
          .where(eq(workspaces.id, m.workspaceId));
      }
      if (changed.length > 0) {
        await s.events.write(m.workspaceId, { type: "settings.updated", payload: { userId: m.userId, changed } });
      }
      return readSettings(s.db, m.workspaceId);
    },
  );
};
