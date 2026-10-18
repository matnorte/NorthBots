import type { AdSpend, Order, Payment } from "./integrations.js";
import { round2 } from "./integrations.js";

export interface StoreProfit {
  store: string;
  orders: number;
  revenue: number;
  refunds: number;
  costOfGoods: number;
  paymentFees: number;
  adSpend: number;
  profit: number;
  /** profit / revenue, 0 when there is no revenue. */
  margin: number;
  /** Revenue per unit of ad spend, null without spend. */
  roas: number | null;
}

export interface ProfitReport {
  day: string;
  currency: string;
  stores: StoreProfit[];
  total: Omit<StoreProfit, "store">;
  unpaidOrders: string[];
  orphanPayments: string[];
  flags: string[];
}

/** Paid orders count as revenue; refunds subtract; fees come from payments; ads by store. */
export function profitReport(input: {
  day: string;
  stores: string[];
  orders: Order[];
  payments: Payment[];
  adSpend: AdSpend[];
  quietStores?: string[];
}): ProfitReport {
  if (new Set(input.orders.map((o) => o.currency)).size > 1)
    throw new Error("Cannot combine orders in different currencies without exchange rates");
  if (input.orders.some((o) => !input.stores.includes(o.store)))
    throw new Error("An order belongs to a store missing from this report");
  const feeByOrder = new Map<string, number>();
  for (const p of input.payments)
    if (p.orderId) feeByOrder.set(p.orderId, (feeByOrder.get(p.orderId) ?? 0) + p.fee);
  const per = input.stores.map((store): StoreProfit => {
    const orders = input.orders.filter((o) => o.store === store);
    const paid = orders.filter((o) => o.status === "paid");
    const refunded = orders.filter((o) => o.status === "refunded");
    const revenue = paid.reduce((s, o) => s + o.total, 0);
    const refunds = refunded.reduce((s, o) => s + o.total, 0);
    const costOfGoods = paid.reduce(
      (s, o) => s + o.items.reduce((x, i) => x + i.cost * i.qty, 0),
      0,
    );
    const paymentFees = [...paid, ...refunded].reduce((s, o) => s + (feeByOrder.get(o.id) ?? 0), 0);
    const adSpend = input.adSpend.filter((a) => a.store === store).reduce((s, a) => s + a.spend, 0);
    const profit = revenue - costOfGoods - paymentFees - adSpend;
    return {
      store,
      orders: orders.length,
      revenue: round2(revenue),
      refunds: round2(refunds),
      costOfGoods: round2(costOfGoods),
      paymentFees: round2(paymentFees),
      adSpend: round2(adSpend),
      profit: round2(profit),
      margin: revenue > 0 ? Math.round((profit / revenue) * 1000) / 1000 : 0,
      roas: adSpend > 0 ? Math.round((revenue / adSpend) * 100) / 100 : null,
    };
  });
  const sum = (k: keyof Omit<StoreProfit, "store" | "margin" | "roas">) =>
    round2(per.reduce((s, p) => s + p[k], 0));
  const revenue = sum("revenue");
  const unattributedAds = input.adSpend
    .filter((a) => !a.store || !input.stores.includes(a.store))
    .reduce((s, a) => s + a.spend, 0);
  const profit = round2(sum("profit") - unattributedAds);
  const adSpend = round2(sum("adSpend") + unattributedAds);
  const paidTotals = new Map<string, number>();
  for (const p of input.payments) {
    if (p.orderId && (p.status === "approved" || p.status === "refunded"))
      paidTotals.set(
        p.orderId,
        (paidTotals.get(p.orderId) ?? 0) + (p.status === "approved" ? p.amount : -p.amount),
      );
  }
  const orderIds = new Set(input.orders.map((o) => o.id));
  const flags: string[] = [];
  if (unattributedAds > 0)
    flags.push("Unattributed ad spend is included in the total; assign its campaigns to a store.");
  for (const store of input.quietStores ?? []) flags.push(`${store} has earned nothing in 7 days.`);
  for (const p of per)
    if (p.roas !== null && p.roas < 1)
      flags.push(
        `${p.store}: ads cost more than they brought in (ROAS ${p.roas}). Consider pausing or cutting the budget.`,
      );
  const unpaidOrders = input.orders
    .filter((o) => o.status === "paid" && (paidTotals.get(o.id) ?? 0) + 0.005 < o.total)
    .map((o) => o.id);
  if (unpaidOrders.length)
    flags.push(`${unpaidOrders.length} paid order(s) have no matching payment.`);
  return {
    day: input.day,
    currency: input.orders[0]?.currency ?? "BRL",
    stores: per,
    total: {
      orders: sum("orders"),
      revenue,
      refunds: sum("refunds"),
      costOfGoods: sum("costOfGoods"),
      paymentFees: sum("paymentFees"),
      adSpend,
      profit,
      margin: revenue > 0 ? Math.round((profit / revenue) * 1000) / 1000 : 0,
      roas: adSpend > 0 ? Math.round((revenue / adSpend) * 100) / 100 : null,
    },
    unpaidOrders,
    orphanPayments: input.payments
      .filter((p) => p.orderId && !orderIds.has(p.orderId))
      .map((p) => p.id),
    flags,
  };
}

/** Stores with no paid revenue in the last 7 days (the "earning nothing" rule). */
export function quietStores(stores: string[], lastWeekOrders: Order[]): string[] {
  return stores.filter(
    (s) => !lastWeekOrders.some((o) => o.store === s && o.status === "paid" && o.total > 0),
  );
}

const money = (n: number, c: string) => `${c} ${n.toFixed(2)}`;

export function reportMarkdown(r: ProfitReport): string {
  const c = r.currency;
  const nl = String.fromCharCode(10);
  return [
    `# Daily profit report — ${r.day}`,
    "",
    `**Profit:** ${money(r.total.profit, c)} on ${money(r.total.revenue, c)} revenue (margin ${(r.total.margin * 100).toFixed(1)}%).`,
    "",
    "| Store | Orders | Revenue | Cost of goods | Fees | Ads | Profit | ROAS |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...r.stores.map(
      (s) =>
        `| ${s.store} | ${s.orders} | ${s.revenue.toFixed(2)} | ${s.costOfGoods.toFixed(2)} | ${s.paymentFees.toFixed(2)} | ${s.adSpend.toFixed(2)} | ${s.profit.toFixed(2)} | ${s.roas ?? "—"} |`,
    ),
    `| **Total** | ${r.total.orders} | ${r.total.revenue.toFixed(2)} | ${r.total.costOfGoods.toFixed(2)} | ${r.total.paymentFees.toFixed(2)} | ${r.total.adSpend.toFixed(2)} | **${r.total.profit.toFixed(2)}** | ${r.total.roas ?? "—"} |`,
    "",
    r.total.refunds ? `Refunds today: ${money(r.total.refunds, c)}.` : "No refunds today.",
    "",
    "## Flags",
    "",
    ...(r.flags.length ? r.flags.map((f) => `- ${f}`) : ["- Nothing needs attention."]),
  ].join(nl);
}
