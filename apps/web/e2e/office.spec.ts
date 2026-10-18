import { expect, test, type Page } from "@playwright/test";

const sh = (command: string) => ({ toolCalls: [{ name: "terminal", arguments: { command } }] });
const models = {
  providers: [
    {
      name: "fast",
      type: "fake",
      kind: "local",
      models: ["m"],
      fake: {
        reply: "{}",
        match: [
          { contains: "You plan work", text: JSON.stringify({ steps: ["do it"] }) },
          { contains: "You check an agent", text: JSON.stringify({ summary: "ok", claims: [{ text: "done", status: "verified", evidence: "exit 0" }] }) },
        ],
      },
    },
    {
      name: "smart",
      type: "fake",
      kind: "local",
      models: ["m"],
      fake: {
        script: [{ text: "draft" }, { text: "Done." }],
        match: [
          { contains: "Reply with one short message as yourself", text: "Happy to help." },
          { contains: "Take your time", script: [sh("sleep 5"), sh("echo after > after.txt"), { text: "draft" }, { text: "Done slowly." }] },
        ],
      },
    },
  ],
  aliases: { "northbot-fast": ["fast/m"], "northbot-smart": ["smart/m"] },
  redactPii: false,
  pricing: {},
  dailyBudgetUsd: null,
};

type Office = NonNullable<Window["__northbotOffice"]>;
const office = <T>(page: Page, fn: (o: Office) => T) => page.evaluate((src) => new Function("o", `return (${src})(o)`)(window.__northbotOffice), fn.toString()) as Promise<T>;
const until = async <T>(page: Page, fn: (o: Office) => T, ok: (v: T) => boolean, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await office(page, fn);
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`office never reached the expected state; last: ${JSON.stringify(v)}`);
    await page.waitForTimeout(150);
  }
};
const dist = (a: { x: number; y: number } | null, b: { x: number; y: number } | null) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity);

