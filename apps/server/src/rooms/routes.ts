import { and, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorBody } from "@northbot/shared";
import { me } from "../auth/guard.js";
import { agents, roomMembers, rooms } from "../db/schema.js";
import type { Services } from "../services.js";
import { KillSwitchOnError } from "../tasks/service.js";
import type { RoomMessageRow } from "./service.js";

type RoomRow = typeof rooms.$inferSelect;
const RoomInfo = z.object({
  id: z.string().uuid(),
  name: z.string(),
  goal: z.string(),
  brief: z.string(),
  kind: z.string(),
  coordinatorAgentId: z.string().uuid().nullable(),
  turnRule: z.string(),
  costCapUsd: z.number(),
  spentUsd: z.number(),
  status: z.string(),
  createdAt: z.string(),
});
export const roomInfo = (r: RoomRow): z.infer<typeof RoomInfo> => ({
  id: r.id,
  name: r.name,
  goal: r.goal,
  brief: r.brief,
  kind: r.kind,
  coordinatorAgentId: r.coordinatorAgentId,
  turnRule: r.turnRule,
  costCapUsd: Number(r.costCapUsd),
  spentUsd: Number(r.spentUsd),
  status: r.status,
  createdAt: r.createdAt.toISOString(),
});
const MessageInfo = z.object({
  id: z.string().uuid(),
  authorKind: z.string(),
  agentId: z.string().uuid().nullable(),
  content: z.string(),
  kind: z.string(),
  mentions: z.array(z.string()),
  meta: z.record(z.unknown()),
  createdAt: z.string(),
});
const messageInfo = (m: RoomMessageRow): z.infer<typeof MessageInfo> => ({
  id: m.id,
  authorKind: m.authorKind,
  agentId: m.agentId,
  content: m.content,
  kind: m.kind,
  mentions: m.mentions,
  meta: m.meta,
  createdAt: m.createdAt.toISOString(),
});
const IdParams = z.object({ id: z.string().uuid() });

