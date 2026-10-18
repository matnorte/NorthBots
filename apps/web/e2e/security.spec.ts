import { expect, test } from "@playwright/test";
test("security checks, grant revocation, labels, canaries and signed audit", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByLabel("Email").fill(`security-${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("e2e-password-1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Something is about to hatch!" })).toBeVisible();
  const agent = await (await page.request.post("/api/agents", { data: { name: "Pia" } })).json();
  await page.request.put("/api/vault/secrets", {
    data: { name: "SHOP_TOKEN", value: "not-a-real-provider-token" },
  });
  const upload = await page.request.post("/api/files", {
    multipart: {
      file: {
        name: "private.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("private customer data"),
      },
    },
  });
  expect(upload.status()).toBe(201);
  const file = await upload.json();
  try {
    await page.getByRole("button", { name: "Security", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Security & trust" })).toBeVisible();
    await page.getByLabel("Resource", { exact: true }).selectOption("secret:SHOP_TOKEN");
    await page.getByRole("button", { name: "Grant access" }).click();
    const grant = page
      .locator("div")
      .filter({ has: page.getByText("secret:SHOP_TOKEN", { exact: true }) })
      .filter({ has: page.getByRole("button", { name: "Revoke", exact: true }) })
      .last();
    await grant.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByText("Expired or revoked", { exact: true })).toBeVisible();
    await page.getByLabel("Resource ID", { exact: true }).selectOption(file.id);
    await page.getByLabel("Label", { exact: true }).selectOption("secret");
    await page.getByRole("button", { name: "Save label", exact: true }).click();
    const blocked = await page.request.post("/api/letters", {
      data: { type: "fyi", body: "Please read", toAgentId: agent.id, attachments: [file.id] },
    });
    expect(blocked.status()).toBeGreaterThanOrEqual(400);
    await page.getByLabel("Name", { exact: true }).fill("Customer-data tripwire");
    await page.getByRole("button", { name: "Create tripwire" }).click();
    const token = await page.locator("output").innerText();
    expect(token).toMatch(/^nb_canary_/);
    expect((await page.request.get(`/api/canary/${token}`)).status()).toBe(200);
    await page.getByRole("button", { name: "Security", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Security", exact: true }).click();
    await expect(page.getByText("Triggered", { exact: false })).toBeVisible();
    const audit = await (await page.request.get("/api/security/audit")).json();
    expect(audit.algorithm).toBe("Ed25519");
    expect(audit.signature).toBeTruthy();
    await page.screenshot({ path: "test-results/security.png", fullPage: true });
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
    await page.request.delete("/api/vault/secrets/SHOP_TOKEN");
  }
});