test("the office renders from the event stream, and lifting a busy agent pauses it", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByLabel("Email").fill(`office-${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("e2e-password-1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Something is about to hatch!" })).toBeVisible();
  expect((await page.request.put("/api/settings/llm", { data: models })).status()).toBe(200);
  const agent = async (name: string, avatar: object) => (await (await page.request.post("/api/agents", { data: { name, autonomyLevel: "act_within_limits", avatar } })).json()) as { id: string };
  const ana = await agent("Ana", { shape: "star", color: "sunflower" });
  const bo = await agent("Bo", { shape: "hexagon", color: "teal" });

  await page.getByRole("button", { name: "Office", exact: true }).click();
  await until(page, (o) => o?.ready && Object.keys(o.state().agents).length, (n) => n === 2);
  await until(page, (o) => o.settled(), Boolean);

  // A message in a room → a speech bubble, and the agent walks to the meeting room.
  const room = (await (await page.request.post("/api/rooms", { data: { name: "Shop", agentIds: [ana.id, bo.id], turnRule: "mentions" } })).json()) as { id: string };
  await page.request.post(`/api/rooms/${room.id}/messages`, { data: { content: "@Ana hello there" } });
  const said = await until(page, (o) => o.state().agents[Object.values(o.state().agents).find((a) => a.name === "Ana")!.id], (a) => a?.bubble?.text === "Happy to help.");
  expect(said?.zone).toBe("meeting_room");
  await until(page, (o) => o.settled(), Boolean);
  const [anaAt, meeting] = await Promise.all([office(page, (o) => o.screenOf(Object.values(o.state().agents).find((a) => a.name === "Ana")!.id)), office(page, (o) => o.zoneScreenOf("meeting_room"))]);
  expect(dist(anaAt, meeting)).toBeLessThan(150);

  // A letter → it travels from the post box to Bo's desk.
  const letter = (await (await page.request.post("/api/letters", { data: { type: "request", body: "Please check the shelves.", toAgentId: bo.id } })).json()) as { id: string };
  const moved = await until(page, (o) => o.state().letters, (ls) => (ls as Record<string, { at: string; to: string | null }>)[letter.id]?.at === "desk");
  expect(moved[letter.id]).toMatchObject({ to: bo.id, path: ["post_box", "mail_desk", "desk"] });
  const [letterAt, postBox] = await Promise.all([page.evaluate((id) => window.__northbotOffice!.letterScreenOf(id), letter.id), office(page, (o) => o.zoneScreenOf("post_box"))]);
  expect(dist(letterAt, postBox)).toBeGreaterThan(60);
  await until(page, (o) => o.state().letters, (ls) => ["answered", "delivered"].includes((ls as Record<string, { status: string }>)[letter.id]?.status ?? ""), 60_000);

  // Hibernating a computer → the agent goes to the break room, and the board says why.
  await page.request.post(`/api/agents/${bo.id}/computer/hibernate`);
  const rest = await until(page, (o) => o.view().breakRoom, (r) => r.length === 1);
  expect(rest[0]).toMatchObject({ name: "Bo" });
  expect(rest[0]!.why).toBeTruthy();
  await until(page, (o) => o.settled(), Boolean);
  const [boAt, breakRoom] = await Promise.all([page.evaluate((id) => window.__northbotOffice!.screenOf(id), bo.id), office(page, (o) => o.zoneScreenOf("break_room"))]);
  expect(dist(boAt, breakRoom)).toBeLessThan(150);

  // The scene state is a pure function of the event log.
  const events = ((await (await page.request.get("/api/events?limit=1000")).json()) as { events: { id: number }[] }).events;
  const lastId = events.at(-1)!.id;
  await until(page, (o) => o.state().lastEventId, (id) => id >= lastId);
  // What the server's log says, reduced, equals what the office received, reduced...
  const fromLog = await page.evaluate((evs) => JSON.stringify(window.__northbotOffice!.reduce(evs as never)), events);
  const received = await page.evaluate((last) => JSON.stringify(window.__northbotOffice!.reduce(window.__northbotOffice!.events().filter((e) => e.id <= last))), lastId);
  expect(JSON.parse(received)).toEqual(JSON.parse(fromLog));
  // ...and the live state (built event by event) equals reducing everything it received.
  const [live, batch] = await office(page, (o) => [JSON.stringify(o.state()), JSON.stringify(o.reduce(o.events()))]);
  expect(live).toBe(batch);

  // Lifting a busy agent pauses its task at the next safe point and makes it annoyed.
  const task = (await (await page.request.post(`/api/agents/${ana.id}/tasks`, { data: { goal: "Take your time, then write after.txt" } })).json()) as { id: string };
  await until(page, (o) => o.state().board, (b) => (b as { id: string; status: string }[]).some((t) => t.id === task.id && t.status === "running"));
  await until(page, (o) => o.settled(), Boolean);
  const grab = await page.evaluate((id) => window.__northbotOffice!.screenOf(id), ana.id);
  expect(grab).not.toBeNull();
  await page.mouse.move(grab!.x, grab!.y);
  await page.mouse.down();
  await page.mouse.move(grab!.x + 20, grab!.y - 10, { steps: 4 });
  await page.mouse.move(grab!.x + 40, grab!.y - 30, { steps: 4 });
  await until(page, (o) => o.state().agents[Object.values(o.state().agents).find((a) => a.name === "Ana")!.id]?.held, Boolean);
  const annoyed = await until(page, (o) => Object.values(o.state().agents).find((a) => a.name === "Ana")!.mood, (m) => m === "annoyed", 15_000);
  expect(annoyed).toBe("annoyed");
  await page.waitForTimeout(7000);
  const execs = ((await (await page.request.get("/api/events?limit=1000")).json()) as { events: { type: string; agentId: string | null; payload: { by?: string; command?: string } }[] }).events.filter(
    (e) => e.type === "terminal.exec" && e.agentId === ana.id && e.payload.by === "agent",
  );
  expect(execs.map((e) => e.payload.command)).toEqual(["sleep 5"]);
  expect(((await (await page.request.get(`/api/tasks/${task.id}`)).json()) as { status: string }).status).toBe("running");
  // Put her back at her desk: the task carries on and finishes.
  const desk = await office(page, (o) => o.zoneScreenOf("desk"));
  await page.mouse.move(desk!.x, desk!.y, { steps: 6 });
  await page.mouse.up();
  await until(page, (o) => o.state().board, (b) => (b as { id: string; status: string }[]).some((t) => t.id === task.id && t.status === "done"), 60_000);

  // The plain list view lists the same agents.
  const names = await office(page, (o) => o.view().agents.map((a) => a.name));
  await page.getByRole("tab", { name: "List" }).click();
  const rows = page.getByTestId("office-list").locator("tbody tr");
  await expect(rows).toHaveCount(names.length);
  for (const [i, name] of names.entries()) await expect(rows.nth(i)).toContainText(name);
});
