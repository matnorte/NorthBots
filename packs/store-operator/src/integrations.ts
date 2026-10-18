/**
 * Everything the store operator pack touches outside NorthBot goes through these interfaces.
 * Fakes implement them for tests and simulations; Shopify, Mercado Pago and Meta adapters
 * implement them against the public APIs.
 */

export interface OrderItem {
  sku: string;
  title: string;
  qty: number;
  /** Unit price charged to the customer. */
  price: number;
  /** Unit cost of goods (from the product catalog; 0 when unknown). */
  cost: number;
}

export interface Order {
  id: string;
  store: string;
  createdAt: string;
  status: "paid" | "pending" | "refunded" | "cancelled";
  total: number;
  currency: string;
  items: OrderItem[];
}

export interface Product {
  id: string;
  store: string;
  title: string;
  sku: string;
  price: number;
  cost: number;
  inventory: number;
}

export interface NewListing {
  store: string;
  title: string;
  description: string;
  sku: string;
  price: number;
}

export interface Payment {
  id: string;
  /** The order this pays for (external reference), when known. */
  orderId: string | null;
  status: "approved" | "pending" | "refunded" | "rejected";
  amount: number;
  fee: number;
  method: string;
  createdAt: string;
}

export interface AdSpend {
  campaignId: string;
  campaign: string;
  /** The store the campaign promotes (from the campaign name prefix "store:"). */
  store: string | null;
  spend: number;
  clicks: number;
  purchases: number;
  day: string;
}

export interface Post {
  id: string;
  caption: string;
  imageUrl: string;
  publishedAt: string;
}

export interface Ticket {
  id: string;
  store: string;
  subject: string;
  body: string;
  createdAt: string;
}

export interface StoreApi {
  orders(since: Date, until: Date): Promise<Order[]>;
  products(): Promise<Product[]>;
  createListing(listing: NewListing): Promise<Product>;
}

export interface PaymentsApi {
  payments(since: Date, until: Date): Promise<Payment[]>;
}

export interface AdsApi {
  spend(since: Date, until: Date): Promise<AdSpend[]>;
}

export interface SocialApi {
  publish(caption: string, imageUrl: string): Promise<Post>;
}

export interface SupportApi {
  tickets(since: Date, until: Date): Promise<Ticket[]>;
}

export interface Integrations {
  stores: string[];
  store: StoreApi;
  payments: PaymentsApi;
  ads: AdsApi;
  social: SocialApi;
  support: SupportApi;
}

/** Calls an HTTP API with a JSON body; adapters share it so tests can swap `fetch`. */
export type Fetch = typeof fetch;

export async function getJson<T>(
  fetchFn: Fetch,
  url: string,
  init: RequestInit = {},
): Promise<{ body: T; headers: Headers }> {
  const res = await fetchFn(url, {
    ...init,
    redirect: "error",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${init.method ?? "GET"} API request failed with HTTP ${res.status}`);
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("API returned invalid JSON");
  }
  return { body: body as T, headers: res.headers };
}

/** Pagination links must not forward credentials to another origin or put tokens in logs. */
export function sameOriginPage(next: string, base: string): string {
  const url = new URL(next, base);
  if (url.origin !== new URL(base).origin || url.username || url.password)
    throw new Error("API pagination changed origin");
  url.searchParams.delete("access_token");
  url.hash = "";
  return url.toString();
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
