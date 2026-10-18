import type { Fetch, NewListing, Order, Product, StoreApi } from "../integrations.js";
import { getJson } from "../integrations.js";

/**
 * Shopify Admin REST API (2024-10): orders, products with their unit costs, and new listings.
 * New listings are created as drafts, so a human publishes them.
 * Docs: https://shopify.dev/docs/api/admin-rest/2024-10/resources/order
 */
export class ShopifyStore implements StoreApi {
  private readonly base: string;
  private costs: Map<string, number> | null = null;

  constructor(
    private readonly opts: {
      shop: string;
      accessToken: string;
      storeName: string;
      apiVersion?: string;
      fetch?: Fetch;
    },
  ) {
    const host = opts.shop.startsWith("http") ? opts.shop : `https://${opts.shop}`;
    this.base = `${host.replace(/\/$/, "")}/admin/api/${opts.apiVersion ?? "2024-10"}`;
  }

  private get fetch(): Fetch {
    return this.opts.fetch ?? fetch;
  }

  private headers() {
    return { "X-Shopify-Access-Token": this.opts.accessToken, "content-type": "application/json" };
  }

  /** Follows `Link: <...>; rel="next"` cursor pagination. */
  private async all<T>(first: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = first;
    for (let page = 0; url && page < 50; page++) {
      const res: { body: Record<string, T[]>; headers: Headers } = await getJson<
        Record<string, T[]>
      >(this.fetch, url, { headers: this.headers() });
      const { body, headers } = res;
      out.push(...(body[key] ?? []));
      const next: RegExpMatchArray | null = (headers.get("link") ?? "").match(
        /<([^>]+)>;\s*rel="next"/,
      );
      url = next?.[1] ?? null;
    }
    return out;
  }

  private async costBySku(): Promise<Map<string, number>> {
    if (this.costs) return this.costs;
    const products = await this.all<ShopifyProduct>(
      `${this.base}/products.json?limit=250`,
      "products",
    );
    const variants = products.flatMap((p) => p.variants);
    const ids = variants.map((v) => v.inventory_item_id).filter(Boolean);
    const items: { id: number; cost: string | null }[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      items.push(
        ...(await this.all<{ id: number; cost: string | null }>(
          `${this.base}/inventory_items.json?ids=${ids.slice(i, i + 100).join(",")}`,
          "inventory_items",
        )),
      );
    }
    const costOf = new Map(items.map((i) => [i.id, Number(i.cost ?? 0)]));
    this.costs = new Map(variants.map((v) => [v.sku ?? "", costOf.get(v.inventory_item_id) ?? 0]));
    return this.costs;
  }

  async orders(since: Date, until: Date): Promise<Order[]> {
    const q = new URLSearchParams({
      status: "any",
      limit: "250",
      created_at_min: since.toISOString(),
      created_at_max: until.toISOString(),
    });
    const [orders, costs] = await Promise.all([
      this.all<ShopifyOrder>(`${this.base}/orders.json?${q}`, "orders"),
      this.costBySku(),
    ]);
    return orders.map((o) => ({
      id: String(o.id),
      store: this.opts.storeName,
      createdAt: o.created_at,
      status: o.cancelled_at
        ? "cancelled"
        : o.financial_status === "paid" || o.financial_status === "partially_refunded"
          ? "paid"
          : o.financial_status === "refunded"
            ? "refunded"
            : "pending",
      total: Number(o.total_price),
      currency: o.currency,
      items: o.line_items.map((li) => ({
        sku: li.sku ?? "",
        title: li.title,
        qty: li.quantity,
        price: Number(li.price),
        cost: costs.get(li.sku ?? "") ?? 0,
      })),
    }));
  }

  async products(): Promise<Product[]> {
    const [products, costs] = await Promise.all([
      this.all<ShopifyProduct>(`${this.base}/products.json?limit=250`, "products"),
      this.costBySku(),
    ]);
    return products.flatMap((p) =>
      p.variants.map((v) => ({
        id: String(v.id),
        store: this.opts.storeName,
        title: p.title,
        sku: v.sku ?? "",
        price: Number(v.price),
        cost: costs.get(v.sku ?? "") ?? 0,
        inventory: v.inventory_quantity ?? 0,
      })),
    );
  }

  async createListing(l: NewListing): Promise<Product> {
    const { body } = await getJson<{ product: ShopifyProduct }>(
      this.fetch,
      `${this.base}/products.json`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          product: {
            title: l.title,
            body_html: l.description,
            status: "draft",
            variants: [{ sku: l.sku, price: l.price.toFixed(2) }],
          },
        }),
      },
    );
    const v = body.product.variants[0];
    return {
      id: String(v?.id ?? body.product.id),
      store: this.opts.storeName,
      title: body.product.title,
      sku: v?.sku ?? l.sku,
      price: Number(v?.price ?? l.price),
      cost: 0,
      inventory: v?.inventory_quantity ?? 0,
    };
  }
}

interface ShopifyOrder {
  id: number;
  created_at: string;
  cancelled_at: string | null;
  financial_status: string;
  total_price: string;
  currency: string;
  line_items: { sku: string | null; title: string; quantity: number; price: string }[];
}
interface ShopifyProduct {
  id: number;
  title: string;
  variants: {
    id: number;
    sku: string | null;
    price: string;
    inventory_quantity?: number;
    inventory_item_id: number;
  }[];
}
