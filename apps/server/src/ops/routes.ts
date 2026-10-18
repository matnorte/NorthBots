import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { incidents } from "../db/schema.js";
import type { Services } from "../services.js";
import { KillSwitchOnError } from "../tasks/service.js";

const IdParams = z.object({ id: z.string().uuid() });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Health dashboard, canary checks, dead letters, run history, incidents, and the status page. */
export const opsRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["operations"];

  // ---- Public status page: only whether the instance is healthy, never workspace data ----
  app.get(
    "/status.json",
    { schema: { tags, description: "Public instance status (no workspace data)." } },
    async () => s.ops.status(),
  );

  app.get("/status", { schema: { tags, hide: true } }, async (_req, reply) => {
    const st = await s.ops.status();
    const color =
      st.status === "operational" ? "#7fd8a6" : st.status === "degraded" ? "#ff6b8b" : "#f2d58a";
    const bars = st.history
      .map(
        (h) =>
          `<span title="${esc(h.at)}" style="background:${h.ok ? "#7fd8a6" : "#ff6b8b"}"></span>`,
      )
      .join("");
    const rows = st.checks
      .map(
        (c) =>
          `<li><span>${esc(c.name.replace(/_/g, " "))}</span><b style="color:${c.ok ? "#7fd8a6" : "#ff6b8b"}">${c.ok ? "OK" : "Failing"}</b></li>`,
      )
      .join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60"><title>NorthBot status</title>
<style>:root{color-scheme:dark}body{margin:0;font-family:system-ui,sans-serif;background:#0b0b0e;color:#e9e9ee;display:grid;place-items:center;min-height:100vh}main{width:min(560px,100% - 32px)}h1{font-size:1.4rem}.pill{display:inline-block;padding:.3rem .8rem;border-radius:999px;background:${color};color:#0b0b0e;font-weight:700}ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid #33333d}.bars{display:flex;gap:2px;height:28px;margin:1rem 0}.bars span{flex:1;border-radius:2px}small{color:#9a9aa8}</style></head>
<body><main><h1>NorthBot status</h1><p><span class="pill">${esc(st.status)}</span></p><div class="bars" aria-label="recent checks">${bars}</div><ul>${rows || "<li>No checks yet.</li>"}</ul><small>Version ${esc(st.version)} · last check ${esc(st.lastCheckAt ?? "never")} · up ${Math.round(st.uptimeSeconds / 60)} min</small></main></body></html>`;
    return reply.type("text/html; charset=utf-8").send(html);
  });

  await app.register(async (child) => {
    const ui = child.withTypeProvider<ZodTypeProvider>();
    ui.addHook("preHandler", s.auth);

    ui.get(
      "/ops/health",
      { schema: { tags, description: "Health dashboard for this workspace." } },
      async (req) => s.ops.health(me(req).workspaceId),
    );

    ui.post(
      "/ops/canary",
      { schema: { tags, description: "Run the canary checks now (they also run on a timer)." } },
      async () => s.ops.canary(),
    );

    ui.get(
      "/ops/dead-letters",
      {
        schema: {
          tags,
          querystring: z.object({
            status: z.enum(["open", "retried", "dismissed"]).default("open"),
          }),
        },
      },
      async (req) => ({
        deadLetters: (await s.ops.deadLetters(me(req).workspaceId, req.query.status)).map((d) => ({
          ...d,
          createdAt: d.createdAt.toISOString(),
          resolvedAt: d.resolvedAt?.toISOString() ?? null,
        })),
      }),
    );

    ui.post(
      "/ops/dead-letters/:id/retry",
      {
        schema: {
          tags,
          params: IdParams,
          response: {
            200: z.object({ retriedAs: z.string().uuid() }),
            404: ErrorBody,
            409: ErrorBody,
          },
        },
      },
      async (req, reply) => {
        const m = me(req);
        try {
          const r = await s.ops.retry(m.workspaceId, req.params.id, m.userId);
          if (!r)
            return reply
              .code(404)
              .send({ error: "not_found", message: "No open dead letter with that id." });
          return r;
        } catch (err) {
          if (
            err instanceof KillSwitchOnError ||
            (err instanceof Error && /kill switch/i.test(err.message))
          )
            return reply.code(409).send({ error: "kill_switch", message: err.message });
          throw err;
        }
      },
    );

    ui.post(
      "/ops/dead-letters/:id/dismiss",
      { schema: { tags, params: IdParams, response: { 200: z.object({ ok: z.boolean() }) } } },
      async (req) => ({
        ok: await s.ops.dismiss(me(req).workspaceId, req.params.id),
      }),
    );

    ui.get(
      "/ops/runs",
      {
        schema: {
          tags,
          description:
            "Searchable run history: tasks (goal, report, error) and the routines that started them.",
          querystring: z.object({
            q: z.string().max(200).optional(),
            status: z.string().max(30).optional(),
            agentId: z.string().uuid().optional(),
            from: z.string().datetime().optional(),
            to: z.string().datetime().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
        },
      },
      async (req) => {
        const q = req.query;
        return {
          runs: await s.ops.runs(me(req).workspaceId, {
            text: q.q,
            status: q.status,
            agentId: q.agentId,
            from: q.from ? new Date(q.from) : undefined,
            to: q.to ? new Date(q.to) : undefined,
            limit: q.limit,
          }),
        };
      },
    );

    ui.get("/ops/incidents", { schema: { tags } }, async (req) => ({
      incidents: (await s.ops.incidents(me(req).workspaceId)).map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        fromAt: i.fromAt.toISOString(),
        toAt: i.toAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
      })),
    }));

    ui.post(
      "/ops/incidents",
      {
        schema: {
          tags,
          description:
            "Generate an incident report from the event log between two moments (default: the last 24 hours).",
          body: z.object({
            title: z.string().max(120).optional(),
            from: z.string().datetime().optional(),
            to: z.string().datetime().optional(),
          }),
          response: {
            201: z.object({
              id: z.string().uuid(),
              title: z.string(),
              severity: z.string(),
              markdown: z.string(),
            }),
            400: ErrorBody,
          },
        },
      },
      async (req, reply) => {
        const m = me(req);
        const to = req.body.to ? new Date(req.body.to) : new Date();
        const from = req.body.from ? new Date(req.body.from) : new Date(to.getTime() - 86_400_000);
        if (from >= to)
          return reply
            .code(400)
            .send({ error: "bad_window", message: "The start must be before the end." });
        const r = await s.ops.incident(m.workspaceId, {
          from,
          to,
          title: req.body.title,
          userId: m.userId,
        });
        return reply
          .code(201)
          .send({ id: r.id, title: r.title, severity: r.severity, markdown: r.markdown });
      },
    );

    ui.get("/ops/incidents/:id.md", { schema: { tags, params: IdParams } }, async (req, reply) => {
      const [i] = await s.db.db
        .select()
        .from(incidents)
        .where(
          and(eq(incidents.id, req.params.id), eq(incidents.workspaceId, me(req).workspaceId)),
        );
      if (!i) return reply.code(404).send({ error: "not_found", message: "No such incident." });
      return reply
        .type("text/markdown; charset=utf-8")
        .header("content-disposition", `attachment; filename="incident-${i.id.slice(0, 8)}.md"`)
        .send(i.markdown);
    });
  });
};
