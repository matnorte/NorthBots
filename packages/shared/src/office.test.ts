import { describe, expect, it } from "vitest";
import type { StoredEvent } from "./events.js";
import { applyOfficeEvent, emptyOffice, officeView, reduceOffice } from "./office.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const ROOM = "00000000-0000-4000-8000-0000000000c0";
const TALK_ROOM = "00000000-0000-4000-8000-0000000000c1";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A small office day, one event per second from 09:00 UTC. */
function day(): StoredEvent[] {
  const raw: [agentId: string | null, type: string, payload: Record<string, unknown>, roomId?: string | null][] = [
    [A, "agent.created", { agentId: A, name: "Ana", userId: null, avatar: { shape: "star", color: "sunflower" } }],
    [B, "agent.created", { agentId: B, name: "Bo", userId: null, avatar: { shape: "hexagon", color: "teal" } }],
    [A, "task.created", { taskId: id(1), goal: "Count mugs\nmore detail", by: "user", userId: null }],
    [A, "agent.status", { status: "working" }],
    [A, "task.step", { taskId: id(1), tool: "browser", kind: "read", summary: "browser goto" }],
    [A, "task.step", { taskId: id(1), tool: "terminal", kind: "read", summary: "run ls" }],
    [A, "task.finished", { taskId: id(1), status: "done", error: null, steps: 2 }],
    [A, "agent.status", { status: "idle" }],
    [null, "room.created", { name: "Shop", kind: "room", userId: null }, ROOM],
    [B, "room.message", { messageId: id(2), authorKind: "agent", kind: "message", preview: "Hello!" }, ROOM],
    [B, "room.message", { messageId: id(3), authorKind: "agent", kind: "message", preview: "Also this." }, ROOM],
    [null, "letter.sent", { letterId: id(4), type: "request", from: "user", replyToId: null }],
    [A, "letter.routed", { letterId: id(4), handledBy: A, confidence: 1, why: "skill", lowConfidence: false }],
    [A, "letter.sent", { letterId: id(5), type: "fyi", from: "agent", replyToId: id(4) }],
    [A, "idea.tossed", { ideaId: id(6), title: "Sell mugs", trigger: null }],
    [B, "sandbox.hibernated", { sandboxId: "sbx1", reason: "idle for 30 minutes" }],
    [A, "approval.requested", { approvalId: id(7), taskId: null, kind: "write", summary: "write a.txt", reason: "ask first" }],
    [A, "agent.lifted", { userId: id(9), taskId: null }],
    [A, "agent.dropped", { userId: id(9), zone: "meeting_room" }],
    [null, "room.created", { name: "Talk: Supplier", kind: "talk", userId: null }, TALK_ROOM],
    [null, "talk.created", { talkId: id(8), title: "Supplier", presenterAgentId: A, audience: [B] }, TALK_ROOM],
    [null, "talk.stage", { talkId: id(8), stage: "present" }, TALK_ROOM],
    [A, "talk.decided", { talkId: id(8), decision: "Yes: switch", decidedBy: "vote" }, TALK_ROOM],
    [A, "agent.cheered", { how: "pet", userId: id(9) }],
  ];
  return raw.map(([agentId, type, payload, roomId], i) => ({
    id: i + 1,
    ts: new Date(Date.UTC(2026, 9, 18, 9, 0, i)).toISOString(),
    agentId,
    roomId: roomId ?? null,
    type,
    payload,
    costUsd: 0,
  }));
}

