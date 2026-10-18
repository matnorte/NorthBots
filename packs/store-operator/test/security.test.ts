import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getJson, type Fetch, type Order, type Payment } from "../src/integrations.js";
import { MetaAds } from "../src/adapters/meta.js";
import { ShopifyStore } from "../src/adapters/shopify.js";
import { profitReport } from "../src/profit.js";
import { simulateDay } from "../src/simulate.js";
import { fakeIntegrations } from "../src/fakes.js";

const json = (body: unknown, headers?: RequestInit["headers"]) =>
  new Response(JSON.stringify(body), { headers });
const since = new Date("2026-10-17T00:00:00Z");
const until = new Date("2026-10-18T00:00:00Z");

describe("store adapter security and completeness", () => {
  it("refuses Shopify pagination to another origin before forwarding the token", async () => {
    const f = vi
      .fn<Fetch>()
      .mockImplementation(async (input) =>
        String(input).includes("orders.json")
          ? json({ orders: [] }, { link: '<https://attacker.test/orders>; rel="next"' })
          : json({ products: [] }),
      );
    const shop = new ShopifyStore({
      shop: "https://store.test",
      accessToken: "secret",
      storeName: "A",
      fetch: f,
    });
    await expect(shop.orders(since, until)).rejects.toThrow("changed origin");
    expect(
      f.mock.calls.every(([url]) => new URL(String(url)).origin === "https://store.test"),
    ).toBe(true);
  });

  it("refuses Meta pagination to another origin and strips every token from allowed links", async () => {
    const f = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(
        json({
          data: [],
          paging: {
            next: "https://graph.test/next?access_token=one&access_token=two&after=1",
          },
        }),
      )
      .mockResolvedValueOnce(json({ data: [], paging: { next: "https://attacker.test/steal" } }));
    const ads = new MetaAds({
      baseUrl: "https://graph.test",
      adAccountId: "1",
      accessToken: "secret",
      fetch: f,
    });
    await expect(ads.spend(since, until)).rejects.toThrow("changed origin");
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(f.mock.calls[1]![0])).toBe("https://graph.test/next?after=1");
    expect(f.mock.calls[1]![1]).toMatchObject({
      headers: { Authorization: "Bearer secret" },
      redirect: "error",
    });
  });

  it("does not follow HTTP redirects with credentials", async () => {
    let leaked = false;
    const server = createServer((req, res) => {
      if (req.url === "/start") res.writeHead(302, { location: "/next" }).end();
      else {
        leaked = true;
        res.end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await expect(
        getJson(fetch, `${base}/start`, { headers: { "X-Shopify-Access-Token": "secret" } }),
      ).rejects.toThrow();
      expect(leaked).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps reflected secrets out of API failure and invalid-JSON errors", async () => {
    const secret = "customer-token-must-never-be-logged";
    const failed = vi.fn<Fetch>().mockImplementation(async () => new Response(secret, { status: 401 }));
    await expect(getJson(failed, "https://api.test/orders")).rejects.toThrow("HTTP 401");
    await expect(getJson(failed, "https://api.test/orders")).rejects.not.toThrow(secret);
    const invalid = vi.fn<Fetch>().mockResolvedValue(new Response(secret));
    await expect(getJson(invalid, "https://api.test/orders")).rejects.toThrow(
      "API returned invalid JSON",
    );
  });

  it("rejects repeated pages instead of silently returning a truncated report", async () => {
    const f = vi.fn<Fetch>().mockImplementation(async () =>
      json({
        data: [],
        paging: {
          next: "https://graph.test/repeated",
        },
      }),
    );
    await expect(
      new MetaAds({
        baseUrl: "https://graph.test",
        adAccountId: "1",
        accessToken: "secret",
        fetch: f,
      }).spend(since, until),
    ).rejects.toThrow("repeated a page");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("keeps the upper order boundary exclusive for hourly checks", async () => {
    const f = vi.fn<Fetch>().mockImplementation(async (input) =>
      json(
        String(input).includes("orders.json")
          ? {
              orders: [since, until].map((date, id) => ({
                id,
                created_at: date.toISOString(),
                financial_status: "paid",
                cancelled_at: null,
                total_price: "10",
                currency: "BRL",
                line_items: [],
              })),
            }
          : { products: [] },
      ),
    );
    const orders = await new ShopifyStore({
      shop: "https://store.test",
      accessToken: "secret",
      storeName: "A",
      fetch: f,
    }).orders(since, until);
    expect(orders.map((o) => o.id)).toEqual(["0"]);
  });
});

describe("profit report safeguards", () => {
  const order: Order = {
    id: "1",
    store: "A",
    createdAt: since.toISOString(),
    status: "paid",
    total: 100,
    currency: "BRL",
    items: [],
  };
  const payment = (status: Payment["status"], amount: number): Payment => ({
    id: status,
    orderId: "1",
    status,
    amount,
    fee: 0,
    method: "pix",
    createdAt: since.toISOString(),
  });
  it("includes unattributed ad spend and does not treat pending or partial payments as reconciled", () => {
    const input = {
      day: "2026-10-17",
      stores: ["A"],
      orders: [order],
      payments: [payment("pending", 100), payment("approved", 20)],
      adSpend: [
        {
          campaignId: "c",
          campaign: "brand",
          store: null,
          spend: 25,
          clicks: 1,
          purchases: 0,
          day: "2026-10-17",
        },
      ],
    };
    const report = profitReport(input);
    expect(report.total).toMatchObject({ revenue: 100, adSpend: 25, profit: 75 });
    expect(report.unpaidOrders).toEqual(["1"]);
    expect(report.flags.some((f) => f.includes("Unattributed"))).toBe(true);
    expect(profitReport({ ...input, payments: [payment("approved", 100)] }).unpaidOrders).toEqual(
      [],
    );
  });
  it("refuses to sum incompatible currencies or roll invalid dates into another month", async () => {
    expect(() =>
      profitReport({
        day: "2026-10-17",
        stores: ["A"],
        orders: [order, { ...order, id: "2", currency: "USD" }],
        payments: [],
        adSpend: [],
      }),
    ).toThrow("different currencies");
    await expect(simulateDay(fakeIntegrations(), "2026-02-30")).rejects.toThrow("valid YYYY-MM-DD");
  });
});
