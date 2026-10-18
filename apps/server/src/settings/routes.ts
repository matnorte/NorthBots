import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ErrorBody, WorkspaceSettings } from "@northbot/shared";
import { me } from "../auth/guard.js";
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

export const settingsRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["settings"];
  app.addHook("preHandler", s.auth);

  const read = async (workspaceId: string) => {
    const [ws] = await s.db.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!ws) throw new Error("workspace missing");
    return { name: ws.name, timezone: ws.timezone, locale: ws.locale as WorkspaceSettings["locale"] };
  };

  app.get("/settings", { schema: { tags, response: { 200: WorkspaceSettings } } }, async (req) =>
    read(me(req).workspaceId),
  );

  app.patch(
    "/settings",
    { schema: { tags, body: Patch, response: { 200: WorkspaceSettings, 400: ErrorBody } } },
    async (req) => {
      const m = me(req);
      const changed = Object.keys(req.body);
      if (changed.length > 0) {
        await s.db.db.update(workspaces).set(req.body).where(eq(workspaces.id, m.workspaceId));
        await s.events.write(m.workspaceId, {
          type: "settings.updated",
          payload: { userId: m.userId, changed },
        });
      }
      return read(m.workspaceId);
    },
  );
};
