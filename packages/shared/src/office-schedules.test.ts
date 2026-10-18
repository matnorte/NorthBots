import { describe, it, expect } from "vitest";
import { officeView, reduceOffice } from "./office.js";
import type { StoredEvent } from "./events.js";

describe("office schedule projections", () => {
  it("gets alarm, calendar, wake-up and worried mood from logged schedule events", () => {
    const events: StoredEvent[] = [
      {
        id: 1,
        ts: "2026-10-18T10:00:00Z",
        type: "agent.created",
        agentId: "a",
        roomId: null,
        payload: { name: "Pia" },
        costUsd: 0,
      },
      {
        id: 2,
        ts: "2026-10-18T10:00:01Z",
        type: "schedule.changed",
        agentId: "a",
        roomId: null,
        payload: {
          scheduleId: "s",
          name: "Invoices",
          nextRunAt: "2026-10-18T12:00:00Z",
          enabled: true,
        },
        costUsd: 0,
      },
    ];
    let state = reduceOffice(events);
    const view = officeView(state, new Date("2026-10-18T11:00:00Z"), "America/Sao_Paulo");
    expect(view.clock).toBe("08:00");
    expect(view.calendar[0]?.name).toBe("Invoices");
    expect(view.agents[0]?.wakeAt).toBe("2026-10-18T12:00:00Z");
    events.push({
      id: 3,
      ts: "2026-10-18T12:00:00Z",
      type: "schedule.started",
      agentId: "a",
      roomId: null,
      payload: { scheduleId: "s" },
      costUsd: 0,
    });
    state = reduceOffice(events);
    expect(state.agents.a?.reaction?.kind).toBe("stretch");
    expect(state.agents.a?.zone).toBe("desk");
    events.push({
      id: 4,
      ts: "2026-10-18T12:00:01Z",
      type: "schedule.paused",
      agentId: "a",
      roomId: null,
      payload: { scheduleId: "s" },
      costUsd: 0,
    });
    state = reduceOffice(events);
    expect(state.agents.a?.mood).toBe("worried");
    expect(state.schedules.s?.enabled).toBe(false);
  });
});
