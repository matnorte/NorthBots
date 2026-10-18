import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentInfo, AgentName, Avatar, ErrorBody } from "@northbot/shared";
import { createAgent } from "../agents/create.js";
import { agentInfo } from "../agents/routes.js";
import { me } from "../auth/guard.js";
import type { Services } from "../services.js";
import { nameMessage, proposeNames, validateName } from "./naming.js";

/** Answers to the hatching questions ("snacks"); each maps to how the agent behaves. */
export const Personality = z.object({
  tone: z.enum(["warm", "playful", "calm", "precise"]).default("warm"),
  pace: z.enum(["careful", "balanced", "quick"]).default("balanced"),
  checkins: z.enum(["often", "sometimes", "rarely"]).default("sometimes"),
  extra: z.array(z.string().max(80)).max(3).default([]),
});
type Personality = z.infer<typeof Personality>;

const Goal = z.string().trim().min(3).max(500);

export function personaFrom(goal: string, p: Personality) {
  const tone = { warm: "warm and kind", playful: "playful and upbeat", calm: "calm and steady", precise: "precise and to the point" }[p.tone];
  const pace = { careful: "double-checks before acting", balanced: "works at a steady pace", quick: "moves fast on simple things" }[p.pace];
  const checkins = { often: "checks in often", sometimes: "checks in when it matters", rarely: "only checks in when needed" }[p.checkins];
  return { summary: `${tone}; ${pace}; ${checkins}.${p.extra.length ? ` Also: ${p.extra.join(", ")}.` : ""}`, goal, ...p };
}

const autonomyFrom = (p: Personality): "act_within_limits" | "ask_first" => (p.checkins === "rarely" ? "act_within_limits" : "ask_first");

export const FIRST_TASK = (goal: string) =>
  `Say hello to your new home. Look around your computer using only read-only commands (for example \`uname -a\` and \`ls -la ~\`), then introduce yourself in two short sentences: who you are and how you will help with: "${goal}".`;

const DEFAULT_POLICY = { model: "northbot-smart", planner: "northbot-fast", verifier: "northbot-fast" };

export const hatchRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["hatching"];
  app.addHook("preHandler", s.auth);

  app.post(
    "/hatch/names",
    {
      schema: {
        tags,
        description: "The new agent suggests three names for itself, each already checked (rules and uniqueness).",
        body: z.object({ goal: Goal, personality: Personality, avatar: Avatar, avoid: z.array(z.string()).max(30).default([]) }),
        response: { 200: z.object({ candidates: z.array(z.object({ name: z.string(), reason: z.string() })) }) },
      },
    },
    async (req) => {
      const { goal, personality, avatar } = req.body;
      const about = `My job: ${goal}\nMy personality: ${personaFrom(goal, personality).summary}\nI look like a ${avatar.color} ${avatar.base}${avatar.accessory !== "none" ? ` with a ${avatar.accessory}` : ""}.`;
      return { candidates: await proposeNames(s.db, s.llm, me(req).workspaceId, about, req.body.avoid) };
    },
  );

  app.post(
    "/hatch",
    {
      schema: {
        tags,
        description: "Hatches an agent: creates it with its computer and starts a safe first task.",
        body: z.object({
          goal: Goal,
          personality: Personality,
          avatar: Avatar,
          name: AgentName,
          nameChosenBy: z.enum(["agent", "human"]),
        }),
        response: { 201: z.object({ agent: AgentInfo, firstTaskId: z.string().uuid() }), 409: ErrorBody, 422: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const { goal, personality, avatar, name, nameChosenBy } = req.body;
      const check = await validateName(s.db, m.workspaceId, name);
      if (!check.ok) {
        const status = check.problem === "taken" ? 409 : 422;
        return reply.code(status).send({ error: `name_${check.problem}`, message: nameMessage(check.problem) });
      }
      const agent = await createAgent(s, m.workspaceId, m.userId, {
        name,
        nameLocked: nameChosenBy === "human",
        avatar,
        persona: personaFrom(goal, personality),
        modelPolicy: DEFAULT_POLICY,
        autonomyLevel: autonomyFrom(personality),
        budgetDailyUsd: 1,
      });
      await s.events.write(m.workspaceId, { type: "agent.hatched", agentId: agent.id, payload: { agentId: agent.id, name, nameChosenBy, goal } });
      const { task } = await s.tasks.create({ workspaceId: m.workspaceId, agentId: agent.id, goal: FIRST_TASK(goal), by: "system", userId: m.userId });
      return reply.code(201).send({ agent: agentInfo(agent), firstTaskId: task.id });
    },
  );

  app.post(
    "/hatch/team",
    {
      schema: {
        tags,
        description: "Hatches a small team for one goal; each member names itself.",
        body: z.object({ goal: Goal, roles: z.array(z.string().trim().min(2).max(60)).min(2).max(5), avatar: Avatar.partial().default({}) }),
        response: { 201: z.object({ agents: z.array(AgentInfo) }) },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const bases = ["blob", "cat", "robot", "plant", "ghost"] as const;
      const colors = ["peach", "mint", "sky", "lilac", "butter"] as const;
      const made = [];
      for (const [i, role] of req.body.roles.entries()) {
        const personality = Personality.parse({});
        const [pick] = await proposeNames(s.db, s.llm, m.workspaceId, `My job on a team working on "${req.body.goal}": ${role}.`);
        if (!pick) continue;
        const agent = await createAgent(s, m.workspaceId, m.userId, {
          name: pick.name,
          nameLocked: false,
          avatar: Avatar.parse({ base: bases[i % bases.length], color: colors[i % colors.length], ...req.body.avatar }),
          persona: { ...personaFrom(req.body.goal, personality), role },
          modelPolicy: DEFAULT_POLICY,
          autonomyLevel: "ask_first",
          budgetDailyUsd: 1,
        });
        await s.events.write(m.workspaceId, {
          type: "agent.hatched",
          agentId: agent.id,
          payload: { agentId: agent.id, name: agent.name, nameChosenBy: "agent", goal: `${role} for: ${req.body.goal}` },
        });
        await s.tasks.create({ workspaceId: m.workspaceId, agentId: agent.id, goal: FIRST_TASK(`${role} for: ${req.body.goal}`), by: "system", userId: m.userId });
        made.push(agentInfo(agent));
      }
      return reply.code(201).send({ agents: made });
    },
  );
};
