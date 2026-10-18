import { AVATAR_COLORS, AVATAR_SHAPES, Avatar } from "./avatar.js";
import type { StoredEvent } from "./events.js";
import { startOfDayIn, zonedParts } from "./time.js";

/**
 * The Cozy Office as a pure function of the event log. The canvas, the plain list view and the
 * tests all read this state, so the office never shows anything that is not an event.
 */

export const ZONES = ["desk", "post_box", "mail_desk", "meeting_room", "stage", "break_room", "idea_bin", "whiteboard", "browser_lab", "vault"] as const;
export type Zone = (typeof ZONES)[number];

export type Activity = "idle" | "typing" | "browsing" | "talking" | "presenting" | "listening" | "carrying" | "sleeping" | "waiting" | "blocked";
export type Reaction = "hearts" | "cookie" | "dizzy" | "stretch";

export interface OfficeBubble {
  text: string;
  /** What it is about, for topic-only privacy mode. */
  topic: string;
  important: boolean;
  /** Messages folded into this bubble (collapsed chatter). */
  count: number;
  eventId: number;
  ts: string;
}

export interface OfficeAgent {
  id: string;
  name: string;
  avatar: Avatar;
  status: string;
  mood: string;
  zone: Zone;
  /** Where it walked from (for the walking animation) and when (event id). */
  from: Zone;
  movedAt: number;
  activity: Activity;
  held: boolean;
  hibernated: boolean;
  carrying: string | null;
  bubble: OfficeBubble | null;
  reaction: { kind: Reaction; ts: string } | null;
  /** Why it is in the break room. `budget` rests until the next local midnight. */
  rest: { why: string; kind: "waiting" | "resting" | "hibernated" | "budget"; since: string } | null;
  order: number;
}

export interface OfficeLetter {
  id: string;
  type: string;
  subject: string;
  /** Agent ids; null means the humans. */
  from: string | null;
  to: string | null;
  /** Where it is now, and the stops it passed (for the carrying animation). */
  at: "post_box" | "mail_desk" | "desk" | "inbox";
  path: ("post_box" | "mail_desk" | "desk" | "inbox")[];
  status: string;
  eventId: number;
}

export interface OfficeState {
  lastEventId: number;
  agents: Record<string, OfficeAgent>;
  letters: Record<string, OfficeLetter>;
  /** Crumpled papers in the idea bin. */
  papers: { ideaId: string; title: string; agentId: string | null }[];
  /** The whiteboard: the latest tasks. */
  board: { id: string; agentId: string; goal: string; status: string }[];
  rooms: Record<string, { kind: string; name: string }>;
  talks: Record<string, { roomId: string | null; title: string; presenter: string | null; audience: string[]; stage: string }>;
  schedules: Record<string, { name: string; agentId: string | null; nextRunAt: string | null; enabled: boolean }>;
  killSwitch: boolean;
  /** Agents created so far (desk order). */
  created: number;
}

const MAX_LETTERS = 30;
const MAX_BOARD = 12;
/** Messages from one agent this close together fold into one bubble. */
const CHATTER_MS = 10_000;

export function emptyOffice(): OfficeState {
  return { lastEventId: 0, agents: {}, letters: {}, papers: [], board: [], rooms: {}, talks: {}, schedules: {}, killSwitch: false, created: 0 };
}

