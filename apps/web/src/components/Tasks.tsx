import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";

interface Claim {
  text: string;
  status: "verified" | "inferred" | "guessed";
}

interface Task {
  id: string;
  goal: string;
  status: string;
  error: string | null;
  costUsd: number;
  report: { summary?: string; finalText?: string; claims?: Claim[] } | null;
}

const ACTIVE = ["queued", "running", "waiting_approval"];
const CLAIM_STYLE: Record<Claim["status"], string> = { verified: "bg-mint text-emerald-300", inferred: "bg-sky text-sky-300", guessed: "bg-peach text-amber-300" };

/** Give an agent a task and follow it: status, cost, and the verified report. */
export function Tasks({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [taught, setTaught] = useState<Record<string, string>>({});

  const load =async () => setTasks((await api<{ tasks: Task[] }>("GET", `/agents/${agentId}/tasks`)).tasks);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [agentId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("POST", `/agents/${agentId}/tasks`, { goal });
      setGoal("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("tasks.failed"));
    }
  };

  const teach = async (taskId: string) => {
    try {
      const r = await api<{ drafted: boolean; reason: string }>("POST", "/skills/teach", { taskId });
      setTaught({ ...taught, [taskId]: r.drafted ? t("tasks.skillDrafted") : t("tasks.skillNot", { reason: r.reason }) });
    } catch (err) {
      setTaught({ ...taught, [taskId]: err instanceof ApiError ? err.message : t("tasks.failed") });
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-label={t("tasks.title")}>
      <h3 className="font-bold">{t("tasks.title")}</h3>
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          className="flex-1 rounded-blob border border-line px-3 py-2 text-ink"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={t("tasks.placeholder", { name: agentName })}
          aria-label={t("tasks.placeholder", { name: agentName })}
          required
        />
        <button className="rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft">{t("tasks.give")}</button>
      </form>
      {error && <p role="alert" className="text-accent">{error}</p>}
      <ul className="flex flex-col gap-2">
        {tasks.map((task) => (
          <li key={task.id} className="rounded-blob bg-panel p-3 shadow-soft">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{task.goal}</span>
              <span className="text-sm">
                {t(`tasks.status.${task.status}`, { defaultValue: task.status })} · ${task.costUsd.toFixed(4)}
              </span>
            </div>
            {task.error && <p className="text-sm text-accent">{task.error}</p>}
            {task.report?.finalText && <p className="mt-2 text-sm">{task.report.finalText}</p>}
            {task.report?.claims && (
              <ul className="mt-2 flex flex-wrap gap-1">
                {task.report.claims.map((c, i) => (
                  <li key={i} className={`rounded-blob px-2 py-0.5 text-xs ${CLAIM_STYLE[c.status]}`}>
                    {t(`claims.${c.status}`)}: {c.text}
                  </li>
                ))}
              </ul>
            )}
            {ACTIVE.includes(task.status) && (
              <button type="button" className="mt-2 text-sm underline" onClick={() => void api("POST", `/tasks/${task.id}/cancel`).then(load)}>
                {t("tasks.cancel")}
              </button>
            )}
            {task.status === "done" &&
              (taught[task.id] ? (
                <p role="status" className="mt-2 text-sm text-muted">
                  {taught[task.id]}
                </p>
              ) : (
                <button type="button" className="mt-2 text-sm underline" onClick={() => void teach(task.id)}>
                  {t("tasks.makeSkill")}
                </button>
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
