import { and, asc, desc, eq, inArray, isNull, max, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { ActionKind } from "@northbot/agent-runtime";
import type { ChatMessage } from "@northbot/llm-router";
import { cosine, HashEmbedder } from "@northbot/memory";
import { READONLY_ROOT } from "@northbot/sandbox";
import { detectCandidates, diffSkill, parseSkillMd, renderSkillMd, scanSkill, skillRights, SkillFrontmatter, validateSkill, type SkillFiles } from "@northbot/skills";
import type { ComputerManager } from "../computer/manager.js";
import type { DbHandle } from "../db/client.js";
import { events, skills, skillVersions, tasks } from "../db/schema.js";
import type { EventLog } from "../events/log.js";
import type { LlmService } from "../llm/service.js";
import type { Vault } from "../vault/vault.js";

const DRAFTER_SYSTEM = [
  "You write reusable skills for AI agents from an example of work that went well.",
  'Reply with JSON only: {"name": kebab-case string, "description": string, "inputs": [{"name": string, "description": string}], "instructions": string, "script": string}.',
  "The script is a bash script that redoes the example's work; read inputs from $1, $2... in order. Never put passwords, keys or tokens in it.",
].join("\n");

const Draft = z.object({
  name: z.string(),
  description: z.string(),
  inputs: z.array(z.object({ name: z.string(), description: z.string().default("") })).default([]),
  instructions: z.string().default(""),
  script: z.string().min(1),
});

export interface OfferedSkill {
  skillId: string;
  version: number;
  name: string;
  rights: ActionKind;
}

export class SkillError extends Error {
  constructor(
    message: string,
    readonly findings: unknown[] = [],
  ) {
    super(message);
  }
}

const SKILL_CMD = new RegExp(`^(?:bash|sh)\\s+${READONLY_ROOT.replace(/\//g, "\\/")}/([a-z0-9-]+)/[\\w.-]+(?:\\s.*)?$`);

/**
 * Skills: versioned folders (SKILL.md + scripts). The automatic pipeline watches finished
 * tasks, drafts a skill from repeated or hard-won work, scans and dry-runs it, and leaves a
 * review card. Only approved versions are offered to agents, installed read-only.
 */
export class SkillService {
  private readonly embedder = new HashEmbedder();

  constructor(
    private readonly db: DbHandle,
    private readonly events: EventLog,
    private readonly llm: LlmService,
    private readonly computers: ComputerManager,
    private readonly vault: Vault,
  ) {}

  private async knownSecrets(workspaceId: string): Promise<string[]> {
    const values: string[] = [];
    for (const s of await this.vault.listNames(workspaceId)) await this.vault.withSecret(workspaceId, s.name, async (v) => void values.push(v));
    return values;
  }

  /** Validates, scans and stores a new version. Returns it; throws SkillError when unusable. */
  async addVersion(input: {
    workspaceId: string;
    agentId: string | null;
    files: SkillFiles;
    trigger: "repeated" | "corrected" | "demonstrated" | "human";
    createdBy: string;
    exampleTaskId?: string | null;
    status: "draft" | "approved";
  }) {
    const errors = validateSkill(input.files);
    if (errors.length) throw new SkillError(errors.join(" "));
    const fm = parseSkillMd(input.files["SKILL.md"] ?? "").frontmatter;
    const scan = scanSkill(input.files, await this.knownSecrets(input.workspaceId));
    let [skill] = await this.db.db.select().from(skills).where(and(eq(skills.workspaceId, input.workspaceId), eq(skills.name, fm.name)));
    if (!skill) {
      const [embedding] = await this.embedder.embed([`${fm.name.replace(/-/g, " ")} ${fm.description}`]);
      [skill] = await this.db.db
        .insert(skills)
        .values({ workspaceId: input.workspaceId, agentId: input.agentId, name: fm.name, description: fm.description, embedding: embedding ?? [], embeddingModel: this.embedder.model })
        .returning();
    }
    if (!skill) throw new Error("skill insert failed");
    const [last] = await this.db.db.select({ v: max(skillVersions.version) }).from(skillVersions).where(eq(skillVersions.skillId, skill.id));
    const prev = skill.activeVersion
      ? (await this.db.db.select().from(skillVersions).where(and(eq(skillVersions.skillId, skill.id), eq(skillVersions.version, skill.activeVersion))))[0]
      : undefined;
    const version = (last?.v ?? 0) + 1;
    const [row] = await this.db.db
      .insert(skillVersions)
      .values({
        skillId: skill.id,
        version,
        files: input.files,
        status: scan.ok ? input.status : "rejected",
        trigger: input.trigger,
        exampleTaskId: input.exampleTaskId ?? null,
        rights: skillRights(input.files),
        scan: { ok: scan.ok, findings: scan.findings },
        diff: diffSkill(prev?.files ?? {}, input.files),
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error("skill version insert failed");
    if (!scan.ok) {
      await this.events.write(input.workspaceId, {
        type: "skill.rejected",
        agentId: input.agentId,
        payload: { skillId: skill.id, version, reason: `The safety scan found ${scan.findings.map((f) => f.kind).join(", ")}.`, userId: null },
      });
      throw new SkillError("The safety scan rejected this skill.", scan.findings);
    }
    if (input.status === "approved") await this.activate(skill.id, version, input.files);
    return { skill, version: row };
  }

  /** Makes a version the active one; the skill's description and search embedding follow it. */
  private async activate(skillId: string, version: number, files: SkillFiles): Promise<void> {
    const fm = parseSkillMd(files["SKILL.md"] ?? "").frontmatter;
    const [embedding] = await this.embedder.embed([`${fm.name.replace(/-/g, " ")} ${fm.description}`]);
    await this.db.db
      .update(skills)
      .set({ activeVersion: version, description: fm.description, ...(embedding ? { embedding, embeddingModel: this.embedder.model } : {}) })
      .where(eq(skills.id, skillId));
  }

  /** Runs a read-only skill in a scratch folder; skills that change things are not dry-run. */
  private async dryRun(ref: { workspaceId: string; agentId: string }, name: string, version: number, files: SkillFiles, rights: string) {
    if (rights !== "read") return { skipped: true, reason: `The script can ${rights}; it will only run with approval.` };
    const dir = `.skill-dryrun/${name}-v${version}`;
    for (const [path, content] of Object.entries(files)) await this.computers.writeFile(ref, `${dir}/${path}`, Buffer.from(content));
    const script = Object.keys(files).find((f) => f.endsWith(".sh")) ?? "run.sh";
    // Run from the home folder, like a real skill run, so relative paths resolve the same way.
    const r = await this.computers.exec(ref, `bash ${dir}/${script}`, "system", { timeoutMs: 60_000 });
    return { skipped: false, exitCode: r.exitCode, ok: r.exitCode === 0, output: (r.stdout + r.stderr).slice(0, 2000) };
  }

  /** Called when a task finishes: detect a pattern, draft, scan, dry-run, and leave a review card. */
  async afterTask(taskId: string): Promise<{ drafted: boolean; reason: string }> {
    const [task] = await this.db.db.select().from(tasks).where(eq(tasks.id, taskId));
    if (!task || task.status !== "done") return { drafted: false, reason: "task not done" };
    const recent = await this.db.db.select().from(tasks).where(eq(tasks.agentId, task.agentId)).orderBy(desc(tasks.createdAt)).limit(20);
    const corrected = new Set(
      (await this.db.db.select({ p: events.payload }).from(events).where(and(eq(events.agentId, task.agentId), eq(events.type, "feedback.correction")))).map((e) => String(e.p.taskId)),
    );
    const goals = await this.embedder.embed(recent.map((t) => t.goal));
    const summaries = recent.map((t, i) => ({
      id: t.id,
      goal: t.goal,
      embedding: goals[i] ?? [],
      status: t.status,
      failures: Number((t.state as { failures?: number } | null)?.failures ?? 0),
      corrected: corrected.has(t.id),
    }));
    const [candidate] = detectCandidates(summaries);
    if (!candidate || candidate.exampleTaskId !== task.id) return { drafted: false, reason: "no pattern yet" };
    return this.draftFrom(task, candidate.trigger);
  }

  /** Drafts a skill from one finished task (also used when a human says "make this a skill"). */
  async draftFrom(
    task: typeof tasks.$inferSelect,
    trigger: "repeated" | "corrected" | "demonstrated",
  ): Promise<{ drafted: boolean; reason: string; skillId?: string; version?: number }> {

    // Skip work an existing skill already covers.
    const [goalVec] = await this.embedder.embed([task.goal]);
    const existing = await this.db.db.select().from(skills).where(and(eq(skills.workspaceId, task.workspaceId), or(isNull(skills.agentId), eq(skills.agentId, task.agentId))));
    if (trigger !== "demonstrated" && goalVec && existing.some((s) => cosine(s.embedding, goalVec) > 0.6)) {
      return { drafted: false, reason: "already covered by a skill" };
    }

    const commands = ((task.state as { messages?: ChatMessage[] } | null)?.messages ?? []).flatMap((m) =>
      m.role === "assistant" ? (m.toolCalls ?? []).map((c) => `${c.name}: ${c.arguments}`) : [],
    );
    const res = await this.llm.chat(
      {
        model: "northbot-fast",
        messages: [
          { role: "system", content: DRAFTER_SYSTEM },
          { role: "user", content: `Example goal: ${task.goal}\n\nWhat the agent did:\n${commands.join("\n")}\n\nResult:\n${String((task.report as { finalText?: string } | null)?.finalText ?? "")}` },
        ],
      },
      { workspaceId: task.workspaceId, agentId: task.agentId, privacy: "normal" },
    );
    const json = (() => {
      try {
        return JSON.parse(res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1)) as unknown;
      } catch {
        return null;
      }
    })();
    const draft = Draft.safeParse(json);
    if (!draft.success) return { drafted: false, reason: "the drafter did not return a skill" };
    const name = draft.data.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "new-skill";
    // New skills never get rights automatically: they always need approval to be used for anything but reading.
    const fm = SkillFrontmatter.parse({ name, description: draft.data.description, inputs: draft.data.inputs, tools: ["terminal"], needs_approval: true });
    const files: SkillFiles = {
      "SKILL.md": renderSkillMd(fm, `${draft.data.instructions}\n\nRun: \`bash ${READONLY_ROOT}/${name}/run.sh${fm.inputs.map((i) => ` <${i.name}>`).join("")}\``),
      "run.sh": draft.data.script.endsWith("\n") ? draft.data.script : `${draft.data.script}\n`,
    };
    const ref = { workspaceId: task.workspaceId, agentId: task.agentId };
    let stored;
    try {
      stored = await this.addVersion({ ...ref, files, trigger: trigger, createdBy: "agent", exampleTaskId: task.id, status: "draft" });
    } catch (err) {
      return { drafted: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const dry = await this.dryRun(ref, name, stored.version.version, files, stored.version.rights);
    await this.db.db.update(skillVersions).set({ dryRun: dry }).where(eq(skillVersions.id, stored.version.id));
    await this.events.write(task.workspaceId, {
      type: "skill.drafted",
      agentId: task.agentId,
      payload: { skillId: stored.skill.id, version: stored.version.version, name, trigger: trigger },
    });
    return { drafted: true, reason: trigger, skillId: stored.skill.id, version: stored.version.version };
  }

  /** Approve (optionally with edits, which become a new version) or reject a draft. */
  async decide(workspaceId: string, skillId: string, version: number, decision: "approve" | "reject", userId: string, editedFiles?: SkillFiles) {
    const [skill] = await this.db.db.select().from(skills).where(and(eq(skills.id, skillId), eq(skills.workspaceId, workspaceId)));
    if (!skill) return null;
    const [v] = await this.db.db.select().from(skillVersions).where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version), eq(skillVersions.status, "draft")));
    if (!v) return null;
    if (decision === "reject") {
      await this.db.db.update(skillVersions).set({ status: "rejected", decidedBy: userId, decidedAt: new Date() }).where(eq(skillVersions.id, v.id));
      await this.events.write(workspaceId, { type: "skill.rejected", agentId: skill.agentId, payload: { skillId, version, reason: "rejected by a human", userId } });
      return { version };
    }
    let approved = version;
    if (editedFiles) {
      await this.db.db.update(skillVersions).set({ status: "rejected", decidedBy: userId, decidedAt: new Date() }).where(eq(skillVersions.id, v.id));
      const edited = await this.addVersion({ workspaceId, agentId: skill.agentId, files: editedFiles, trigger: v.trigger as "human", createdBy: userId, exampleTaskId: v.exampleTaskId, status: "approved" });
      approved = edited.version.version;
    } else {
      await this.db.db.update(skillVersions).set({ status: "approved", decidedBy: userId, decidedAt: new Date() }).where(eq(skillVersions.id, v.id));
    }
    if (!editedFiles) await this.activate(skillId, approved, v.files as SkillFiles);
    await this.events.write(workspaceId, { type: "skill.approved", agentId: skill.agentId, payload: { skillId, version: approved, userId } });
    return { version: approved };
  }

  async rollback(workspaceId: string, skillId: string, version: number, userId: string): Promise<boolean> {
    const [v] = await this.db.db
      .select()
      .from(skillVersions)
      .innerJoin(skills, eq(skills.id, skillVersions.skillId))
      .where(and(eq(skills.id, skillId), eq(skills.workspaceId, workspaceId), eq(skillVersions.version, version), eq(skillVersions.status, "approved")));
    if (!v) return false;
    await this.activate(skillId, version, v.skill_versions.files as SkillFiles);
    await this.events.write(workspaceId, { type: "skill.rolled_back", agentId: v.skills.agentId, payload: { skillId, version, userId } });
    return true;
  }

  /** Installs the approved skills relevant to a goal into the agent's computer (read-only). */
  async offer(ref: { workspaceId: string; agentId: string }, taskId: string, goal: string): Promise<{ context: string; offered: OfferedSkill[] }> {
    const [q] = await this.embedder.embed([goal]);
    const rows = await this.db.db
      .select({ s: skills, v: skillVersions })
      .from(skills)
      .innerJoin(skillVersions, and(eq(skillVersions.skillId, skills.id), eq(skillVersions.version, sql`${skills.activeVersion}`)))
      .where(and(eq(skills.workspaceId, ref.workspaceId), or(isNull(skills.agentId), eq(skills.agentId, ref.agentId)), eq(skillVersions.status, "approved")));
    const ranked = rows
      .map((r) => ({ ...r, score: q ? cosine(r.s.embedding, q) : 0 }))
      .filter((r) => r.score >= 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    const offered: OfferedSkill[] = [];
    for (const { s, v } of ranked) {
      for (const [path, content] of Object.entries(v.files)) await this.computers.writeReadonly(ref, `${s.name}/${path}`, Buffer.from(content));
      offered.push({ skillId: s.id, version: v.version, name: s.name, rights: v.rights as ActionKind });
      await this.events.write(ref.workspaceId, { type: "skill.offered", agentId: ref.agentId, payload: { skillId: s.id, version: v.version, name: s.name, taskId } });
    }
    if (offered.length === 0) return { context: "", offered };
    const lines = ranked.map(({ s }) => `- ${READONLY_ROOT}/${s.name}/SKILL.md: ${s.description}`);
    return { context: `Skills you can use (read SKILL.md first; prefer a skill when it fits):\n${lines.join("\n")}`, offered };
  }

  /** The trusted kind for `bash /opt/northbot-skills/<name>/<script>` when that skill was offered. */
  static classify(offered: OfferedSkill[], tool: string, args: Record<string, unknown>): ActionKind | null {
    if (tool !== "terminal") return null;
    const m = String(args.command ?? "").trim().match(SKILL_CMD);
    return offered.find((o) => o.name === m?.[1])?.rights ?? null;
  }

  static usedSkill(offered: OfferedSkill[], summary: string): OfferedSkill | null {
    return offered.find((o) => summary.includes(`${READONLY_ROOT}/${o.name}/`)) ?? null;
  }

  /** Re-embeds skill descriptions stored by an older embedder (run at startup). */
  async reembedStale(): Promise<number> {
    const stale = await this.db.db.select().from(skills).where(sql`${skills.embeddingModel} <> ${this.embedder.model}`);
    for (const s of stale) {
      const [embedding] = await this.embedder.embed([`${s.name.replace(/-/g, " ")} ${s.description}`]);
      if (embedding) await this.db.db.update(skills).set({ embedding, embeddingModel: this.embedder.model }).where(eq(skills.id, s.id));
    }
    return stale.length;
  }

  async list(workspaceId: string) {
    const rows = await this.db.db.select().from(skills).where(eq(skills.workspaceId, workspaceId)).orderBy(asc(skills.name));
    const versions = rows.length
      ? await this.db.db.select().from(skillVersions).where(inArray(skillVersions.skillId, rows.map((r) => r.id))).orderBy(desc(skillVersions.version))
      : [];
    return rows.map((s) => ({ skill: s, versions: versions.filter((v) => v.skillId === s.id) }));
  }
}
