import { and, asc, eq, isNull, or } from "drizzle-orm";
import { PermissionRule } from "@northbot/agent-runtime";
import type { DbHandle } from "../db/client.js";
import { agents, permissionRules } from "../db/schema.js";
import type { EventLog } from "../events/log.js";
import type { LlmService } from "../llm/service.js";

const COMPILER_SYSTEM = [
  "Convert a plain-language permission rule for AI agents into JSON. Reply with JSON only.",
  'Shape: {"effect": "allow" | "ask" | "block", "kinds"?: ("read"|"write"|"delete"|"send"|"spend"|"login")[], "tools"?: ("terminal"|"browser")[], "targets"?: string[], "pattern"?: string}',
  "targets are domains (example.com) or email addresses; pattern is a case-insensitive regex over a one-line action summary such as `run \\`rm -rf x\\`` or `browser goto https://x`.",
  "Leave out fields the rule does not mention.",
].join("\n");

export class RuleCompileError extends Error {}

/** Permission rules: written in plain language, compiled to JSON, applied per agent or workspace. */
export class RuleStore {
  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
    private readonly llm: LlmService,
  ) {}

  async forAgent(workspaceId: string, agentId: string): Promise<PermissionRule[]> {
    const rows = await this.db.db
      .select()
      .from(permissionRules)
      .where(and(eq(permissionRules.workspaceId, workspaceId), or(isNull(permissionRules.agentId), eq(permissionRules.agentId, agentId))))
      .orderBy(asc(permissionRules.createdAt));
    return rows.map((r) => PermissionRule.parse({ ...r.rule, id: r.id, description: r.text }));
  }

  async list(workspaceId: string) {
    return this.db.db.select().from(permissionRules).where(eq(permissionRules.workspaceId, workspaceId)).orderBy(asc(permissionRules.createdAt));
  }

  /** Turns plain text into a rule with a model call; the JSON is validated before it is stored. */
  async compile(workspaceId: string, text: string): Promise<PermissionRule> {
    const res = await this.llm.chat(
      { model: "northbot-fast", messages: [{ role: "system", content: COMPILER_SYSTEM }, { role: "user", content: text }] },
      { workspaceId, privacy: "normal" },
    );
    const start = res.text.indexOf("{");
    const end = res.text.lastIndexOf("}");
    let json: unknown = null;
    try {
      json = JSON.parse(res.text.slice(start, end + 1));
    } catch {
      /* handled below */
    }
    const parsed = PermissionRule.safeParse({ ...(json as object), description: text });
    if (!parsed.success) throw new RuleCompileError("I could not turn that into a rule. Try saying who, what and allow/ask/block.");
    return parsed.data;
  }

  async add(input: {
    workspaceId: string;
    agentId: string | null;
    text: string;
    rule: PermissionRule;
    source: "user" | "approval";
    userId: string | null;
  }) {
    const { id: _id, description: _d, ...json } = input.rule;
    const [row] = await this.db.db
      .insert(permissionRules)
      .values({ workspaceId: input.workspaceId, agentId: input.agentId, text: input.text, rule: json, source: input.source, createdBy: input.userId })
      .returning();
    if (!row) throw new Error("rule insert failed");
    await this.events.write(input.workspaceId, {
      type: "rule.created",
      agentId: input.agentId,
      payload: { ruleId: row.id, description: input.text, effect: input.rule.effect, source: input.source, userId: input.userId },
    });
    await this.flagContradictions(input.workspaceId, row.id, input.agentId, input.rule);
    return row;
  }

  /**
   * An allow and a block rule that can match the same action contradict each other (block
   * still wins, but the agent can't tell what the human wants). Affected agents get confused.
   */
  private async flagContradictions(workspaceId: string, ruleId: string, agentId: string | null, rule: PermissionRule): Promise<void> {
    if (rule.effect === "ask") return;
    const opposite = rule.effect === "allow" ? "block" : "allow";
    const overlap = (a?: string[], b?: string[]) => !a || !b || a.some((x) => b.includes(x));
    const rows = await this.db.db.select().from(permissionRules).where(eq(permissionRules.workspaceId, workspaceId));
    const clashes = rows.filter((r) => {
      if (r.id === ruleId) return false;
      if (r.agentId && agentId && r.agentId !== agentId) return false;
      const other = PermissionRule.parse({ ...r.rule, description: r.text });
      return other.effect === opposite && overlap(rule.kinds, other.kinds) && overlap(rule.tools, other.tools) && overlap(rule.targets, other.targets);
    });
    if (clashes.length === 0) return;
    const scoped = [agentId, ...clashes.map((c) => c.agentId)].filter((x): x is string => Boolean(x));
    const affected = scoped.length
      ? [...new Set(scoped)]
      : (await this.db.db.select({ id: agents.id }).from(agents).where(eq(agents.workspaceId, workspaceId))).map((a) => a.id);
    const description = `"${rule.description}" conflicts with "${clashes[0]?.text ?? ""}".`;
    for (const id of affected) {
      await this.events.write(workspaceId, {
        type: "instruction.contradiction",
        agentId: id,
        payload: { ruleIds: [ruleId, ...clashes.map((c) => c.id)], description },
      });
    }
  }

  async remove(workspaceId: string, id: string, userId: string): Promise<boolean> {
    const rows = await this.db.db
      .delete(permissionRules)
      .where(and(eq(permissionRules.id, id), eq(permissionRules.workspaceId, workspaceId)))
      .returning({ id: permissionRules.id });
    if (rows.length === 0) return false;
    await this.events.write(workspaceId, { type: "rule.deleted", payload: { ruleId: id, userId } });
    return true;
  }
}
