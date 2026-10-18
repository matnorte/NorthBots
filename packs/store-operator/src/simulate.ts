import type { Integrations } from "./integrations.js";
import { profitReport, quietStores, reportMarkdown, type ProfitReport } from "./profit.js";

export interface DayEvent {
  at: string;
  agent: string;
  what: string;
}

export interface SimulatedDay {
  day: string;
  report: ProfitReport;
  markdown: string;
  timeline: DayEvent[];
  /** Actions the agents prepared that need a human (spend, send, refunds). */
  awaitingApproval: string[];
}

const HOUR = 3_600_000;

/**
 * Runs one day of the store operator pack against the given integrations (fakes in tests):
 * 24 hourly order checks, support replies, an Instagram post draft, ad review, payment
 * reconciliation, and the 08:00 profit report for that day.
 */
export async function simulateDay(io: Integrations, day: string): Promise<SimulatedDay> {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error("day must be YYYY-MM-DD");
  const end = new Date(start.getTime() + 24 * HOUR);
  const timeline: DayEvent[] = [];
  const awaiting: string[] = [];
  const at = (h: number, m = 0) => new Date(start.getTime() + h * HOUR + m * 60_000).toISOString();

  // Hourly order check (Ledger).
  let seen = 0;
  for (let h = 0; h < 24; h++) {
    const orders = await io.store.orders(
      new Date(start.getTime() + h * HOUR),
      new Date(start.getTime() + (h + 1) * HOUR),
    );
    seen += orders.length;
    const pending = orders.filter((o) => o.status === "pending").length;
    timeline.push({
      at: at(h),
      agent: "Ledger",
      what: `Hourly order check: ${orders.length} new order(s)${pending ? `, ${pending} waiting for payment` : ""}.`,
    });
  }

  // Support (Haven): answer shipping questions; refunds would need a human.
  const tickets = await io.support.tickets(start, end);
  for (const t of tickets)
    timeline.push({
      at: t.createdAt,
      agent: "Haven",
      what: `Answered "${t.subject}" with the shipping status.`,
    });

  // Instagram (Pixel): drafts a post; publishing waits for approval (the pack rule).
  const products = await io.store.products();
  const hero = products.find((p) => p.inventory > 0);
  if (hero) {
    awaiting.push(`Publish an Instagram post about "${hero.title}" (${hero.store}).`);
    timeline.push({
      at: at(10),
      agent: "Pixel",
      what: `Drafted an Instagram post about "${hero.title}"; waiting for approval to publish.`,
    });
  }

  // Ads (Spark): review spend; budget changes are proposals, never automatic.
  const ads = await io.ads.spend(start, end);
  for (const a of ads) {
    timeline.push({
      at: at(12),
      agent: "Spark",
      what: `${a.campaign}: spent ${a.spend.toFixed(2)}, ${a.clicks} clicks, ${a.purchases} purchase(s).`,
    });
    if (a.purchases === 0 && a.spend > 0)
      awaiting.push(
        `Pause campaign "${a.campaign}" (spent ${a.spend.toFixed(2)} with no purchases).`,
      );
  }

  // Reconciliation and the report (Ledger, then Maple).
  const [orders, payments, lastWeek] = await Promise.all([
    io.store.orders(start, end),
    io.payments.payments(start, end),
    io.store.orders(new Date(end.getTime() - 7 * 24 * HOUR), end),
  ]);
  const report = profitReport({
    day,
    stores: io.stores,
    orders,
    payments,
    adSpend: ads,
    quietStores: quietStores(io.stores, lastWeek),
  });
  timeline.push({
    at: at(23, 50),
    agent: "Ledger",
    what: `Reconciled ${payments.length} payment(s) against ${orders.length} order(s); ${report.unpaidOrders.length} gap(s).`,
  });
  timeline.push({
    at: new Date(end.getTime() + 8 * HOUR).toISOString(),
    agent: "Maple",
    what: `Daily profit report: profit ${report.total.profit.toFixed(2)} on revenue ${report.total.revenue.toFixed(2)}; ${report.flags.length} flag(s).`,
  });
  if (seen !== orders.length) throw new Error("hourly checks and the daily total disagree");
  return {
    day,
    report,
    markdown: reportMarkdown(report),
    timeline: timeline.sort((x, y) => x.at.localeCompare(y.at)),
    awaitingApproval: awaiting,
  };
}