describe("office state from the event log", () => {
  it("is a pure function of the log (snapshot)", () => {
    expect(reduceOffice(day())).toMatchSnapshot();
  });

  it("gives the same office whether events arrive one by one, all at once, or shuffled", () => {
    const events = day();
    const live = emptyOffice();
    for (const e of events) applyOfficeEvent(live, e);
    const shuffled = [...events].sort((x, y) => (x.id * 7919) % 13 - (y.id * 7919) % 13);
    expect(reduceOffice(shuffled)).toEqual(live);
    expect(reduceOffice(events)).toEqual(reduceOffice(events));
    // Replaying an event already applied changes nothing.
    applyOfficeEvent(live, events[3]!);
    expect(live).toEqual(reduceOffice(events));
  });

  it("follows each kind of event", () => {
    const events = day();
    const at = (n: number) => reduceOffice(events.slice(0, n));
    expect(at(2).agents[A]).toMatchObject({ name: "Ana", avatar: { shape: "star", color: "sunflower" }, zone: "desk" });
    expect(at(5).agents[A]).toMatchObject({ zone: "browser_lab", activity: "browsing" });
    expect(at(6).agents[A]).toMatchObject({ zone: "desk", from: "browser_lab", activity: "typing" });
    expect(at(7).board).toEqual([{ id: id(1), agentId: A, goal: "Count mugs", status: "done" }]);
    // Speech bubbles: latest per agent, chatter collapsed.
    expect(at(10).agents[B]).toMatchObject({ zone: "meeting_room", bubble: { text: "Hello!", topic: "Shop", count: 1 } });
    expect(at(11).agents[B]!.bubble).toMatchObject({ text: "Also this.", count: 2 });
    // Letters travel post box → mail desk → desk, and replies come back to the humans' inbox.
    expect(at(12).letters[id(4)]).toMatchObject({ at: "post_box", from: null });
    expect(at(13).letters[id(4)]).toMatchObject({ at: "desk", to: A, path: ["post_box", "mail_desk", "desk"] });
    expect(at(14).letters[id(5)]).toMatchObject({ from: A, to: null, at: "inbox" });
    expect(at(15).papers).toEqual([{ ideaId: id(6), title: "Sell mugs", agentId: A }]);
    expect(at(15).agents[A]!.zone).toBe("idea_bin");
    // Break room: a hibernating computer, with why.
    expect(at(16).agents[B]).toMatchObject({ zone: "break_room", hibernated: true, rest: { why: "idle for 30 minutes", kind: "hibernated" } });
    expect(at(17).agents[A]!.bubble).toMatchObject({ text: "Can I write a.txt?", important: true });
    expect(at(18).agents[A]!.held).toBe(true);
    expect(at(19).agents[A]).toMatchObject({ held: false, zone: "meeting_room" });
    expect(at(22).agents[A]).toMatchObject({ zone: "stage", activity: "presenting" });
    expect(at(23).agents[A]!.bubble).toMatchObject({ text: "Decision: Yes: switch", important: true });
  });

  it("derives reactions, the break-room board, the alert, day and night", () => {
    const s = reduceOffice(day());
    const soon = officeView(s, new Date("2026-10-18T09:00:25Z"), "UTC");
    expect(soon.agents.find((a) => a.id === A)!.reactionNow).toBe("hearts");
    // Bo left the break room for the Talk; before it, the board showed why he rested.
    expect(soon.breakRoom).toEqual([]);
    const beforeTalk = officeView(reduceOffice(day().slice(0, 16)), new Date("2026-10-18T09:00:16Z"), "UTC");
    expect(beforeTalk.breakRoom).toEqual([{ agentId: B, name: "Bo", why: "idle for 30 minutes", wakeAt: null }]);
    expect(beforeTalk.alert).toBeNull();
    expect(soon.dayPhase).toBe("day");
    const later = officeView(s, new Date("2026-10-18T22:00:00Z"), "America/Sao_Paulo");
    expect(later.agents.find((a) => a.id === A)!.reactionNow).toBeNull();
    expect(later.dayPhase).toBe("dusk");
    expect(later.pet).toMatchObject({ kind: "cat" });

    // Out of budget: rests until the next local midnight; most agents resting raises one alert.
    const broke = reduceOffice([
      ...day().slice(0, 16),
      { id: 99, ts: "2026-10-18T15:00:00.000Z", agentId: A, roomId: null, type: "llm.blocked", payload: { reason: "budget_exceeded", message: "", taskId: null, apiKeyId: null }, costUsd: 0 },
    ]);
    const v = officeView(broke, new Date("2026-10-18T15:00:01Z"), "America/Sao_Paulo");
    expect(v.breakRoom.find((r) => r.agentId === A)).toEqual({ agentId: A, name: "Ana", why: "Out of today's budget", wakeAt: "2026-10-19T03:00:00.000Z" });
    expect(v.alert).toBe("2 of 2 agents are resting.");
  });
});
