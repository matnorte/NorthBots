import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signup, startTestApp, type TestApp } from "./helpers.js";
import { tryLocked } from "../src/db/lock.js";

describe("M12: store operator pack", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp({ BIN_PICKER_INTERVAL_HOURS: "0", CANARY_INTERVAL_MINUTES: "0" });
  });
  afterAll(async () => {
    await t.services.tasks.idle();
    await t.close();
  });

  it("installs the team, rules and routines once, then runs a simulated day into a profit report", async () => {
    const s = await signup(t.app);
    const inject = (method: "GET" | "POST", url: string, payload?: object) =>
      t.app.inject({ method, url, headers: { cookie: s.cookie }, ...(payload ? { payload } : {}) });
    // Someone already uses the name Maple: the pack's coordinator gets "Maple 2".
    await inject("POST", "/agents", { name: "Maple" });

    expect((await inject("POST", "/packs/store-operator/simulate", {})).statusCode).toBe(409);
    const first = (await inject("POST", "/packs/store-operator/install")).json();
    expect(first).toMatchObject({ agents: 7, rules: 4, schedules: 3 });
    expect(first.created).toEqual([
      "Maple 2",
      "Scout",
      "Quill",
      "Spark",
      "Pixel",
      "Haven",
      "Ledger",
    ]);
    expect((await inject("POST", "/packs/store-operator/install")).json()).toMatchObject({
      agents: 7,
      rules: 0,
      schedules: 0,
      created: [],
    });
    const guarded = await tryLocked(
      t.db,
      `pack-install:${s.me.workspaceId}:store-operator`,
      async () => inject("POST", "/packs/store-operator/install"),
    );
    expect(guarded.locked && guarded.value.statusCode).toBe(409);
    expect(
      (await inject("POST", "/packs/store-operator/simulate", { day: "2026-02-30" })).statusCode,
    ).toBe(400);

    const sched = (await inject("GET", "/schedules"))
      .json()
      .schedules.filter((x: { systemKey: string | null }) => !x.systemKey);
    expect(
      sched
        .map((x: { definition: { name: string; cronExpr: string } }) => [
          x.definition.name,
          x.definition.cronExpr,
        ])
        .sort(),
    ).toEqual([
      ["Daily profit report", "0 8 * * *"],
      ["Hourly order check", "0 * * * *"],
      ["Weekly bin-picker", "0 9 * * 1"],
    ]);
    const rules = (await inject("GET", "/rules")).json().rules.map((r: { text: string }) => r.text);
    expect(rules).toEqual(
      expect.arrayContaining(["Ask a human before any refund", "Spark asks before spending money"]),
    );
    expect((await inject("GET", "/packs")).json().packs[0]).toMatchObject({
      name: "store-operator",
      installed: true,
    });

    const sim = await inject("POST", "/packs/store-operator/simulate", {
      day: "2026-10-17",
      seed: 7,
    });
    expect(sim.statusCode).toBe(200);
    const day = sim.json();
    expect(day.markdown).toContain("# Daily profit report — 2026-10-17");
    expect(day.report.flags).toContain("Quiet Corner has earned nothing in 7 days.");
    expect(
      day.timeline.filter((e: { what: string }) => e.what.startsWith("Hourly order check")),
    ).toHaveLength(24);
    const evs = (await inject("GET", "/events?limit=1000")).json().events as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    expect(evs.find((e) => e.type === "pack.report")?.payload).toMatchObject({
      pack: "store-operator",
      day: "2026-10-17",
    });
    // The coordinator keeps the report as a memory.
    const maple = (await inject("GET", "/agents"))
      .json()
      .agents.find((a: { name: string }) => a.name === "Maple 2");
    const facts = (await inject("GET", `/memory?agentId=${maple.id}`)).json().facts;
    expect(facts.some((f: { text: string }) => f.text.includes("Daily profit report"))).toBe(true);

    // Real mode needs the store secrets in the vault.
    const real = await inject("POST", "/packs/store-operator/simulate", { real: true });
    expect(real.statusCode).toBe(422);
    expect(real.json().message).toContain("SHOPIFY_TOKEN");
    // Workspace membership alone cannot bypass per-secret access grants in real mode.
    await t.db.pool.query("update users set role='user' where id=$1", [s.me.userId]);
    try {
      const forbidden = await inject("POST", "/packs/store-operator/simulate", { real: true });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().error).toBe("not_allowed");
    } finally {
      await t.db.pool.query("update users set role='owner' where id=$1", [s.me.userId]);
    }
  });
});
