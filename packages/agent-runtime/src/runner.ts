import { createHash } from "node:crypto";
import { z } from "zod";
import { RouterError, type ChatMessage, type ChatRequest, type ChatResult, type ToolCall, type ToolDef } from "@northbot/llm-router";
import { classify, describe, extractTargets } from "./classify.js";
import { alwaysRuleFor, decide } from "./permissions.js";
import { CRITIQUE_PROMPT, PLANNER_SYSTEM, TOOLS, VERIFIER_SYSTEM, workerSystemPrompt } from "./prompts.js";
import { checkOutbound, looksLikeInjection, wrapUntrusted } from "./shield.js";
import type { ActionKind, Autonomy, PermissionRule, ProposedAction } from "./types.js";

export type TaskStatus = "running" | "waiting_approval" | "done" | "failed" | "killed" | "blocked";
export type ClaimStatus = "verified" | "inferred" | "guessed";

export interface Report {
  finalText: string;
  summary: string;
  claims: { text: string; status: ClaimStatus; evidence: string }[];
}

/** Everything needed to continue a task after a restart. Saved after every step. */
export interface TaskState {
  taskId: string;
  goal: string;
  status: TaskStatus;
  plan: string[] | null;
  messages: ChatMessage[];
  steps: number;
  failures: number;
  tainted: boolean;
  critiqued: boolean;
  report: Report | null;
  error: string | null;
}

export type ApprovalAnswer = "approve_once" | "approve_always" | "deny";

/**
 * A tool beyond the terminal and browser (NorthBot features, later MCP tools). Its action kind
 * is fixed by whoever registers it, and its calls go through the same shield, permissions and
 * idempotency ledger as any other action.
 */
export interface ExtraTool {
  def: ToolDef;
  kind: ActionKind;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<{ output: string; ok: boolean }>;
}

