import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { tasks } from "../db/schema.js";
import type { Services } from "../services.js";
import { SkillError } from "./service.js";

const Files = z.record(z.string().max(100_000)).refine((f) => Object.keys(f).length <= 20, "at most 20 files");
const Version = z.object({
  version: z.number().int(),
  status: z.string(),
  trigger: z.string(),
  rights: z.string(),
  files: z.record(z.string()),
  scan: z.record(z.unknown()),
  dryRun: z.record(z.unknown()).nullable(),
  diff: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
});
const SkillInfo = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  name: z.string(),
  description: z.string(),
  activeVersion: z.number().int().nullable(),
  versions: z.array(Version),
});
const SkillParams = z.object({ id: z.string().uuid() });
const Findings = ErrorBody.extend({ findings: z.array(z.record(z.unknown())).optional() });

/** Skills: review cards for drafts (approve / edit / reject), versions, rollback, and teaching. */
export const skillRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["skills"];
  app.addHook("preHandler", s.auth);

  app.get("/skills", { schema: { tags, response: { 200: z.object({ skills: z.array(SkillInfo) }) } } }, async (req) => ({
    skills: (await s.skills.list(me(req).workspaceId)).map(({ skill, versions }) => ({
      id: skill.id,
      agentId: skill.agentId,
      name: skill.name,
      description: skill.description,
      activeVersion: skill.activeVersion,
      versions: versions.map((v) => ({
        version: v.version,
        status: v.status,
        trigger: v.trigger,
        rights: v.rights,
        files: v.files,
        scan: v.scan,
        dryRun: v.dryRun,
        diff: v.diff,
        createdBy: v.createdBy,
        createdAt: v.createdAt.toISOString(),
      })),
    })),
  }));

  app.post(
    "/skills",
    {
      schema: {
        tags,
        description: "Add a skill written by a human (SKILL.md + scripts). It is scanned for hidden instructions and secrets first.",
        body: z.object({ files: Files, agentId: z.string().uuid().nullable().default(null) }),
        response: { 201: z.object({ skillId: z.string().uuid(), version: z.number().int() }), 422: Findings },
      },
    },
    async (req, reply) => {
      const m = me(req);
      try {
        const r = await s.skills.addVersion({ workspaceId: m.workspaceId, agentId: req.body.agentId, files: req.body.files, trigger: "human", createdBy: m.userId, status: "approved" });
        await s.events.write(m.workspaceId, { type: "skill.approved", agentId: req.body.agentId, payload: { skillId: r.skill.id, version: r.version.version, userId: m.userId } });
        return reply.code(201).send({ skillId: r.skill.id, version: r.version.version });
      } catch (err) {
        if (err instanceof SkillError) return reply.code(422).send({ error: "skill_rejected", message: err.message, findings: err.findings as Record<string, unknown>[] });
        throw err;
      }
    },
  );

  app.post(
    "/skills/:id/versions/:version/decide",
    {
      schema: {
        tags,
        description: "Review card: approve (optionally with edited files, saved as a new version) or reject a draft.",
        params: SkillParams.extend({ version: z.coerce.number().int().positive() }),
        body: z.object({ decision: z.enum(["approve", "reject"]), files: Files.optional() }),
        response: { 200: z.object({ version: z.number().int() }), 404: ErrorBody, 422: Findings },
      },
    },
    async (req, reply) => {
      const m = me(req);
      try {
        const r = await s.skills.decide(m.workspaceId, req.params.id, req.params.version, req.body.decision, m.userId, req.body.files);
        if (!r) return reply.code(404).send({ error: "not_found", message: "No draft with that version." });
        return r;
      } catch (err) {
        if (err instanceof SkillError) return reply.code(422).send({ error: "skill_rejected", message: err.message, findings: err.findings as Record<string, unknown>[] });
        throw err;
      }
    },
  );

  app.post(
    "/skills/:id/rollback",
    { schema: { tags, params: SkillParams, body: z.object({ version: z.number().int().positive() }), response: { 200: z.object({ ok: z.boolean() }), 404: ErrorBody } } },
    async (req, reply) => {
      const m = me(req);
      if (!(await s.skills.rollback(m.workspaceId, req.params.id, req.body.version, m.userId))) {
        return reply.code(404).send({ error: "not_found", message: "No approved version with that number." });
      }
      return { ok: true };
    },
  );

  app.post(
    "/skills/teach",
    {
      schema: {
        tags,
        description: "Demonstrated routine: turn a finished task into a skill draft.",
        body: z.object({ taskId: z.string().uuid() }),
        response: { 200: z.object({ drafted: z.boolean(), reason: z.string(), skillId: z.string().uuid().optional(), version: z.number().int().optional() }), 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const [task] = await s.db.db.select().from(tasks).where(and(eq(tasks.id, req.body.taskId), eq(tasks.workspaceId, m.workspaceId)));
      if (!task || task.status !== "done") return reply.code(404).send({ error: "not_found", message: "No finished task with that id." });
      return s.skills.draftFrom(task, "demonstrated");
    },
  );
};