/** A stable look for agents whose look was never logged (older installs). */
function fallbackLook(id: string): Avatar {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { shape: AVATAR_SHAPES[h % AVATAR_SHAPES.length]!, color: AVATAR_COLORS[(h >>> 4) % AVATAR_COLORS.length]! };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const firstLine = (s: string) => s.split(String.fromCharCode(10))[0] ?? s;

function ensureAgent(s: OfficeState, id: string, name = ""): OfficeAgent {
  let a = s.agents[id];
  if (!a) {
    a = {
      id,
      name: name || "Agent",
      avatar: fallbackLook(id),
      status: "idle",
      mood: "content",
      zone: "desk",
      from: "desk",
      movedAt: 0,
      activity: "idle",
      held: false,
      hibernated: false,
      carrying: null,
      bubble: null,
      reaction: null,
      rest: null,
      order: s.created++,
    };
    s.agents[id] = a;
  }
  return a;
}

function move(a: OfficeAgent, zone: Zone, eventId: number): void {
  if (a.zone === zone) return;
  a.from = a.zone;
  a.zone = zone;
  a.movedAt = eventId;
}

function say(a: OfficeAgent, e: StoredEvent, text: string, topic: string, important = false): void {
  const prev = a.bubble;
  const close = prev && !prev.important && !important && Date.parse(e.ts) - Date.parse(prev.ts) < CHATTER_MS;
  a.bubble = { text: text.slice(0, 280), topic, important, count: close ? prev.count + 1 : 1, eventId: e.id, ts: e.ts };
}

/** Back to the desk (or the break room while the computer sleeps). */
function settle(a: OfficeAgent, eventId: number): void {
  if (a.hibernated) return move(a, "break_room", eventId);
  a.rest = null;
  move(a, "desk", eventId);
}

const findTalk = (s: OfficeState, talkId: string, roomId: string | null) => s.talks[talkId] ?? Object.values(s.talks).find((t) => roomId && t.roomId === roomId);

/** Applies one event to the state in place. Events must arrive in id order. */
export function applyOfficeEvent(s: OfficeState, e: StoredEvent): void {
  if (e.id <= s.lastEventId) return;
  s.lastEventId = e.id;
  const p = e.payload;
  const id = e.agentId;
  const a = id && e.type !== "agent.deleted" ? (s.agents[id] ?? (e.type === "agent.created" || e.type === "agent.hatched" ? ensureAgent(s, id, str(p.name)) : null)) : null;

  switch (e.type) {
    case "schedule.changed":
      s.schedules[str(p.scheduleId)] = { name: str(p.name), agentId: id, nextRunAt: typeof p.nextRunAt === "string" ? p.nextRunAt : null, enabled: Boolean(p.enabled) };
      return;
    case "schedule.started":
      if (a) { a.reaction = { kind: "stretch", ts: e.ts }; a.hibernated = false; a.rest = null; move(a, "desk", e.id); }
      return;
    case "schedule.paused":
      if (a) a.mood = "worried";
      if (s.schedules[str(p.scheduleId)]) s.schedules[str(p.scheduleId)]!.enabled = false;
      return;
    case "agent.created":
    case "agent.hatched":
      if (a) {
        a.name = str(p.name) || a.name;
        if (p.avatar) a.avatar = Avatar.parse(p.avatar);
      }
      return;
    case "agent.updated":
      if (a && p.avatar) a.avatar = Avatar.parse(p.avatar);
      return;
    case "agent.renamed":
      if (a) a.name = str(p.to) || a.name;
      return;
    case "agent.deleted":
      if (id) delete s.agents[id];
      return;
    case "agent.mood":
      if (a) a.mood = str(p.mood) || a.mood;
      return;
    case "agent.status": {
      if (!a) return;
      const status = str(p.status);
      a.status = status;
      if (status === "waiting" || status === "resting") {
        a.activity = status === "waiting" ? "waiting" : "sleeping";
        a.rest = { why: status === "waiting" ? "Waiting for a human" : "Resting", kind: status, since: e.ts };
        move(a, "break_room", e.id);
      } else if (status === "working") {
        a.activity = "typing";
        if (a.zone === "break_room") settle(a, e.id);
      } else if (status === "blocked") {
        a.activity = "blocked";
        settle(a, e.id);
      } else {
        a.activity = "idle";
        if (a.zone === "break_room" || a.zone === "browser_lab" || a.zone === "vault") settle(a, e.id);
      }
      return;
    }
    case "task.created":
      if (!a) return;
      s.board.push({ id: str(p.taskId), agentId: a.id, goal: firstLine(str(p.goal)).slice(0, 120), status: "queued" });
      if (s.board.length > MAX_BOARD) s.board.splice(0, s.board.length - MAX_BOARD);
      return;
    case "task.step": {
      if (!a) return;
      const tool = str(p.tool);
      const row = s.board.find((t) => t.id === str(p.taskId));
      if (row) row.status = "running";
      if (tool === "browser") {
        a.activity = "browsing";
        move(a, "browser_lab", e.id);
      } else if (tool === "send_letter") move(a, "post_box", e.id);
      else if (tool === "toss_idea") move(a, "idea_bin", e.id);
      else {
        a.activity = "typing";
        if (a.zone !== "desk") settle(a, e.id);
      }
      return;
    }
    case "task.finished": {
      const row = s.board.find((t) => t.id === str(p.taskId));
      if (row) row.status = str(p.status);
      if (!a) return;
      a.activity = "idle";
      if (p.status === "failed" || p.status === "blocked") say(a, e, `I couldn't finish: ${str(p.error) || "something went wrong"}`, "a task", true);
      if (a.zone === "browser_lab" || a.zone === "vault" || a.zone === "post_box" || a.zone === "idea_bin") settle(a, e.id);
      return;
    }
    case "browser.action":
      if (a && p.by === "agent") {
        a.activity = "browsing";
        move(a, "browser_lab", e.id);
      }
      return;
    case "vault.secret_used":
      if (a) move(a, "vault", e.id);
      return;
    case "chat.message":
      if (a && p.role === "agent") say(a, e, str(p.preview), "a chat with you");
      return;
    case "room.created":
      if (e.roomId) s.rooms[e.roomId] = { kind: str(p.kind) || "room", name: str(p.name) };
      return;
    case "room.message": {
      if (!a || p.authorKind !== "agent") return;
      const room = e.roomId ? s.rooms[e.roomId] : undefined;
      const talk = room?.kind === "talk";
      if (talk && e.roomId) {
        // Learn who is in the Talk from who speaks there (older talk.created events lack it).
        let t = Object.values(s.talks).find((x) => x.roomId === e.roomId);
        if (!t) s.talks[`room:${e.roomId}`] = t = { roomId: e.roomId, title: room.name, presenter: null, audience: [], stage: "present" };
        if (p.kind === "slide" && !t.presenter) t.presenter = a.id;
        if (t.presenter !== a.id && !t.audience.includes(a.id)) t.audience.push(a.id);
      }
      say(a, e, str(p.preview), room ? room.name : "a room", p.kind === "decision");
      a.activity = talk ? (Object.values(s.talks).some((t) => t.presenter === a.id && t.roomId === e.roomId) ? "presenting" : "listening") : "talking";
      move(a, talk ? "stage" : "meeting_room", e.id);
      return;
    }
    case "talk.created": {
      const audience = Array.isArray(p.audience) ? p.audience.map(String) : [];
      s.talks[str(p.talkId)] = { roomId: e.roomId, title: str(p.title), presenter: str(p.presenterAgentId) || null, audience, stage: "brief" };
      return;
    }
    case "talk.stage": {
      const talk = findTalk(s, str(p.talkId), e.roomId);
      if (!talk) return;
      talk.stage = str(p.stage);
      const members = [talk.presenter, ...talk.audience].filter((m): m is string => Boolean(m && s.agents[m]));
      for (const m of members.map((x) => s.agents[x]!)) {
        if (talk.stage === "done" || talk.stage === "stopped") {
          m.activity = "idle";
          if (m.zone === "stage") settle(m, e.id);
        } else if (talk.stage !== "brief") {
          m.activity = m.id === talk.presenter ? "presenting" : "listening";
          move(m, "stage", e.id);
        }
      }
      return;
    }
    case "talk.decided": {
      const talk = findTalk(s, str(p.talkId), e.roomId);
      const presenter = talk?.presenter ? s.agents[talk.presenter] : undefined;
      if (presenter) say(presenter, e, `Decision: ${str(p.decision)}`, talk?.title ?? "a Talk", true);
      return;
    }
    case "letter.sent": {
      const letterId = str(p.letterId);
      const replyTo = p.replyToId ? s.letters[str(p.replyToId)] : undefined;
      const from = id ?? null;
      const to = replyTo ? replyTo.from : null;
      const letter: OfficeLetter = {
        id: letterId,
        type: str(p.type),
        subject: "",
        from,
        to,
        at: replyTo ? (to ? "desk" : "inbox") : "post_box",
        path: replyTo ? ["post_box", "mail_desk", to ? "desk" : "inbox"] : ["post_box"],
        status: replyTo ? "delivered" : "new",
        eventId: e.id,
      };
      s.letters[letterId] = letter;
      if (a && !replyTo) {
        a.carrying = letterId;
        a.activity = "carrying";
        move(a, "post_box", e.id);
      }
      const keys = Object.keys(s.letters);
      if (keys.length > MAX_LETTERS) for (const k of keys.slice(0, keys.length - MAX_LETTERS)) delete s.letters[k];
      return;
    }
    case "letter.routed": {
      const letter = s.letters[str(p.letterId)];
      if (!letter) return;
      letter.to = p.handledBy ? str(p.handledBy) : null;
      letter.at = letter.to ? "desk" : "inbox";
      letter.path = ["post_box", "mail_desk", letter.at];
      letter.status = letter.to ? "routed" : "needs_human";
      letter.eventId = e.id;
      const sender = letter.from ? s.agents[letter.from] : undefined;
      if (sender && sender.carrying === letter.id) {
        sender.carrying = null;
        sender.activity = "idle";
        settle(sender, e.id);
      }
      return;
    }
    case "letter.answered": {
      const letter = s.letters[str(p.letterId)];
      if (letter) letter.status = "answered";
      return;
    }
    case "idea.tossed":
      s.papers.push({ ideaId: str(p.ideaId), title: str(p.title), agentId: id });
      if (a) move(a, "idea_bin", e.id);
      return;
    case "idea.restored":
    case "idea.expired": {
      const paper = s.papers.find((x) => x.ideaId === str(p.ideaId));
      s.papers = s.papers.filter((x) => x.ideaId !== str(p.ideaId));
      if (e.type === "idea.restored" && a && paper) say(a, e, `My idea is back: ${paper.title}`, "the idea bin", true);
      return;
    }
    case "sandbox.hibernated":
      if (!a) return;
      a.hibernated = true;
      a.activity = "sleeping";
      a.rest = { why: str(p.reason) || "Resting", kind: "hibernated", since: e.ts };
      move(a, "break_room", e.id);
      return;
    case "sandbox.woken":
      if (!a) return;
      a.hibernated = false;
      a.reaction = { kind: "stretch", ts: e.ts };
      if (a.status !== "waiting" && a.status !== "resting") {
        a.activity = "idle";
        settle(a, e.id);
      }
      return;
    case "llm.blocked":
      if (a && p.reason === "budget_exceeded") {
        a.activity = "sleeping";
        a.rest = { why: "Out of today's budget", kind: "budget", since: e.ts };
        move(a, "break_room", e.id);
      }
      return;
    case "approval.requested":
      if (a) say(a, e, `Can I ${str(p.summary)}?`, "an approval", true);
      return;
    case "approval.decided":
      if (a?.bubble?.topic === "an approval") a.bubble = null;
      return;
    case "agent.lifted":
      if (a) a.held = true;
      return;
    case "agent.dropped":
      if (!a) return;
      a.held = false;
      if ((ZONES as readonly string[]).includes(str(p.zone))) move(a, str(p.zone) as Zone, e.id);
      return;
    case "agent.shaken":
      if (a) a.reaction = { kind: "dizzy", ts: e.ts };
      return;
    case "agent.cheered":
      if (a) a.reaction = { kind: p.how === "cookie" ? "cookie" : "hearts", ts: e.ts };
      return;
    case "killswitch.engaged":
      s.killSwitch = true;
      return;
    case "killswitch.released":
      s.killSwitch = false;
      return;
    default:
      return;
  }
}

/** The office after every event, from nothing. */
export function reduceOffice(events: StoredEvent[]): OfficeState {
  const s = emptyOffice();
  for (const e of [...events].sort((x, y) => x.id - y.id)) applyOfficeEvent(s, e);
  return s;
}

export type DayPhase = "dawn" | "day" | "dusk" | "night";

export interface OfficeView {
  clock: string;
  calendar: { name: string; nextRunAt: string }[];
  agents: (OfficeAgent & { reactionNow: Reaction | null; wakeAt: string | null })[];
  breakRoom: { agentId: string; name: string; why: string; wakeAt: string | null }[];
  /** One alert when most agents are resting. */
  alert: string | null;
  dayPhase: DayPhase;
  pet: { kind: "cat"; zone: Zone; mood: "napping" | "curious" };
}

const REACTION_MS = 6000;

/** Time-dependent details (reactions fade, wake times, day/night, the cat) at a moment. */
export function officeView(s: OfficeState, now: Date, timezone = "UTC"): OfficeView {
  const agents = Object.values(s.agents)
    .sort((x, y) => x.order - y.order)
    .map((a) => {
      const reactionNow = a.reaction && now.getTime() - Date.parse(a.reaction.ts) < REACTION_MS ? a.reaction.kind : null;
      const upcoming = Object.values(s.schedules).filter((r) => r.agentId === a.id && r.enabled && r.nextRunAt && Date.parse(r.nextRunAt) > now.getTime()).sort((x, y) => x.nextRunAt!.localeCompare(y.nextRunAt!))[0]?.nextRunAt ?? null;
      const wakeAt = upcoming ?? (a.rest?.kind === "budget" ? new Date(startOfDayIn(new Date(Math.max(now.getTime(), Date.parse(a.rest.since))), timezone).getTime() + 86_400_000).toISOString() : null);
      return { ...a, reactionNow, wakeAt };
    });
  const resting = agents.filter((a) => a.zone === "break_room");
  const hour = zonedParts(now, timezone).hour;
  const dayPhase: DayPhase = hour >= 6 && hour < 9 ? "dawn" : hour >= 9 && hour < 17 ? "day" : hour >= 17 && hour < 20 ? "dusk" : "night";
  const counts = new Map<Zone, number>();
  for (const a of agents) counts.set(a.zone, (counts.get(a.zone) ?? 0) + 1);
  const busiest = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0];
  return {
    clock: new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(now),
    calendar: Object.values(s.schedules).filter((r): r is typeof r & { nextRunAt: string } => r.enabled && r.nextRunAt !== null && Date.parse(r.nextRunAt) > now.getTime()).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt)).slice(0, 3).map((r) => ({ name: r.name, nextRunAt: r.nextRunAt })),
    agents,
    breakRoom: resting.map((a) => ({ agentId: a.id, name: a.name, why: a.rest?.why ?? "Taking a break", wakeAt: a.wakeAt })),
    alert: agents.length >= 2 && resting.length > agents.length / 2 ? `${resting.length} of ${agents.length} agents are resting.` : null,
    dayPhase,
    pet: { kind: "cat", zone: dayPhase === "night" || !busiest ? "break_room" : busiest, mood: dayPhase === "night" ? "napping" : "curious" },
  };
}
