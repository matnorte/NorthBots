import type { Fetch, Payment, PaymentsApi } from "../integrations.js";
import { getJson, round2 } from "../integrations.js";

/**
 * Mercado Pago payments search: what was paid, refunded, and the fees taken.
 * Docs: https://www.mercadopago.com.br/developers/en/reference/payments/_payments_search/get
 */
export class MercadoPagoPayments implements PaymentsApi {
  constructor(private readonly opts: { accessToken: string; baseUrl?: string; fetch?: Fetch }) {}

  async payments(since: Date, until: Date): Promise<Payment[]> {
    const base = (this.opts.baseUrl ?? "https://api.mercadopago.com").replace(/\/$/, "");
    const out: Payment[] = [];
    const limit = 50;
    for (let offset = 0; offset < 10_000; offset += limit) {
      const q = new URLSearchParams({
        sort: "date_created",
        criteria: "asc",
        range: "date_created",
        begin_date: since.toISOString(),
        end_date: until.toISOString(),
        limit: String(limit),
        offset: String(offset),
      });
      const { body } = await getJson<MpSearch>(
        this.opts.fetch ?? fetch,
        `${base}/v1/payments/search?${q}`,
        { headers: { Authorization: `Bearer ${this.opts.accessToken}` } },
      );
      for (const p of body.results) {
        if (new Date(p.date_created) < since || new Date(p.date_created) >= until) continue;
        out.push({
          id: String(p.id),
          orderId: p.external_reference || null,
          status:
            p.status === "approved"
              ? "approved"
              : p.status === "refunded" || p.status === "charged_back"
                ? "refunded"
                : p.status === "rejected" || p.status === "cancelled"
                  ? "rejected"
                  : "pending",
          amount: p.transaction_amount,
          fee: round2((p.fee_details ?? []).reduce((s, f) => s + f.amount, 0)),
          method: p.payment_method_id ?? "unknown",
          createdAt: p.date_created,
        });
      }
      if (offset + limit >= body.paging.total || body.results.length === 0) return out;
    }
    throw new Error("API pagination exceeded the payment limit");
  }
}

interface MpSearch {
  paging: { total: number; limit: number; offset: number };
  results: {
    id: number;
    status: string;
    transaction_amount: number;
    fee_details?: { amount: number; type: string }[];
    external_reference?: string | null;
    payment_method_id?: string;
    date_created: string;
  }[];
}
