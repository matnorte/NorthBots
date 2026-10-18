import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { BrowserActionBody, BrowserReply, ErrorBody, ExecBody, ExecReply, TabsReply } from "@northbot/shared";
import { AgentParams } from "../agents/routes.js";
import { me } from "../auth/guard.js";
import type { Services } from "../services.js";
import { ComputerError } from "./manager.js";
import { inbox } from "./ws-inbox.js";

const StateReply = z.object({ state: z.enum(["running", "hibernated", "stopped", "destroyed", "missing"]) });

async function guard<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ComputerError) {
      const status = err.code === "browser_error" ? 422 : err.code === "gone" ? 410 : 404;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    throw err;
  }
}

/** Human controls for an agent's computer: commands, browser, lifecycle, and the live view. */
export const computerRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["computer"];
  app.addHook("preHandler", s.auth);
  const ref = (req: { params: { id: string } } & Parameters<typeof me>[0]) => ({
    workspaceId: me(req).workspaceId,
    agentId: req.params.id,
  });
  const errors = { 404: ErrorBody, 410: ErrorBody, 422: ErrorBody };

  app.get("/agents/:id/computer", { schema: { tags, params: AgentParams, response: { 200: StateReply, ...errors } } }, async (req, reply) =>
    guard(reply, async () => ({ state: await s.computers.state(ref(req)) })),
  );

  app.post(
    "/agents/:id/computer/exec",
    { schema: { tags, params: AgentParams, body: ExecBody, response: { 200: ExecReply, ...errors } } },
    async (req, reply) => guard(reply, () => s.computers.exec(ref(req), req.body.command, "user", { timeoutMs: req.body.timeoutMs })),
  );

  for (const op of ["hibernate", "wake"] as const) {
    app.post(`/agents/:id/computer/${op}`, { schema: { tags, params: AgentParams, response: { 200: StateReply, ...errors } } }, async (req, reply) =>
      guard(reply, async () => {
        const r = ref(req);
        if (op === "hibernate") await s.computers.hibernate(r, "requested by user");
        else await s.computers.ensureAwake(r, "requested by user");
        return { state: await s.computers.state(r) };
      }),
    );
  }

  app.post(
    "/agents/:id/computer/snapshot",
    { schema: { tags, params: AgentParams, response: { 200: z.object({ snapshotId: z.string() }), ...errors } } },
    async (req, reply) => guard(reply, async () => ({ snapshotId: await s.computers.snapshot(ref(req)) })),
  );

  app.post(
    "/agents/:id/browser",
    { schema: { tags, params: AgentParams, body: BrowserActionBody, response: { 200: BrowserReply, ...errors } } },
    async (req, reply) => guard(reply, () => s.computers.browse(ref(req), req.body, "user")),
  );

  app.get("/agents/:id/browser/tabs", { schema: { tags, params: AgentParams, response: { 200: TabsReply, ...errors } } }, async (req, reply) =>
    guard(reply, async () => (await s.computers.browser(ref(req))).tabs()),
  );

  // Live terminal: attaches to the agent's persistent shell (the same one a take-over uses).
  app.get("/agents/:id/terminal", { websocket: true, schema: { tags, params: AgentParams } }, async (socket, req) => {
    const r = ref(req);
    const userId = me(req).userId;
    const messages = inbox(socket);
    const pty = await s.computers.pty(r, { cols: 120, rows: 32 }).catch(() => null);
    if (!pty) return socket.close(1011, "computer unavailable");
    const opened = Date.now();
    await s.events.write(r.workspaceId, { type: "terminal.attached", agentId: r.agentId, payload: { agentId: r.agentId, userId } });
    socket.send(JSON.stringify({ type: "data", data: pty.scrollback }));
    const off = pty.onData((data) => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ type: "data", data })));
    messages.handle((msg) => {
      if (msg.type === "input" && typeof msg.data === "string") pty.write(msg.data);
      if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") pty.resize(msg.cols, msg.rows);
    });
    socket.on("close", () => {
      off();
      pty.detach();
      void s.events.write(r.workspaceId, {
        type: "terminal.detached",
        agentId: r.agentId,
        payload: { agentId: r.agentId, userId, durationMs: Date.now() - opened },
      });
    });
  });

  // Live screen: screencast frames out; with "takeover", mouse and keys go in over CDP.
  app.get("/agents/:id/screen", { websocket: true, schema: { tags, params: AgentParams } }, async (socket, req) => {
    const r = ref(req);
    const userId = me(req).userId;
    const messages = inbox(socket);
    const browser = await s.computers.browser(r).catch(() => null);
    if (!browser) return socket.close(1011, "computer unavailable");
    let control = false;
    await browser.startScreencast((f) => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ type: "frame", ...f })));
    messages.handle(async (msg) => {
      if (msg.type === "takeover") {
        control = true;
        await s.computers.takeOver(r, userId);
        const taskId = await s.tasks.activeTaskOf(r.agentId);
        if (taskId) await s.events.write(r.workspaceId, { type: "agent.interrupted", agentId: r.agentId, payload: { taskId, how: "taken_over", userId } });
      } else if (msg.type === "release") {
        control = false;
        await s.computers.release(r, userId);
      } else if (control && msg.type === "mouse") {
        await browser.cdp("Input.dispatchMouseEvent", { type: msg.event, x: msg.x, y: msg.y, button: "left", clickCount: 1 }).catch(() => {});
      } else if (control && msg.type === "key") {
        await browser.cdp("Input.insertText", { text: msg.text }).catch(() => {});
      }
    });
    socket.on("close", async () => {
      await browser.stopScreencast();
      if (control) await s.computers.release(r, userId);
    });
  });
};
