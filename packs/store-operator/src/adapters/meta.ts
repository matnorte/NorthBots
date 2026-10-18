import type { AdSpend, AdsApi, Fetch, Post, SocialApi } from "../integrations.js";
import { getJson, round2 } from "../integrations.js";

const GRAPH = "https://graph.facebook.com";

/**
 * Meta Marketing API insights: daily spend, clicks and purchases per campaign. Campaign names
 * starting with "store:<name> -" are attributed to that store.
 * Docs: https://developers.facebook.com/docs/marketing-api/insights
 */
export class MetaAds implements AdsApi {
  constructor(
    private readonly opts: {
      adAccountId: string;
      accessToken: string;
      apiVersion?: string;
      baseUrl?: string;
      fetch?: Fetch;
    },
  ) {}

  async spend(since: Date, until: Date): Promise<AdSpend[]> {
    const base = `${(this.opts.baseUrl ?? GRAPH).replace(/\/$/, "")}/${this.opts.apiVersion ?? "v21.0"}`;
    const last = new Date(until.getTime() - 1);
    const q = new URLSearchParams({
      level: "campaign",
      fields: "campaign_id,campaign_name,spend,clicks,actions",
      time_increment: "1",
      time_range: JSON.stringify({
        since: since.toISOString().slice(0, 10),
        until: last.toISOString().slice(0, 10),
      }),
      limit: "500",
    });
    const account = this.opts.adAccountId.startsWith("act_")
      ? this.opts.adAccountId
      : `act_${this.opts.adAccountId}`;
    const out: AdSpend[] = [];
    let url: string | null = `${base}/${account}/insights?${q}`;
    for (let page = 0; url && page < 20; page++) {
      // The token goes in a header, never in the URL (URLs end up in logs).
      const { body }: { body: Insights } = await getJson<Insights>(this.opts.fetch ?? fetch, url, {
        headers: { Authorization: `Bearer ${this.opts.accessToken}` },
      });
      for (const row of body.data) {
        const store = row.campaign_name.match(/^store:([^-]+?)\s*-/)?.[1]?.trim() ?? null;
        out.push({
          campaignId: row.campaign_id,
          campaign: row.campaign_name,
          store,
          spend: round2(Number(row.spend ?? 0)),
          clicks: Number(row.clicks ?? 0),
          purchases: Number(
            row.actions?.find(
              (a) =>
                a.action_type === "purchase" ||
                a.action_type === "offsite_conversion.fb_pixel_purchase",
            )?.value ?? 0,
          ),
          day: row.date_start,
        });
      }
      url = body.paging?.next ? body.paging.next.replace(/([?&])access_token=[^&]*&?/, "$1") : null;
    }
    return out;
  }
}

/**
 * Instagram content publishing (Graph API): create a media container, then publish it.
 * Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
 */
export class InstagramPublisher implements SocialApi {
  constructor(
    private readonly opts: {
      igUserId: string;
      accessToken: string;
      apiVersion?: string;
      baseUrl?: string;
      fetch?: Fetch;
    },
  ) {}

  async publish(caption: string, imageUrl: string): Promise<Post> {
    const base = `${(this.opts.baseUrl ?? GRAPH).replace(/\/$/, "")}/${this.opts.apiVersion ?? "v21.0"}/${this.opts.igUserId}`;
    const headers = {
      Authorization: `Bearer ${this.opts.accessToken}`,
      "content-type": "application/json",
    };
    const f = this.opts.fetch ?? fetch;
    const container = await getJson<{ id: string }>(f, `${base}/media`, {
      method: "POST",
      headers,
      body: JSON.stringify({ image_url: imageUrl, caption }),
    });
    const published = await getJson<{ id: string }>(f, `${base}/media_publish`, {
      method: "POST",
      headers,
      body: JSON.stringify({ creation_id: container.body.id }),
    });
    return { id: published.body.id, caption, imageUrl, publishedAt: new Date().toISOString() };
  }
}

interface Insights {
  data: {
    campaign_id: string;
    campaign_name: string;
    spend?: string;
    clicks?: string;
    actions?: { action_type: string; value: string }[];
    date_start: string;
  }[];
  paging?: { next?: string };
}
