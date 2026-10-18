import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  fakeIntegrations,
  InstagramPublisher,
  MercadoPagoPayments,
  MetaAds,
  ShopifyStore,
  simulateDay,
  STORE_OPERATOR,
  type Integrations,
} from "@northbot/pack-store-operator";
import { Avatar, ErrorBody } from "@northbot/shared";
import { createAgent } from "../agents/create.js";
import { me } from "../auth/guard.js";
import { tryLocked } from "../db/lock.js";
import { agents, permissionRules, schedules } from "../db/schema.js";
import type { Services } from "../services.js";

/** Vault secrets the real (non-fake) store integrations need. */
const REAL_SECRETS = [
  "SHOPIFY_SHOP",
  "SHOPIFY_TOKEN",
  "MERCADOPAGO_TOKEN",
  "META_AD_ACCOUNT",
  "META_TOKEN",
  "INSTAGRAM_USER_ID",
] as const;

/** Business packs: install the store operator team and run its daily report. */
export const packRoutes: FastifyPluginAsyncZod<Services> = async (app, s) => {
  const tags = ["packs"];
  app.addHook("preHandler", s.auth);
  const pack = STORE_OPERATOR;

  const team = async (workspaceId: string) => {
    const rows = await s.db.db
      .select()
      .from(agents)
      .where(
        and(eq(agents.workspaceId, workspaceId), sql`${agents.persona}->>'pack' = ${pack.name}`),
      );
    return new Map(
      rows.map((r) => [String((r.persona as { packRole?: string }).packRole ?? ""), r]),
    );
  };

  app.get("/packs", { schema: { tags } }, async (req) => {
    const installed = await team(me(req).workspaceId);
    return {
      packs: [
        {
          name: pack.name,
          version: pack.version,
          title: pack.title,
          agents: pack.agents.map((a) => ({
            key: a.key,
            name: a.name,
            role: a.role,
            installedAs: installed.get(a.key)?.id ?? null,
          })),
          schedules: pack.schedules.map((x) => x.name),
          installed: installed.size === pack.agents.length,
        },
      ],
    };
  });

  app.post(
    "/packs/store-operator/install",
    {
      schema: {
        tags,
        description:
          "Install the store operator team: seven agents, their safety rules and three routines (daily report 08:00, hourly order check, weekly bin-picker). Installing twice changes nothing.",
        response: {
          200: z.object({
            agents: z.number().int(),
            rules: z.number().int(),
            schedules: z.number().int(),
            created: z.array(z.string()),
          }),
          409: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const result = await tryLocked(
        s.db,
        `pack-install:${m.workspaceId}:${pack.name}`,
        async () => {
          const existing = await team(m.workspaceId);
          const ids = new Map<string, string>();
          const created: string[] = [];
          for (const a of pack.agents) {
            const have = existing.get(a.key);
            if (have) {
              ids.set(a.key, have.id);
              continue;
            }
            // Another agent may already use the name or look: take a numbered name and a free look.
            let name: string = a.name;
            for (
              let i = 2;
              (
                await s.db.db
                  .select({ id: agents.id })
                  .from(agents)
                  .where(
                    and(
                      eq(agents.workspaceId, m.workspaceId),
                      sql`lower(${agents.name}) = lower(${name})`,
                    ),
                  )
              ).length;
              i++
            )
              name = `${a.name} ${i}`;
            const row = await createAgent(
              s,
              m.workspaceId,
              m.userId,
              {
                name,
                nameLocked: true,
                avatar: Avatar.parse(a.avatar),
                persona: {
                  summary: a.persona,
                  role: a.role,
                  goal: a.goal,
                  pack: pack.name,
                  packRole: a.key,
                },
                modelPolicy: {
                  model: "northbot-smart",
                  planner: "northbot-fast",
                  verifier: "northbot-fast",
                },
                autonomyLevel: a.autonomyLevel,
                budgetDailyUsd: a.budgetDailyUsd,
              },
              { autoLook: true },
            );
            ids.set(a.key, row.id);
            created.push(row.name);
          }
          let rules = 0;
          for (const r of pack.rules) {
            const agentId = r.agent ? (ids.get(r.agent) ?? null) : null;
            const dupe = await s.db.db
              .select({ id: permissionRules.id })
              .from(permissionRules)
              .where(
                and(
                  eq(permissionRules.workspaceId, m.workspaceId),
                  eq(permissionRules.text, r.text),
                ),
              );
            if (dupe.length) continue;
            await s.rules.add({
              workspaceId: m.workspaceId,
              agentId,
              text: r.text,
              rule: { ...r.rule, kinds: r.rule.kinds as never, description: r.text },
              source: "user",
              userId: m.userId,
            });
            rules += 1;
          }
          let count = 0;
          const mine = await s.db.db
            .select()
            .from(schedules)
            .where(eq(schedules.workspaceId, m.workspaceId));
          for (const x of pack.schedules) {
            const agentId = ids.get(x.agent)!;
            if (mine.some((row) => row.agentId === agentId && row.definition.name === x.name))
              continue;
            await s.schedules.create(m.workspaceId, m.userId, {
              agentId,
              roomId: null,
              definition: {
                name: x.name,
                cronExpr: x.cronExpr,
                taskPrompt: x.taskPrompt,
                actionKind: x.actionKind,
              },
            });
            count += 1;
          }
          await s.events.write(m.workspaceId, {
            type: "pack.installed",
            payload: {
              pack: pack.name,
              version: pack.version,
              agents: created.length,
              schedules: count,
              userId: m.userId,
            },
          });
          return { agents: ids.size, rules, schedules: count, created };
        },
      );
      if (!result.locked)
        return reply
          .code(409)
          .send({
            error: "install_in_progress",
            message: "This pack is already being installed. Try again when it finishes.",
          });
      return result.value;
    },
  );

  app.post(
    "/packs/store-operator/simulate",
    {
      schema: {
        tags,
        description:
          "Run one day of the store routines and write the daily profit report (on fake integrations unless `real` is true and the store secrets are in the vault).",
        body: z.object({
          day: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .refine((day) => {
              const parsed = new Date(`${day}T00:00:00.000Z`);
              return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
            }, "Use a valid calendar date")
            .optional(),
          real: z.boolean().default(false),
          seed: z.number().int().optional(),
        }),
        response: {
          200: z.object({
            day: z.string(),
            markdown: z.string(),
            report: z.record(z.unknown()),
            timeline: z.array(z.record(z.unknown())),
            awaitingApproval: z.array(z.string()),
          }),
          409: ErrorBody,
          422: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const m = me(req);
      const coordinator = (await team(m.workspaceId)).get("coordinator");
      if (!coordinator)
        return reply
          .code(409)
          .send({ error: "not_installed", message: "Install the store operator pack first." });
      const day = req.body.day ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      let io: Integrations;
      if (req.body.real) {
        const values: Partial<Record<(typeof REAL_SECRETS)[number], string>> = {};
        for (const name of REAL_SECRETS) {
          const v = await s.vault.withSecret(m.workspaceId, name, async (x) => x);
          if (v) values[name] = v;
        }
        const missing = REAL_SECRETS.filter((n) => !values[n]);
        if (missing.length)
          return reply.code(422).send({
            error: "missing_secrets",
            message: `Add these to the vault first: ${missing.join(", ")}.`,
          });
        const storeName = "Shopify store";
        const support = { tickets: async () => [] };
        io = {
          stores: [storeName],
          store: new ShopifyStore({
            shop: values.SHOPIFY_SHOP!,
            accessToken: values.SHOPIFY_TOKEN!,
            storeName,
          }),
          payments: new MercadoPagoPayments({ accessToken: values.MERCADOPAGO_TOKEN! }),
          ads: new MetaAds({
            adAccountId: values.META_AD_ACCOUNT!,
            accessToken: values.META_TOKEN!,
          }),
          social: new InstagramPublisher({
            igUserId: values.INSTAGRAM_USER_ID!,
            accessToken: values.META_TOKEN!,
          }),
          support,
        };
      } else io = fakeIntegrations({ seed: req.body.seed });
      const result = await simulateDay(io, day);
      // The report reaches the coordinator (as a memory) and the team's letters inbox.
      await s.mail.send({
        workspaceId: m.workspaceId,
        type: "fyi",
        subject: `Daily profit report — ${day}`,
        body: result.markdown,
        from: { kind: "system" },
        toAgentId: coordinator.id,
      });
      await s.events.write(m.workspaceId, {
        type: "pack.report",
        agentId: coordinator.id,
        payload: {
          pack: pack.name,
          day,
          revenue: result.report.total.revenue,
          profit: result.report.total.profit,
          flags: result.report.flags,
        },
      });
      return {
        day,
        markdown: result.markdown,
        report: result.report as unknown as Record<string, unknown>,
        timeline: result.timeline as unknown as Record<string, unknown>[],
        awaitingApproval: result.awaitingApproval,
      };
    },
  );
};
