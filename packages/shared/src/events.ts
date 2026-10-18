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
