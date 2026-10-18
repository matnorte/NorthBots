import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ErrorBody, WorkspaceSettings } from "@northbot/shared";
import { me } from "../auth/guard.js";
import type { DbHandle } from "../db/client.js";
import { agents, workspaces } from "../db/schema.js";
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

/** Settings kept in workspaces.settings.prefs (everything but the name, timezone and locale columns). */
type Prefs = Partial<Omit<WorkspaceSettings, "name" | "timezone" | "locale">>;

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
    coordinatorAgentId: prefs.coordinatorAgentId ?? null,
    ideaBinDays: prefs.ideaBinDays ?? 30,
  };
}

export const settingsRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["settings"];
  app.addHook("preHandler", s.auth);

  app.get("/settings", { schema: { tags, response: { 200: WorkspaceSettings } } }, async (req) => readSettings(s.db, me(req).workspaceId));

  app.patch(
    "/settings",
    { schema: { tags, body: Patch, response: { 200: WorkspaceSettings, 400: ErrorBody } } },
    async (req, reply) => {
      const m = me(req);
      const { name, timezone, locale, ...rest } = req.body;
      const columns = Object.fromEntries(Object.entries({ name, timezone, locale }).filter(([, v]) => v !== undefined));
      const prefs = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Prefs;
      const changed = Object.keys(req.body);
      if (prefs.coordinatorAgentId) {
        const [agent] = await s.db.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, prefs.coordinatorAgentId), eq(agents.workspaceId, m.workspaceId)));
        if (!agent) return reply.code(400).send({ error: "bad_agent", message: "The coordinator must be one of your agents." });
      }
      if (Object.keys(columns).length > 0) {
        await s.db.db.update(workspaces).set(columns).where(eq(workspaces.id, m.workspaceId));
      }
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
