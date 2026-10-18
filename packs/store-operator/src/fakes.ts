import type {
  AdSpend,
  Integrations,
  NewListing,
  Order,
  Payment,
  Post,
  Product,
  Ticket,
} from "./integrations.js";
import { round2 } from "./integrations.js";

/** A small seeded random generator, so a simulated day is the same every run. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const CATALOG: Omit<Product, "store" | "id">[] = [
  { title: "Speckled mug", sku: "MUG-SPK", price: 89.9, cost: 31, inventory: 40 },
  { title: "Tea towel set", sku: "TWL-SET", price: 59.9, cost: 18.5, inventory: 25 },
  { title: "Ceramic planter", sku: "PLN-CER", price: 129, cost: 52, inventory: 12 },
  { title: "Notebook trio", sku: "NBK-TRI", price: 45, cost: 14, inventory: 60 },
];

/**
 * Fake integrations for two stores. "Lumen Goods" sells every day; "Quiet Corner" has sold
 * nothing for weeks, so the 7-day no-earnings rule flags it.
 */
export function fakeIntegrations(
  opts: { seed?: number } = {},
): Integrations & { posts: Post[]; listings: Product[] } {
  const stores = ["Lumen Goods", "Quiet Corner"];
  const seed = opts.seed ?? 42;
  const products: Product[] = stores.flatMap((store) =>
    CATALOG.map((p) => ({ ...p, store, id: `${store.slice(0, 2).toUpperCase()}-${p.sku}` })),
  );
  const posts: Post[] = [];
  const listings: Product[] = [];

  /** Orders are generated per hour from (seed, store, hour), so any window can be asked for. */
  const hourOrders = (store: string, hourStart: Date): Order[] => {
    if (store === "Quiet Corner") return [];
    const r = rng(seed ^ hash(store) ^ Math.floor(hourStart.getTime() / 3_600_000));
    const hour = hourStart.getUTCHours();
    const busy = hour >= 11 && hour <= 23 ? 0.55 : 0.12;
    const out: Order[] = [];
    for (let k = 0; k < 2; k++) {
      if (r() > busy) continue;
      const items = [CATALOG[Math.floor(r() * CATALOG.length)]!].map((p) => ({
        sku: p.sku,
        title: p.title,
        qty: 1 + Math.floor(r() * 2),
        price: p.price,
        cost: p.cost,
      }));
      const total = round2(items.reduce((s, i) => s + i.qty * i.price, 0));
      const roll = r();
      out.push({
        id: `${hourStart.toISOString().slice(0, 13)}-${k}`,
        store,
        createdAt: new Date(hourStart.getTime() + Math.floor(r() * 3_600_000)).toISOString(),
        status: roll < 0.06 ? "refunded" : roll < 0.12 ? "pending" : "paid",
        total,
        currency: "BRL",
        items,
      });
    }
    return out;
  };

  const ordersBetween = (since: Date, until: Date) => {
    const out: Order[] = [];
    for (
      let t = Math.floor(since.getTime() / 3_600_000) * 3_600_000;
      t < until.getTime();
      t += 3_600_000
    ) {
      for (const store of stores) out.push(...hourOrders(store, new Date(t)));
    }
    return out.filter(
      (o) =>
        Date.parse(o.createdAt) >= since.getTime() && Date.parse(o.createdAt) < until.getTime(),
    );
  };

  return {
    stores,
    posts,
    listings,
    store: {
      orders: async (since, until) => ordersBetween(since, until),
      products: async () => products,
      createListing: async (l: NewListing) => {
        const p: Product = {
          id: `NEW-${l.sku}`,
          store: l.store,
          title: l.title,
          sku: l.sku,
          price: l.price,
          cost: 0,
          inventory: 0,
        };
        listings.push(p);
        return p;
      },
    },
    payments: {
      payments: async (since, until): Promise<Payment[]> =>
        ordersBetween(since, until)
          .filter((o) => o.status !== "pending")
          // One order in twenty has no payment yet (reconciliation should notice).
          .filter((o) => hash(o.id) % 20 !== 0)
          .map((o) => ({
            id: `pay-${o.id}`,
            orderId: o.id,
            status: o.status === "refunded" ? "refunded" : "approved",
            amount: o.total,
            fee: round2(o.total * 0.0499 + 0.4),
            method: hash(o.id) % 3 === 0 ? "pix" : "credit_card",
            createdAt: o.createdAt,
          })),
    },
    ads: {
      spend: async (since, until): Promise<AdSpend[]> => {
        const days: AdSpend[] = [];
        for (let t = since.getTime(); t < until.getTime(); t += 86_400_000) {
          const day = new Date(t).toISOString().slice(0, 10);
          const r = rng(seed ^ hash(day));
          days.push(
            {
              campaignId: "c1",
              campaign: "store:Lumen Goods - mugs",
              store: "Lumen Goods",
              spend: round2(40 + r() * 20),
              clicks: 180 + Math.floor(r() * 60),
              purchases: 3 + Math.floor(r() * 4),
              day,
            },
            {
              campaignId: "c2",
              campaign: "store:Quiet Corner - planters",
              store: "Quiet Corner",
              spend: round2(15 + r() * 10),
              clicks: 60 + Math.floor(r() * 20),
              purchases: 0,
              day,
            },
          );
        }
        return days;
      },
    },
    social: {
      publish: async (caption, imageUrl) => {
        const post: Post = {
          id: `post-${posts.length + 1}`,
          caption,
          imageUrl,
          publishedAt: new Date().toISOString(),
        };
        posts.push(post);
        return post;
      },
    },
    support: {
      tickets: async (since, until): Promise<Ticket[]> =>
        ordersBetween(since, until)
          .filter((o) => hash(o.id) % 7 === 0)
          .map((o) => ({
            id: `t-${o.id}`,
            store: o.store,
            subject: `Where is order ${o.id}?`,
            body: "Hi! When does my order ship?",
            createdAt: o.createdAt,
          })),
    },
  };
}
