import { expect, test } from "@playwright/test";
import { fakeModels } from "./fake-models.js";

test("schedules preview, save, pause, run, history and YAML export", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByLabel("Email").fill(`schedule-${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("e2e-password-1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Something is about to hatch!" })).toBeVisible();
  await page.request.put("/api/settings/llm", { data: fakeModels("Pia") });
  const agentResponse = await page.request.post("/api/agents", {
    data: { name: "Pia", autonomyLevel: "act_within_limits" },
  });
  expect(agentResponse.status()).toBe(201);
  const agent = (await agentResponse.json()) as { id: string };
  try {
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Schedules", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Schedules", exact: true })).toBeVisible();
    const form = page.locator("#schedule-editor");
    await form.getByLabel("Name", { exact: true }).fill("Morning invoices");
    await form
      .getByLabel("What should it do?", { exact: true })
      .fill("Summarize the invoices read-only");
    await form.getByLabel("Describe the timing").fill("every weekday at 9am");
    await form.getByRole("button", { name: "Preview next runs" }).click();
    await expect(form.getByRole("heading", { name: "Next five runs" })).toBeVisible();
    await expect(form.getByLabel("Cron expression", { exact: true })).toHaveValue("0 9 * * 1-5");
    await form.getByRole("button", { name: "Confirm and save" }).click();
    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: "Morning invoices", exact: true }) });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(card.getByText("Paused", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Resume", exact: true }).click();
    await card.getByRole("button", { name: "Dry run", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Summarize the invoices" }),
    ).toBeVisible();
    await card.getByRole("button", { name: "Run now", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get("/api/schedules/runs")).json()) as {
              runs: { status: string }[];
            }
          ).runs.some((r) => r.status === "done"),
        { timeout: 30000 },
      )
      .toBe(true);
    const exported = await page.request.get("/api/schedules/export");
    expect(exported.status()).toBe(200);
    expect(await exported.text()).toContain("Morning invoices");
    await page.screenshot({ path: "test-results/schedules.png", fullPage: true });
    await form.getByLabel("Name", { exact: true }).fill("Frequent check");
    await form.getByLabel("What should it do?", { exact: true }).fill("Summarize updates");
    await form.getByLabel("Cron expression", { exact: true }).fill("* * * * *");
    await form.getByRole("button", { name: "Preview next runs" }).click();
    await expect(form.getByText(/Frequent schedule:/)).toBeVisible();
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
  }
});
