import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeIntegrations, InstagramPublisher, MercadoPagoPayments, MetaAds, profitReport, quietStores, reportMarkdown, ShopifyStore, simulateDay, STORE_OPERATOR, type Order } from "../src/index.js";

/** A mock of the three public APIs, recording every request. */
const seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let base = "";
const server = createServer((req, res: ServerResponse) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    const u = new URL(req.url ?? "/", base);
    const json = (data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    // Shopify
    if (u.pathname === "/admin/api/2024-10/orders.json") {
      if (u.searchParams.get("page_info") === "p2")
        return json({ orders: [{ id: 3, created_at: "2026-10-17T15:00:00Z", cancelled_at: null, financial_status: "refunded", total_price: "59.90", currency: "BRL", line_items: [{ sku: "TWL", title: "Towels", quantity: 1, price: "59.90" }] }] });
      return json(
        {
          orders: [
            { id: 1, created_at: "2026-10-17T12:00:00Z", cancelled_at: null, financial_status: "paid", total_price: "179.80", currency: "BRL", line_items: [{ sku: "MUG", title: "Mug", quantity: 2, price: "89.90" }] },
            { id: 2, created_at: "2026-10-17T13:00:00Z", cancelled_at: null, financial_status: "pending", total_price: "89.90", currency: "BRL", line_items: [{ sku: "MUG", title: "Mug", quantity: 1, price: "89.90" }] },
          ],
        },
        { link: `<${base}/admin/api/2024-10/orders.json?limit=250&page_info=p2>; rel="next"` },
      );
    }
    if (u.pathname === "/admin/api/2024-10/products.json" && req.method === "GET")
      return json({ products: [{ id: 10, title: "Mug", variants: [{ id: 11, sku: "MUG", price: "89.90", inventory_quantity: 5, inventory_item_id: 111 }, { id: 12, sku: "TWL", price: "59.90", inventory_quantity: 2, inventory_item_id: 112 }] }] });
    if (u.pathname === "/admin/api/2024-10/inventory_items.json") return json({ inventory_items: [{ id: 111, cost: "31.00" }, { id: 112, cost: "18.50" }] });
    if (u.pathname === "/admin/api/2024-10/products.json" && req.method === "POST") {
      const p = JSON.parse(body).product;
      return json({ product: { id: 20, title: p.title, variants: [{ id: 21, sku: p.variants[0].sku, price: p.variants[0].price, inventory_quantity: 0, inventory_item_id: 211 }] } });
    }
    // Mercado Pago
    if (u.pathname === "/v1/payments/search") {
      const offset = Number(u.searchParams.get("offset"));
      const results =
        offset === 0
          ? [{ id: 900, status: "approved", transaction_amount: 179.8, fee_details: [{ amount: 8.97, type: "mercadopago_fee" }], external_reference: "1", payment_method_id: "pix", date_created: "2026-10-17T12:01:00Z" }]
          : [{ id: 901, status: "refunded", transaction_amount: 59.9, fee_details: [], external_reference: "3", payment_method_id: "visa", date_created: "2026-10-17T15:01:00Z" }];
      return json({ paging: { total: 51, limit: 50, offset }, results });
    }
    // Meta
    if (u.pathname === "/v21.0/act_77/insights")
      return json({
        data: [
          { campaign_id: "c1", campaign_name: "store:Lumen Goods - mugs", spend: "42.10", clicks: "200", actions: [{ action_type: "purchase", value: "3" }], date_start: "2026-10-17" },
          { campaign_id: "c2", campaign_name: "brand awareness", spend: "5", clicks: "10", date_start: "2026-10-17" },
        ],
      });
    if (u.pathname === "/v21.0/555/media") return json({ id: "container-1" });
    if (u.pathname === "/v21.0/555/media_publish") return json({ id: "ig-post-1" });
    res.writeHead(404).end("{}");
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const since = new Date("2026-10-17T00:00:00Z");
const until = new Date("2026-10-18T00:00:00Z");

describe("adapters (against mock APIs)", () => {
  it("Shopify: pages through orders, maps statuses and unit costs, and creates draft listings", async () => {
    const shop = new ShopifyStore({ shop: base, accessToken: "shpat_test", storeName: "Lumen Goods" });
    const orders = await shop.orders(since, until);
    expect(orders.map((o) => [o.id, o.status, o.total])).toEqual([
      ["1", "paid", 179.8],
      ["2", "pending", 89.9],
      ["3", "refunded", 59.9],
    ]);
    expect(orders[0]!.items[0]).toMatchObject({ sku: "MUG", qty: 2, price: 89.9, cost: 31 });
    const req = seen.find((r) => r.url.startsWith("/admin/api/2024-10/orders.json"))!;
    expect(req.headers["x-shopify-access-token"]).toBe("shpat_test");
    expect(req.url).toContain("status=any");
    const listing = await shop.createListing({ store: "Lumen Goods", title: "Planter", description: "<p>Clay</p>", sku: "PLN", price: 129 });
    expect(listing).toMatchObject({ sku: "PLN", price: 129 });
    expect(JSON.parse(seen.find((r) => r.method === "POST" && r.url.endsWith("products.json"))!.body).product.status).toBe("draft");
  });

  it("Mercado Pago: pages through payments and sums the fees", async () => {
    const mp = new MercadoPagoPayments({ accessToken: "APP_USR-test", baseUrl: base });
    const pays = await mp.payments(since, until);
    expect(pays).toEqual([
      { id: "900", orderId: "1", status: "approved", amount: 179.8, fee: 8.97, method: "pix", createdAt: "2026-10-17T12:01:00Z" },
      { id: "901", orderId: "3", status: "refunded", amount: 59.9, fee: 0, method: "visa", createdAt: "2026-10-17T15:01:00Z" },
    ]);
    const req = seen.find((r) => r.url.startsWith("/v1/payments/search"))!;
    expect(req.headers.authorization).toBe("Bearer APP_USR-test");
    expect(req.url).toContain("range=date_created");
  });

  it("Meta: reads campaign insights with the token in a header, and publishes to Instagram in two steps", async () => {
    const ads = new MetaAds({ adAccountId: "77", accessToken: "EAAtest", baseUrl: base });
    const spend = await ads.spend(since, until);
    expect(spend).toEqual([
      { campaignId: "c1", campaign: "store:Lumen Goods - mugs", store: "Lumen Goods", spend: 42.1, clicks: 200, purchases: 3, day: "2026-10-17" },
      { campaignId: "c2", campaign: "brand awareness", store: null, spend: 5, clicks: 10, purchases: 0, day: "2026-10-17" },
    ]);
    const req = seen.find((r) => r.url.startsWith("/v21.0/act_77/insights"))!;
    expect(req.url).not.toContain("EAAtest");
    expect(req.headers.authorization).toBe("Bearer EAAtest");
    expect(decodeURIComponent(req.url)).toContain('"since":"2026-10-17","until":"2026-10-17"');
    const ig = new InstagramPublisher({ igUserId: "555", accessToken: "EAAtest", baseUrl: base });
    expect((await ig.publish("New mugs!", "https://cdn.example.test/mug.jpg")).id).toBe("ig-post-1");
    expect(JSON.parse(seen.find((r) => r.url === "/v21.0/555/media_publish")!.body)).toEqual({ creation_id: "container-1" });
  });
});

describe("profit and rules", () => {
  const order = (id: string, store: string, status: Order["status"], total: number, cost: number): Order => ({
    id,
    store,
    status,
    total,
    currency: "BRL",
    createdAt: "2026-10-17T10:00:00Z",
    items: [{ sku: "X", title: "X", qty: 1, price: total, cost }],
  });

  it("computes profit per store from paid orders, fees, cost of goods and ads", () => {
    const r = profitReport({
      day: "2026-10-17",
      stores: ["A", "B"],
      orders: [order("1", "A", "paid", 100, 40), order("2", "A", "refunded", 50, 20), order("3", "A", "pending", 30, 10)],
      payments: [
        { id: "p1", orderId: "1", status: "approved", amount: 100, fee: 5, method: "pix", createdAt: "" },
        { id: "p2", orderId: "2", status: "refunded", amount: 50, fee: 1, method: "pix", createdAt: "" },
      ],
      adSpend: [
        { campaignId: "c", campaign: "store:A - x", store: "A", spend: 20, clicks: 1, purchases: 1, day: "" },
        { campaignId: "d", campaign: "store:B - y", store: "B", spend: 10, clicks: 1, purchases: 0, day: "" },
      ],
      quietStores: ["B"],
    });
    expect(r.stores[0]).toMatchObject({ store: "A", orders: 3, revenue: 100, refunds: 50, costOfGoods: 40, paymentFees: 6, adSpend: 20, profit: 34, margin: 0.34, roas: 5 });
    expect(r.stores[1]).toMatchObject({ store: "B", revenue: 0, profit: -10, roas: 0 });
    expect(r.total).toMatchObject({ revenue: 100, profit: 24 });
    expect(r.flags).toEqual(["B has earned nothing in 7 days.", "B: ads cost more than they brought in (ROAS 0). Consider pausing or cutting the budget."]);
    expect(reportMarkdown(r)).toContain("| **Total** | 3 | 100.00 |");
  });

  it("flags a store that earned nothing in 7 days", () => {
    expect(quietStores(["A", "B"], [order("1", "A", "paid", 10, 1), order("2", "B", "refunded", 10, 1)])).toEqual(["B"]);
  });

  it("ships a coordinator, six specialists, the three routines and safety rules", () => {
    expect(STORE_OPERATOR.agents.map((a) => a.role)).toEqual(["Coordinator", "Product research", "Listings", "Ads", "Instagram posting", "Customer support", "Payment reconciliation"]);
    expect(STORE_OPERATOR.schedules.map((s) => [s.name, s.cronExpr])).toEqual([
      ["Daily profit report", "0 8 * * *"],
      ["Hourly order check", "0 * * * *"],
      ["Weekly bin-picker", "0 9 * * 1"],
    ]);
    expect(new Set(STORE_OPERATOR.agents.map((a) => `${a.avatar.shape}/${a.avatar.color}`)).size).toBe(7);
  });
});

describe("a simulated day on fake integrations", () => {
  it("runs the routines and produces the profit report, flagging the quiet store", async () => {
    const day = await simulateDay(fakeIntegrations({ seed: 7 }), "2026-10-17");
    expect(day.report.stores.map((s) => s.store)).toEqual(["Lumen Goods", "Quiet Corner"]);
    expect(day.report.stores[0]!.revenue).toBeGreaterThan(0);
    expect(day.report.stores[1]).toMatchObject({ orders: 0, revenue: 0 });
    expect(day.report.flags).toContain("Quiet Corner has earned nothing in 7 days.");
    expect(day.timeline.filter((e) => e.what.startsWith("Hourly order check"))).toHaveLength(24);
    expect(day.timeline.at(-1)!.agent).toBe("Maple");
    expect(day.awaitingApproval.some((a) => a.startsWith("Publish an Instagram post"))).toBe(true);
    expect(day.awaitingApproval.some((a) => a.includes("Quiet Corner"))).toBe(true);
    expect(day.markdown).toContain("# Daily profit report — 2026-10-17");
    // Same seed, same day: the same report.
    expect((await simulateDay(fakeIntegrations({ seed: 7 }), "2026-10-17")).report).toEqual(day.report);
  });
});