/** Rooms: group chats with a goal, a pinned brief, a coordinator, a task board and a cost cap. */
export const roomRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["rooms"];
  app.addHook("preHandler", s.auth);

  const owned = async (workspaceId: string, ids: string[]) =>
    ids.length === 0 || (await s.db.db.select({ id: agents.id }).from(agents).where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, ids)))).length === new Set(ids).size;

  app.get("/rooms", { schema: { tags, querystring: z.object({ kind: z.enum(["room", "talk"]).optional() }), response: { 200: z.object({ rooms: z.array(RoomInfo) }) } } }, async (req) => ({
    rooms: (await s.rooms.list(me(req).workspaceId, req.query.kind)).map(roomInfo),
  }));

  app.post(
    "/rooms",
    {
      schema: {
        tags,
        body: z.object({
          name: z.string().trim().min(1).max(80),
          goal: z.string().max(2000).default(""),
          brief: z.string().max(10_000).default(""),
          agentIds: z.array(z.string().uuid()).max(20).default([]),
          coordinatorAgentId: z.string().uuid().nullable().default(null),
          turnRule: z.enum(["coordinator", "mentions"]).default("coordinator"),
          costCapUsd: z.number().min(0).max(1000).default(1),
        }),
        response: { 201: RoomInfo, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const ids = [...req.body.agentIds, ...(req.body.coordinatorAgentId ? [req.body.coordinatorAgentId] : [])];
      if (!(await owned(m.workspaceId, ids))) return reply.code(404).send({ error: "not_found", message: "An agent was not found." });
      const room = await s.rooms.create({ workspaceId: m.workspaceId, userId: m.userId, ...req.body });
      return reply.code(201).send(roomInfo(room));
    },
  );

  app.get(
    "/rooms/:id",
    {
      schema: {
        tags,
        params: IdParams,
        response: {
          200: RoomInfo.extend({
            members: z.array(z.object({ agentId: z.string().uuid(), name: z.string(), role: z.string(), avatar: z.record(z.unknown()), status: z.string() })),
            messages: z.array(MessageInfo),
            board: z.array(z.object({ id: z.string().uuid(), agentId: z.string().uuid(), goal: z.string(), status: z.string() })),
          }),
          404: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const room = await s.rooms.room(me(req).workspaceId, req.params.id);
      if (!room) return reply.code(404).send({ error: "not_found", message: "No such room." });
      const [members, msgs, board] = await Promise.all([s.rooms.members(room.id), s.rooms.messages(room.id), s.rooms.board(room.id)]);
      return {
        ...roomInfo(room),
        members: members.map((x) => ({ agentId: x.agent.id, name: x.agent.name, role: x.role, avatar: x.agent.avatar, status: x.agent.status })),
        messages: msgs.map(messageInfo),
        // The board shows the request, not the routing note added for the agent.
        board: board.map((t) => ({ id: t.id, agentId: t.agentId, goal: t.goal.split(String.fromCharCode(10))[0] ?? t.goal, status: t.status })),
      };
    },
  );

  app.patch(
    "/rooms/:id",
    {
      schema: {
        tags,
        params: IdParams,
        body: z.object({
          goal: z.string().max(2000).optional(),
          brief: z.string().max(10_000).optional(),
          costCapUsd: z.number().min(0).max(1000).optional(),
          status: z.enum(["open", "closed"]).optional(),
          coordinatorAgentId: z.string().uuid().nullable().optional(),
          turnRule: z.enum(["coordinator", "mentions"]).optional(),
        }),
        response: { 200: RoomInfo, 404: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const room = await s.rooms.room(m.workspaceId, req.params.id);
      const coordinator = req.body.coordinatorAgentId;
      if (!room || (coordinator && !(await owned(m.workspaceId, [coordinator])))) return reply.code(404).send({ error: "not_found", message: "No such room or agent." });
      const { costCapUsd, ...rest } = req.body;
      const [row] = await s.db.db
        .update(rooms)
        .set({ ...rest, ...(costCapUsd === undefined ? {} : { costCapUsd: String(costCapUsd) }) })
        .where(eq(rooms.id, room.id))
        .returning();
      if (coordinator) await s.db.db.insert(roomMembers).values({ roomId: room.id, agentId: coordinator, role: "coordinator" }).onConflictDoNothing();
      return roomInfo(row ?? room);
    },
  );

  app.post(
    "/rooms/:id/members",
    { schema: { tags, params: IdParams, body: z.object({ agentId: z.string().uuid() }), response: { 200: z.object({ ok: z.boolean() }), 404: ErrorBody } } },
    async (req, reply) => {
      const m = me(req);
      const room = await s.rooms.room(m.workspaceId, req.params.id);
      if (!room || !(await owned(m.workspaceId, [req.body.agentId]))) return reply.code(404).send({ error: "not_found", message: "No such room or agent." });
      await s.db.db.insert(roomMembers).values({ roomId: room.id, agentId: req.body.agentId }).onConflictDoNothing();
      return { ok: true };
    },
  );

  app.post(
    "/rooms/:id/messages",
    {
      schema: {
        tags,
        description: "Say something. @Name mentions make those agents answer; otherwise the coordinator decides who speaks.",
        params: IdParams,
        body: z.object({ content: z.string().trim().min(1).max(8000) }),
        response: { 201: MessageInfo, 404: ErrorBody, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const room = await s.rooms.room(m.workspaceId, req.params.id);
      if (!room) return reply.code(404).send({ error: "not_found", message: "No such room." });
      if (room.status !== "open") return reply.code(409).send({ error: "closed", message: "This room is closed." });
      return reply.code(201).send(messageInfo(await s.rooms.say(room, { authorKind: "user", userId: m.userId, content: req.body.content })));
    },
  );

  app.post(
    "/rooms/:id/interrupt",
    { schema: { tags, description: "Stop the agents mid-conversation.", params: IdParams, response: { 200: z.object({ stopped: z.boolean() }), 404: ErrorBody } } },
    async (req, reply) => {
      const m = me(req);
      const room = await s.rooms.room(m.workspaceId, req.params.id);
      if (!room) return reply.code(404).send({ error: "not_found", message: "No such room." });
      return { stopped: await s.rooms.interrupt(room, m.userId) };
    },
  );

  app.post(
    "/rooms/:id/tasks",
    {
      schema: {
        tags,
        description: "Put work on the room's task board for one member; the report is posted in the room.",
        params: IdParams,
        body: z.object({ agentId: z.string().uuid(), goal: z.string().trim().min(3).max(4000) }),
        response: { 201: z.object({ taskId: z.string().uuid() }), 404: ErrorBody, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const room = await s.rooms.room(m.workspaceId, req.params.id);
      const member = room ? (await s.rooms.members(room.id)).find((x) => x.agent.id === req.body.agentId) : undefined;
      if (!room || !member) return reply.code(404).send({ error: "not_found", message: "No such room, or that agent is not in it." });
      try {
        const task = await s.rooms.addTask(room, member.agent, req.body.goal, { by: "user", userId: m.userId });
        return reply.code(201).send({ taskId: task.id });
      } catch (err) {
        if (err instanceof KillSwitchOnError) return reply.code(409).send({ error: "kill_switch", message: err.message });
        throw err;
      }
    },
  );
};
