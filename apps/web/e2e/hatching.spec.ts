import { expect, test } from "@playwright/test";
import { fakeModels } from "./fake-models.js";

test("hatching: from the egg to a self-named agent that finished its first task", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`;

  await page.goto("/");
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("e2e-password-1234");
  await page.getByRole("button", { name: "Create account" }).click();

  // No agents yet, so hatching starts on its own.
  await expect(page.getByRole("heading", { name: "Something is about to hatch!" })).toBeVisible();

  // Deterministic, free models for this workspace (the page's session cookie authorises the call).
  const put = await page.request.put("/api/settings/llm", { data: fakeModels("Biscuit") });
  expect(put.status()).toBe(200);
  await page.getByRole("button", { name: "Let's go" }).click();

  await page.getByRole("button", { name: /Run my shop/ }).click();
  await page.getByRole("button", { name: "Next" }).click();

  await page.getByRole("button", { name: "cat", exact: true }).click();
  await page.getByRole("button", { name: "mint", exact: true }).click();
  await page.getByRole("button", { name: "scarf", exact: true }).click();
  await expect(page.getByRole("img", { name: "a mint cat" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();

  for (const answer of ["Warm and kind", "Careful", "Often", "Loves puns"]) {
    await page.getByRole("button", { name: answer }).click();
  }

  for (let left = 3; left >= 1; left--) {
    await page.getByRole("button", { name: `Tap the egg ${left} more times` }).click();
  }

  await expect(page.getByRole("heading", { name: /I just hatched/ })).toBeVisible();
  await page.getByRole("button", { name: /^Biscuit/ }).click();

  await expect(page.getByRole("heading", { name: "Meet Biscuit!" })).toBeVisible();
  await expect(page.getByTestId("first-task")).toHaveText("Hi! I'm Biscuit. I'll keep your shop tidy and friendly.", { timeout: 90_000 });
  await page.getByRole("button", { name: "Go to my desk" }).click();

  const card = page.getByTestId("agent-card").filter({ hasText: "Biscuit" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("img", { name: /Biscuit, a mint cat/ })).toBeVisible();

  // Clean up the computer so repeated runs do not pile up containers.
  const agents = (await (await page.request.get("/api/agents")).json()) as { agents: { id: string }[] };
  for (const a of agents.agents) await page.request.delete(`/api/agents/${a.id}`);
});
