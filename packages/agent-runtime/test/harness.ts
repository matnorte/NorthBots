import { FakeTurn, Router, RouterConfig } from "@northbot/llm-router";
import { FakeSandbox } from "@northbot/sandbox";
import {
  newTaskState,
  TaskRunner,
  type ApprovalAnswer,
  type PermissionRule,
  type ProposedAction,
  type RunnerDeps,
  type TaskState,
} from "../src/index.js";

type Turn = { text?: string; call?: [tool: string, args: Record<string, unknown>] };

/** Builds a runner wired to scripted fake models and an in-memory computer. */
export function harness(opts: {
  worker: Turn[];
  plan?: string[];
  verdict?: object;
  autonomy?: RunnerDeps["agent"]["autonomy"];
  answer?: (a: ProposedAction) => Promise<ApprovalAnswer>;
  rules?: PermissionRule[];
}) {
  const script = opts.worker.map((t) =>
    FakeTurn.parse(t.call ? { toolCalls: [{ name: t.call[0], arguments: t.call[1] }] } : { text: t.text ?? "" }),
  );
  const router = new Router(
    RouterConfig.parse({
      providers: [
        { name: "worker", type: "fake", kind: "local", models: ["m"], fake: { script } },
        { name: "planner", type: "fake", kind: "local", models: ["m"], fake: { reply: JSON.stringify({ steps: opts.plan ?? ["do it"] }) } },
        {
          name: "verifier",
          type: "fake",
          kind: "local",
          models: ["m"],
          fake: { reply: JSON.stringify(opts.verdict ?? { summary: "ok", claims: [{ text: "did it", status: "verified", evidence: "exit code 0" }] }) },
        },
      ],
      aliases: {},
    }),
  );
  const sandbox = new FakeSandbox();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const ledger = new Map<string, { done: boolean; result: string }>();
  const saved: TaskState[] = [];
  const rules: PermissionRule[] = [...(opts.rules ?? [])];
  const asked: ProposedAction[] = [];
  const statuses: string[] = [];

  const deps: RunnerDeps = {
    agent: { name: "Pip", persona: "", autonomy: opts.autonomy ?? "ask_first" },
    models: { worker: "worker/m", planner: "planner/m", verifier: "verifier/m" },
    chat: (req, signal) => router.chat(req, { workspaceId: "w", privacy: "normal", signal }),
    terminal: async (command) => {
      const r = await sandbox.exec("a", command);
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    },
    browser: async (args) => {
      const b = await sandbox.browserSession("a");
      return (await b.act(args as Parameters<typeof b.act>[0])) as unknown as Record<string, unknown>;
    },
    elementText: async () => "",
    rules: async () => rules,
    saveRule: async (r) => void rules.push(r),
    askHuman: async (a) => {
      asked.push(a);
      return opts.answer ? opts.answer(a) : "approve_once";
    },
    waitForControl: async () => {},
    actionBegin: async (key) => {
      const prior = ledger.get(key);
      if (prior?.done) return { done: true, result: prior.result };
      ledger.set(key, { done: false, result: "" });
      return { done: false };
    },
    actionFinish: async (key, result) => void ledger.set(key, { done: true, result }),
    save: async (s) => void saved.push(structuredClone(s)),
    emit: async (type, payload) => void events.push({ type, payload }),
    setAgentStatus: async (s) => void statuses.push(s),
  };
  return {
    deps,
    sandbox,
    events,
    saved,
    rules,
    asked,
    statuses,
    async start() {
      await sandbox.create({ id: "a", egressProxyUrl: "" });
    },
    run(goal: string, signal = new AbortController().signal, state?: TaskState) {
      return new TaskRunner(deps).run(state ?? newTaskState("task-1", goal), signal);
    },
    types: () => events.map((e) => e.type),
  };
}
