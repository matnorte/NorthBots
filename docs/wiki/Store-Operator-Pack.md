# Store Operator Pack

The included pack is a concrete example of a multi-agent business workflow. Install it from **Operations**, then choose **Simulate a day** to inspect reports generated from fake store data. It is a starting team and adapter set, not a guarantee of autonomous store management or profit.

## Team

| Agent  | Role                                | Default daily model budget |
| ------ | ----------------------------------- | -------------------------- |
| Maple  | Coordinator and daily profit report | $2                         |
| Scout  | Product research                    | $1                         |
| Quill  | Listings and draft copy             | $1                         |
| Spark  | Ads                                 | $1                         |
| Pixel  | Instagram content                   | $1                         |
| Haven  | Customer support                    | $1                         |
| Ledger | Payment reconciliation              | $1                         |

The installed team asks before refunds, spending and social publishing. Ledger has a deletion block. Review all installed rules and budgets before enabling real work. The role descriptions describe intended work; concrete supported API behavior is defined by the adapters/runtime, not by a role's title.

## Routines and reports

- Daily profit report at 08:00.
- Hourly order reconciliation.
- Weekly idea-bin review.

Review the workspace timezone and first-run approvals. The profit report considers revenue, cost of goods, fees and ad spend. It flags stores with no earnings over seven days and campaigns whose costs exceed their returns. Unattributed ad spend counts against total profit. Pending or partial payments do not fully reconcile a paid order, and mixed order currencies require conversion support.

## Real integrations

| Service      | Vault names                       |
| ------------ | --------------------------------- |
| Shopify      | `SHOPIFY_SHOP`, `SHOPIFY_TOKEN`   |
| Mercado Pago | `MERCADOPAGO_TOKEN`               |
| Meta ads     | `META_AD_ACCOUNT`, `META_TOKEN`   |
| Instagram    | `INSTAGRAM_USER_ID`, `META_TOKEN` |

Store the required values through the vault API and grant the requesting user the necessary access. The real report checks every required secret grant before decryption. `POST /packs/store-operator/simulate` with `{"real": true}` selects the real-data path; through the web proxy use `/api/packs/store-operator/simulate` and an authenticated session.

Adapters cover Shopify orders, Mercado Pago payments, Meta ad insights and Instagram publishing. They bound requests, reject unsafe redirects/cross-origin pagination, remove token query parameters and avoid reflecting API response bodies in errors. Pagination must complete rather than silently reporting partial data.

Real store/payment/ad accounts have **not** been validated in this project. Confirm required account permissions, supported API versions, date/currency conventions and the resulting numbers against provider dashboards before operational use. [BLOCKERS.md](../../BLOCKERS.md) retains that work.

Source: [pack definition](../../packs/store-operator/src/pack.ts), [integrations](../../packs/store-operator/src/integrations.ts), [profit calculations](../../packs/store-operator/src/profit.ts).
