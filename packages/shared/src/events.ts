import { z } from "zod";

const Id = z.string().uuid();

/**
 * Every event type and its payload schema. The event log is the source of truth;
 * add new types here (never write untyped events). Payloads must never carry secret values.
 */
export const EventPayloads = {
  "auth.signup": z.object({ userId: Id }),
  "auth.login": z.object({ userId: Id, method: z.enum(["password", "passkey"]) }),
  "auth.logout": z.object({ userId: Id }),
  "auth.passkey_added": z.object({ userId: Id, credentialId: z.string() }),
  "settings.updated": z.object({ userId: Id, changed: z.array(z.string()) }),
  "vault.secret_stored": z.object({ name: z.string(), userId: Id }),
  "vault.secret_deleted": z.object({ name: z.string(), userId: Id }),
  "vault.secret_used": z.object({ name: z.string(), sandboxId: z.string(), as: z.string() }),
  "user.note": z.object({ text: z.string().min(1).max(4000) }),
  "apikey.created": z.object({ apiKeyId: Id, name: z.string(), userId: Id }),
  "apikey.revoked": z.object({ apiKeyId: Id, userId: Id }),
  "llm.settings_updated": z.object({ userId: Id }),
  /** One provider attempt. Cost is in the event's cost_usd column. */
  "llm.call": z.object({
    provider: z.string(),
    model: z.string(),
    alias: z.string().nullable(),
    ok: z.boolean(),
    error: z.string().optional(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    latencyMs: z.number().int(),
    privacy: z.enum(["normal", "sensitive"]),
    redactions: z.number().int(),
    taskId: z.string().nullable(),
    apiKeyId: z.string().nullable(),
  }),
  "agent.created": z.object({ agentId: Id, name: z.string(), userId: Id.nullable() }),
  "agent.deleted": z.object({ agentId: Id, userId: Id }),
  "sandbox.created": z.object({ sandboxId: z.string(), driver: z.string() }),
  "sandbox.hibernated": z.object({ sandboxId: z.string(), reason: z.string() }),
  "sandbox.woken": z.object({ sandboxId: z.string(), reason: z.string() }),
  "sandbox.snapshot": z.object({ sandboxId: z.string(), snapshotId: z.string() }),
  "sandbox.destroyed": z.object({ sandboxId: z.string() }),
  "sandbox.takeover": z.object({ sandboxId: z.string(), userId: Id }),
  "sandbox.released": z.object({ sandboxId: z.string(), userId: Id }),
  /** A human opened / closed the live terminal (what they type is not logged keystroke by keystroke). */
  "terminal.attached": z.object({ agentId: Id, userId: Id }),
  "terminal.detached": z.object({ agentId: Id, userId: Id, durationMs: z.number().int() }),
  "terminal.exec": z.object({
    sandboxId: z.string(),
    by: z.enum(["user", "agent", "system"]),
    command: z.string(),
    exitCode: z.number().int(),
    timedOut: z.boolean(),
    durationMs: z.number().int(),
    outputPreview: z.string(),
  }),
  "browser.action": z.object({
    sandboxId: z.string(),
    by: z.enum(["user", "agent", "system"]),
    action: z.string(),
    url: z.string().optional(),
    title: z.string().optional(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
  /** Written by the egress proxy for every outbound connection from an agent computer. */
  egress: z.object({
    sandboxId: z.string(),
    method: z.string(),
    host: z.string(),
    port: z.number().int(),
    status: z.enum(["ok", "error"]),
    httpStatus: z.number().int().optional(),
    error: z.string().optional(),
    bytesUp: z.number().int(),
    bytesDown: z.number().int(),
    durationMs: z.number().int(),
  }),
  "agent.hatched": z.object({ agentId: Id, name: z.string(), nameChosenBy: z.enum(["agent", "human"]), goal: z.string() }),
  "agent.renamed": z.object({ agentId: Id, from: z.string(), to: z.string(), userId: Id }),
  "agent.updated": z.object({ agentId: Id, changed: z.array(z.string()), userId: Id }),
  "agent.mood": z.object({ mood: z.string(), cause: z.string(), fix: z.string().nullable(), detail: z.record(z.string()) }),
  /** A human paused or picked up an agent mid-task. */
  "agent.interrupted": z.object({ taskId: Id.nullable(), how: z.enum(["cancelled", "taken_over", "picked_up", "paused"]), userId: Id }),
  /** Cosmetic kindness (thanks, "it's ok", pets, cookies). Never grants anything. */
  "agent.cheered": z.object({ how: z.enum(["thanks", "its_ok", "pet", "cookie"]), userId: Id }),
  "feedback.correction": z.object({ taskId: Id, note: z.string(), userId: Id }),
  "feedback.good_job": z.object({ taskId: Id, note: z.string(), userId: Id }),
  "instruction.contradiction": z.object({ ruleIds: z.array(Id), description: z.string() }),
  "chat.message": z.object({
    threadId: Id,
    messageId: Id,
    role: z.enum(["user", "agent", "system"]),
    preview: z.string(),
    taskId: Id.nullable(),
  }),
  "notification.created": z.object({ notificationId: Id, kind: z.string(), body: z.string(), deliverAt: z.string() }),
  "agent.status": z.object({ status: z.enum(["working", "waiting", "resting", "blocked", "idle"]) }),
  "task.created": z.object({ taskId: Id, goal: z.string(), by: z.enum(["user", "agent", "schedule", "system"]), userId: Id.nullable() }),
  "task.plan": z.object({ taskId: Id, steps: z.array(z.string()) }),
  "task.estimate": z.object({ taskId: Id, estimateUsd: z.number(), needsApproval: z.boolean() }),
  "task.step": z.object({ taskId: Id, tool: z.string(), kind: z.string(), summary: z.string() }),
  "task.critique": z.object({ taskId: Id, draft: z.string() }),
  "task.report": z.object({
    taskId: Id,
    finalText: z.string(),
    summary: z.string(),
    claims: z.array(z.object({ text: z.string(), status: z.enum(["verified", "inferred", "guessed"]), evidence: z.string() })),
  }),
  "task.finished": z.object({ taskId: Id, status: z.string(), error: z.string().nullable(), steps: z.number().int() }),
  "task.escalated": z.object({ taskId: Id, reason: z.string() }),
  "shield.blocked": z.object({ taskId: Id, summary: z.string(), kind: z.string(), reason: z.string() }),
  "shield.injection_detected": z.object({ taskId: Id, source: z.string() }),
  "permission.blocked": z.object({ taskId: Id, summary: z.string(), kind: z.string(), reason: z.string() }),
  "action.deduplicated": z.object({ taskId: Id, summary: z.string(), idempotencyKey: z.string() }),
  "approval.requested": z.object({ approvalId: Id, taskId: Id.nullable(), kind: z.string(), summary: z.string(), reason: z.string() }),
  "approval.decided": z.object({
    approvalId: Id,
    taskId: Id.nullable(),
    decision: z.enum(["approve_once", "approve_always", "deny", "cancelled"]),
    userId: Id.nullable(),
  }),
  "rule.created": z.object({ ruleId: Id, description: z.string(), effect: z.string(), source: z.enum(["user", "approval"]), userId: Id.nullable() }),
  "rule.deleted": z.object({ ruleId: Id, userId: Id }),
  "killswitch.engaged": z.object({ userId: Id, stoppedTasks: z.number().int() }),
  "killswitch.released": z.object({ userId: Id }),
  "llm.blocked": z.object({
    reason: z.enum(["budget_exceeded", "privacy_violation"]),
    message: z.string(),
    taskId: z.string().nullable(),
    apiKeyId: z.string().nullable(),
  }),
} as const;

export type EventType = keyof typeof EventPayloads;
export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

export const EVENT_TYPES = Object.keys(EventPayloads) as EventType[];

/** Event types a signed-in client may write directly through the API. */
export const CLIENT_WRITABLE_EVENTS = ["user.note"] as const satisfies readonly EventType[];

export interface NewEvent<T extends EventType = EventType> {
  type: T;
  payload: EventPayload<T>;
  agentId?: string | null;
  roomId?: string | null;
  costUsd?: number;
}

export const StoredEvent = z.object({
  id: z.number().int(),
  ts: z.string(),
  agentId: z.string().nullable(),
  roomId: z.string().nullable(),
  type: z.string(),
  payload: z.record(z.unknown()),
  costUsd: z.number(),
});
export type StoredEvent = z.infer<typeof StoredEvent>;

/** Messages sent over the event WebSocket feed. */
export type EventFeedMessage =
  | { kind: "event"; event: StoredEvent }
  | { kind: "replay_done"; lastId: number | null };

export function parseEventPayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return EventPayloads[type].parse(payload) as EventPayload<T>;
}

export function isEventType(type: string): type is EventType {
  return type in EventPayloads;
}
