import { expect, test, type Page } from "@playwright/test";

const agents = [
  { id: "one", name: "Clover", status: "working", avatar: { shape: "circle", color: "mint" } },
  { id: "two", name: "Biscuit", status: "idle", avatar: { shape: "square", color: "tangerine" } },
  { id: "three", name: "Nova", status: "waiting", avatar: { shape: "star", color: "lilac" } },
  { id: "four", name: "Pebble", status: "resting", avatar: { shape: "hexagon", color: "sky" } },
  { id: "five", name: "Maple", status: "working", avatar: { shape: "triangle", color: "coral" } },
  { id: "six", name: "Sunny", status: "idle", avatar: { shape: "semicircle", color: "sunflower" } },
].map((a) => ({
  ...a,
  mood: "content",
  nameLocked: true,
  budgetDailyUsd: 2,
  sandboxId: "preview-computer",
}));

async function fixture(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const data: Record<string, unknown> = {
      "/health": { ok: true },
      "/auth/me": { userId: "preview", workspaceId: "preview", email: "you@workspace.test" },
      "/agents": { agents },
      "/notifications": { notifications: [] },
      "/kill-switch": { active: false },
      "/rooms": { rooms: [] },
      "/letters": { letters: [] },
      "/talks": { talks: [] },
      "/ideas": { ideas: [] },
      "/memory": { facts: [] },
      "/skills": { skills: [] },
      "/approvals": { approvals: [] },
      "/rules": { rules: [] },
      "/mcp/servers": { servers: [] },
      "/settings/api-keys": { keys: [] },
      "/settings": {
        name: "My workspace",
        timezone: "America/Sao_Paulo",
        locale: "en",
        moodsEnabled: true,
        quietHours: null,
        coordinatorAgentId: null,
        ideaBinDays: 30,
      },
      "/agents/one/threads": { threads: [{ id: "thread", title: "A fresh idea" }] },
      "/threads/thread/messages": { messages: [] },
    };
    if (path.endsWith("/mood"))
      return route.fulfill({ json: { mood: "content", cause: "", fix: null, detail: {} } });
    if (path === "/agents/one") return route.fulfill({ json: agents[0] });
    if (path === "/threads/thread/messages" && route.request().method() === "POST")
      return route.fulfill({ status: 503, json: { message: "Try again later" } });
    if (path === "/files")
      return route.fulfill({ json: { id: "attachment", name: "notes.txt", size: 12 } });
    if (!(path in data)) throw new Error(`Unmocked API call: ${path}`);
    return route.fulfill({ json: data[path] });
  });
  await page.goto("/");
  await expect(page.getByTestId("agent-card")).toHaveCount(6);
  await expect
    .poll(() =>
      page
        .locator(".agent-portrait img")
        .evaluateAll((images) =>
          images.every(
            (img) =>
              (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
}

test("agent overview filters, searches, and changes layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await fixture(page);
  await expect(page.getByTestId("agent-card").first().getByRole("img")).toHaveJSProperty(
    "naturalWidth",
    2048,
  );
  await page
    .getByRole("group", { name: "Filter agents by status" })
    .getByRole("button", { name: "Working", exact: true })
    .click();
  await expect(page.getByTestId("agent-card")).toHaveCount(2);
  await page
    .getByRole("group", { name: "Filter agents by status" })
    .getByRole("button", { name: "All agents", exact: true })
    .click();
  await page.getByRole("searchbox", { name: "Search agents…" }).fill("nova");
  await expect(page.getByTestId("agent-card")).toHaveCount(1);
  await page.getByRole("searchbox").fill("missing");
  await expect(page.getByRole("heading", { name: "No teammates found" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByTestId("agent-card")).toHaveCount(6);
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(page.locator(".agents-list")).toBeVisible();
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("mobile navigation and agent layout fit the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await expect(page.locator(".app-sidebar")).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "Rooms", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rooms", exact: true })).toBeVisible();
  await expect(page.locator(".app-sidebar")).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Agents", exact: true }).click();
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("navigation opens every collaboration and knowledge screen", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await fixture(page);
  const nav = page.getByRole("navigation");
  for (const label of ["Approvals", "Rooms", "Letters", "Talks", "Idea bin", "Memory", "Skills"]) {
    await nav.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator("main .page-state")).toBeVisible();
  }
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await expect(page.getByRole("combobox", { name: "Language", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/workspace-settings.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("chat preserves failed drafts and supports removing attachments", async ({ page }) => {
  await fixture(page);
  await page
    .getByTestId("agent-card")
    .filter({ hasText: "Clover" })
    .getByRole("button", { name: "Chat", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Chat with Clover" })).toBeVisible();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Please keep this draft if the connection fails.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be sent");
  await expect(message).toHaveValue("Please keep this draft if the connection fails.");
  await page.getByLabel("Attach a file").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello world"),
  });
  await expect(page.getByRole("button", { name: "Remove notes.txt" })).toBeVisible();
  await page.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(page.locator(".chat-attachment")).toHaveCount(0);
  await page.getByRole("radio", { name: "Do it", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(message).toHaveValue("Please keep this draft if the connection fails.");
  await page.screenshot({
    path: "test-results/workspace-chat.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("agent loading failures offer recovery", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/agents", (route) =>
    route.fulfill({ status: 503, json: { message: "Unavailable" } }),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.unroute("**/api/agents");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("agent-card")).toHaveCount(6);
});

test("office canvas and accessible list show the same team", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.routeWebSocket("**/api/events/stream?*", (ws) => {
    const ts = new Date().toISOString();
    agents.forEach((a, i) =>
      ws.send(
        JSON.stringify({
          kind: "event",
          event: {
            id: i + 1,
            ts,
            type: "agent.created",
            agentId: a.id,
            payload: { name: a.name, avatar: a.avatar },
          },
        }),
      ),
    );
    agents.forEach((a, i) =>
      ws.send(
        JSON.stringify({
          kind: "event",
          event: {
            id: i + 7,
            ts,
            type: "agent.status",
            agentId: a.id,
            payload: { status: a.status },
          },
        }),
      ),
    );
    ws.send(JSON.stringify({ kind: "replay_done" }));
  });
  await fixture(page);
  await page.getByRole("navigation").getByRole("button", { name: "Office", exact: true }).click();
  await expect(page.getByTestId("office-canvas").locator("canvas")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__northbotOffice?.ready)).toBe(true);
  await page.screenshot({
    path: "test-results/workspace-office.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await expect(page.getByTestId("office-list").locator("tbody tr")).toHaveCount(6);
  await expect(page.getByTestId("office-list")).toContainText("Clover");
  expect(errors).toEqual([]);
});

test("chat receives a streamed reply without duplicating messages", async ({ page }) => {
  await fixture(page);
  const user = {
    id: "user-message",
    role: "user",
    content: "Hello",
    attachments: [],
    taskId: null,
  };
  const agent = {
    id: "agent-message",
    role: "agent",
    content: "Hello! Ready to help.",
    attachments: [],
    taskId: null,
  };
  let sent = false;
  await page.route("**/api/threads/thread/messages", async (route) => {
    if (route.request().method() !== "POST")
      return route.fulfill({ json: { messages: sent ? [user, agent] : [] } });
    sent = true;
    const newline = String.fromCharCode(10);
    const body = [
      { event: "user", data: user },
      { event: "delta", data: { text: agent.content } },
      { event: "done", data: agent },
    ]
      .map(
        ({ event, data }) =>
          `event: ${event}${newline}data: ${JSON.stringify(data)}${newline}${newline}`,
      )
      .join("");
    return route.fulfill({ contentType: "text/event-stream", body });
  });
  await page
    .getByTestId("agent-card")
    .filter({ hasText: "Clover" })
    .getByRole("button", { name: "Chat", exact: true })
    .click();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(message).toHaveValue("");
  await expect(page.locator(".chat-message-agent")).toHaveCount(1);
  await expect(page.locator(".chat-message-agent")).toContainText(agent.content);
});