export interface RunnerDeps {
  agent: { name: string; persona: string; autonomy: Autonomy };
  models: { worker: string; planner: string; verifier: string };
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
  terminal(command: string, timeoutMs: number, signal: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  browser(args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
  /** Visible text of the element a click targets (for classification); "" if unknown. */
  elementText(selector: string): Promise<string>;
  rules(): Promise<PermissionRule[]>;
  saveRule(rule: PermissionRule): Promise<void>;
  askHuman(action: ProposedAction, reason: string, signal: AbortSignal): Promise<ApprovalAnswer>;
  /** Resolves when no human has taken over the computer. */
  waitForControl(signal: AbortSignal): Promise<void>;
  /** Idempotency ledger for write/spend/send/delete/login actions. */
  actionBegin(key: string, action: ProposedAction): Promise<{ done: true; result: string } | { done: false }>;
  actionFinish(key: string, result: string, ok: boolean): Promise<void>;
  save(state: TaskState): Promise<void>;
  emit(type: string, payload: Record<string, unknown>): Promise<void>;
  setAgentStatus(status: "working" | "waiting" | "idle" | "blocked"): Promise<void>;
  /** Optional: asks before a long job; returns false to stop. */
  approveEstimate?(steps: string[], signal: AbortSignal): Promise<boolean>;
  /** Optional: extra context for the opening message (relevant memories, offered skills). */
  context?(): Promise<string>;
  /** Optional: a trusted classification for known commands (installed, audited skills). */
  classifyOverride?(tool: string, args: Record<string, unknown>): ActionKind | null;
  /** Optional: more tools for the model. Names must not clash with terminal or browser. */
  tools?: ExtraTool[];
  maxSteps?: number;
  maxFailures?: number;
}

const OUTPUT_LIMIT = 8000;
const OUTBOUND = new Set(["send", "spend", "login"]);

class Escalate extends Error {}
class Killed extends Error {}

export function newTaskState(taskId: string, goal: string): TaskState {
  return { taskId, goal, status: "running", plan: null, messages: [], steps: 0, failures: 0, tainted: false, critiqued: false, report: null, error: null };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function firstJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const PlanJson = z.object({ steps: z.array(z.string()).min(1).max(20) });
const VerdictJson = z.object({
  summary: z.string(),
  claims: z.array(z.object({ text: z.string(), status: z.enum(["verified", "inferred", "guessed"]), evidence: z.string().default("") })),
});

/**
 * The agent loop: plan, then call the model with the terminal and browser tools, run each
 * call through the shield, permissions and the idempotency ledger, observe, self-critique
 * once, and finish with a report that a second model call verifies claim by claim.
 */
export class TaskRunner {
  private readonly maxSteps: number;
  private readonly maxFailures: number;

  constructor(private readonly d: RunnerDeps) {
    this.maxSteps = d.maxSteps ?? 30;
    this.maxFailures = d.maxFailures ?? 3;
  }

  async run(state: TaskState, signal: AbortSignal): Promise<TaskState> {
    try {
      await this.d.setAgentStatus("working");
      if (!state.plan) await this.plan(state, signal);
      if (state.messages.length === 0) {
        const plan = state.plan?.length ? `\n\nPlan:\n${state.plan.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "";
        const extra = this.d.context ? await this.d.context() : "";
        state.messages = [
          { role: "system", content: workerSystemPrompt(this.d.agent.name, this.d.agent.persona) },
          { role: "user", content: `Goal: ${state.goal}${plan}${extra ? `\n\n${extra}` : ""}` },
        ];
        await this.d.save(state);
      }
      const finalText = await this.loop(state, signal);
      state.report = await this.verify(state, finalText, signal);
      state.status = "done";
      await this.d.emit("task.report", { taskId: state.taskId, ...state.report });
    } catch (err) {
      if (err instanceof Killed || signal.aborted) {
        state.status = "killed";
        state.error = "Stopped by the kill switch.";
      } else if (err instanceof Escalate) {
        state.status = "blocked";
        state.error = err.message;
        await this.d.emit("task.escalated", { taskId: state.taskId, reason: err.message });
      } else {
        state.status = "failed";
        state.error = err instanceof RouterError ? err.message : err instanceof Error ? err.message : String(err);
      }
    }
    await this.d.save(state);
    await this.d.emit("task.finished", { taskId: state.taskId, status: state.status, error: state.error, steps: state.steps });
    await this.d.setAgentStatus(state.status === "blocked" ? "blocked" : "idle").catch(() => {});
    return state;
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted) throw new Killed();
  }

  private async plan(state: TaskState, signal: AbortSignal): Promise<void> {
    const res = await this.d.chat(
      { model: this.d.models.planner, messages: [{ role: "system", content: PLANNER_SYSTEM }, { role: "user", content: state.goal }] },
      signal,
    );
    const parsed = PlanJson.safeParse(firstJson(res.text));
    state.plan = parsed.success ? parsed.data.steps : [state.goal];
    await this.d.emit("task.plan", { taskId: state.taskId, steps: state.plan });
    if (this.d.approveEstimate && !(await this.d.approveEstimate(state.plan, signal))) {
      throw new Escalate("The estimated cost was not approved.");
    }
    await this.d.save(state);
  }

  private pendingCalls(state: TaskState): ToolCall[] {
    const last = [...state.messages].reverse().find((m) => m.role === "assistant");
    if (!last || last.role !== "assistant" || !last.toolCalls?.length) return [];
    const answered = new Set(state.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
    return last.toolCalls.filter((c) => !answered.has(c.id));
  }

  private async loop(state: TaskState, signal: AbortSignal): Promise<string> {
    for (;;) {
      this.check(signal);
      // Resume: finish tool calls a crash left without results (the ledger stops double runs).
      for (const call of this.pendingCalls(state)) {
        const { content, isError } = await this.handle(state, call, signal);
        state.messages.push({ role: "tool", toolCallId: call.id, content, ...(isError ? { isError } : {}) });
        await this.d.save(state);
      }
      if (state.steps >= this.maxSteps) throw new Escalate(`Reached the step limit (${this.maxSteps}) without finishing.`);
      const res = await this.d.chat({ model: this.d.models.worker, messages: state.messages, tools: [...TOOLS, ...(this.d.tools ?? []).map((t) => t.def)] }, signal);
      this.check(signal);
      state.steps += 1;
      state.messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls, raw: res.raw });
      await this.d.save(state);
      if (res.toolCalls.length) continue;
      if (!state.critiqued) {
        state.critiqued = true;
        await this.d.emit("task.critique", { taskId: state.taskId, draft: res.text.slice(0, 2000) });
        state.messages.push({ role: "user", content: CRITIQUE_PROMPT });
        await this.d.save(state);
        continue;
      }
      return res.text;
    }
  }

  private async handle(state: TaskState, call: ToolCall, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    } catch {
      return { content: "Error: the tool arguments were not valid JSON.", isError: true };
    }
    const extra = this.d.tools?.find((t) => t.def.name === call.name);
    if (call.name !== "terminal" && call.name !== "browser" && !extra) return { content: `Error: unknown tool "${call.name}".`, isError: true };
    const elementText = call.name === "browser" && args.action === "click" && args.selector ? await this.d.elementText(String(args.selector)).catch(() => "") : "";
    const classified: ProposedAction = extra
      ? { tool: call.name, args, kind: extra.kind, summary: describe(call.name, args), targets: extractTargets(JSON.stringify(args)) }
      : classify(call.name, args, elementText);
    const override = this.d.classifyOverride?.(call.name, args);
    const action = override ? { ...classified, kind: override } : classified;
    await this.d.emit("task.step", { taskId: state.taskId, tool: action.tool, kind: action.kind, summary: action.summary });

    const rules = await this.d.rules();
    if (OUTBOUND.has(action.kind)) {
      const allowTargets = rules.filter((r) => r.effect === "allow").flatMap((r) => r.targets ?? []);
      const verdict = checkOutbound(action, state.goal, allowTargets);
      if (!verdict.ok) {
        await this.d.emit("shield.blocked", { taskId: state.taskId, summary: action.summary, kind: action.kind, reason: verdict.reason });
        return { content: `Blocked by NorthBot's safety shield: ${verdict.reason} Do not try another way; mention it in your report.`, isError: true };
      }
    }
    let perm = decide(action, rules, this.d.agent.autonomy);
    if (perm.decision === "allow" && state.tainted && OUTBOUND.has(action.kind)) {
      perm = { decision: "ask", reason: "Content seen in this task tried to give the agent instructions, so outbound actions need a human." };
    }
    if (perm.decision === "block") {
      await this.d.emit("permission.blocked", { taskId: state.taskId, summary: action.summary, kind: action.kind, reason: perm.reason });
      return { content: `Not allowed: ${perm.reason}. Mention it in your report instead.`, isError: true };
    }
    if (perm.decision === "ask") {
      // Agent status first, so anyone who sees the waiting task also sees a waiting agent.
      await this.d.setAgentStatus("waiting");
      state.status = "waiting_approval";
      await this.d.save(state);
      const answer = await this.d.askHuman(action, perm.reason, signal);
      this.check(signal);
      state.status = "running";
      await this.d.setAgentStatus("working");
      if (answer === "deny") return { content: `A human said no to: ${action.summary}. Do not retry it.`, isError: true };
      if (answer === "approve_always") await this.d.saveRule(alwaysRuleFor(action));
    }

    await this.d.waitForControl(signal);
    this.check(signal);

    const key = action.kind === "read" ? null : createHash("sha256").update(`${state.taskId}|${action.tool}|${canonical(args)}`).digest("hex");
    if (key) {
      const prior = await this.d.actionBegin(key, action);
      if (prior.done) {
        await this.d.emit("action.deduplicated", { taskId: state.taskId, summary: action.summary, idempotencyKey: key });
        return { content: wrapUntrusted(call.name, `(already done earlier in this task; not repeated)\n${prior.result}`), isError: false };
      }
    }

    const { output, ok } = await this.execute(call.name, args, signal);
    if (key) await this.d.actionFinish(key, output, ok);
    if (looksLikeInjection(output) && !state.tainted) {
      state.tainted = true;
      await this.d.emit("shield.injection_detected", { taskId: state.taskId, source: action.summary });
    }
    if (ok) state.failures = 0;
    else {
      state.failures += 1;
      if (state.failures >= this.maxFailures) {
        throw new Escalate(`${state.failures} attempts in a row failed (last: ${action.summary}). A human should take a look.`);
      }
    }
    const hint = ok ? "" : `\n\n(This failed, attempt ${state.failures} of ${this.maxFailures}. Try a different method.)`;
    return { content: wrapUntrusted(call.name, output.slice(0, OUTPUT_LIMIT) + hint), isError: !ok };
  }

  private async execute(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ output: string; ok: boolean }> {
    try {
      const extra = this.d.tools?.find((t) => t.def.name === tool);
      if (extra) return await extra.run(args, signal);
      if (tool === "terminal") {
        const timeoutMs = Math.min(600, Math.max(1, Number(args.timeout_s ?? 120))) * 1000;
        const r = await this.d.terminal(String(args.command ?? ""), timeoutMs, signal);
        const out = [`exit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`, r.stdout && `stdout:\n${r.stdout}`, r.stderr && `stderr:\n${r.stderr}`]
          .filter(Boolean)
          .join("\n");
        return { output: out, ok: r.exitCode === 0 };
      }
      const r = await this.d.browser(args, signal);
      const { png: _png, ...rest } = r;
      return { output: JSON.stringify(rest, null, 1), ok: true };
    } catch (err) {
      if (signal.aborted) throw new Killed();
      return { output: `error: ${err instanceof Error ? err.message : String(err)}`, ok: false };
    }
  }

  private async verify(state: TaskState, finalText: string, signal: AbortSignal): Promise<Report> {
    const evidence = state.messages
      .flatMap((m) => {
        if (m.role === "assistant" && m.toolCalls?.length) return m.toolCalls.map((c) => `CALL ${c.name} ${c.arguments}`);
        if (m.role === "tool") return [`RESULT ${m.content.slice(0, 1500)}`];
        return [];
      })
      .join("\n")
      .slice(-20_000);
    const res = await this.d.chat(
      {
        model: this.d.models.verifier,
        messages: [
          { role: "system", content: VERIFIER_SYSTEM },
          { role: "user", content: `Goal: ${state.goal}\n\nEvidence:\n${evidence || "(no tool calls)"}\n\nReport:\n${finalText}` },
        ],
      },
      signal,
    );
    const parsed = VerdictJson.safeParse(firstJson(res.text));
    if (parsed.success) return { finalText, ...parsed.data };
    return { finalText, summary: finalText.slice(0, 500), claims: [{ text: finalText.slice(0, 500), status: "guessed", evidence: "The verifier did not return a readable check." }] };
  }
}
