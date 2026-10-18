import { expect, test } from "@playwright/test";
test("connection review, per-tool policies and scoped token controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByLabel("Email").fill(`mcp-${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("e2e-password-1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Something is about to hatch!" })).toBeVisible();
  const agent = await (await page.request.post("/api/agents", { data: { name: "Pia" } })).json();
  const token = await (
    await page.request.post("/api/settings/api-keys", {
      data: { name: "Local MCP", scopes: ["mcp:tasks:read"] },
    })
  ).json();
  await page.request.put("/api/vault/secrets", { data: { name: "MCP_LOCAL", value: token.key } });
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const section = page.locator("section[aria-labelledby=connections-title]");
    await section.getByLabel("Connection name", { exact: true }).fill("My local tools");
    await section.getByLabel("Server URL").fill("http://localhost:3000/mcp");
    await section.getByLabel("Vault token name (optional)").fill("MCP_LOCAL");
    await section.getByRole("button", { name: "Add connection", exact: true }).click();
    const card = section.locator("article").filter({ hasText: "My local tools" });
    await card.getByRole("button", { name: "Inspect tools", exact: true }).click();
    await expect(card.getByText("No findings", { exact: false })).toBeVisible({ timeout: 15000 });
    await expect(card.locator("fieldset")).toHaveCount(7);
    await card.getByRole("button", { name: "Approve this version" }).click();
    await expect(card.getByRole("status")).toContainText("Approved");
    await section.getByLabel("Token name", { exact: true }).fill("Browser client");
    await section.getByRole("button", { name: "Create token", exact: true }).click();
    await expect(section.locator("output")).toContainText("nb_");
    await section
      .locator("div")
      .filter({ has: page.getByText("Browser client", { exact: false }) })
      .last()
      .getByRole("button", { name: "Revoke token" })
      .click();
    await expect(section.locator("output")).toHaveCount(0);
    await card.getByRole("button", { name: "Remove connection" }).click();
    await expect(card).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
    await page.request.delete("/api/vault/secrets/MCP_LOCAL");
  }
});
