import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ScheduleDefinition } from "@northbot/scheduler";
import { api, ApiError } from "../api.js";
import { Icon } from "../components/Icon.js";
import { PageState } from "../components/PageState.js";
import type { Agent } from "./Agents.js";
import { useSession } from "../store/session.js";

type Definition = import("@northbot/scheduler").ScheduleDefinition;
interface Schedule {
  id: string;
  agentId: string | null;
  roomId: string | null;
  definition: Definition;
  enabled: boolean;
  systemKey: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  approved: boolean;
}
interface Run {
  id: string;
  scheduleId: string;
  taskId: string | null;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  costUsd: number;
  error: string | null;
  eventIds: number[];
}
interface Preview {
  definition: Definition;
  nextRuns: string[];
  warning: boolean;
  runsPerDay: number;
  monthlyEstimateUsd: number;
}

export function Schedules() {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [items, setItems] = useState<Schedule[]>([]),
    [runs, setRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]),
    [rooms, setRooms] = useState<{ id: string; name: string }[]>([]),
    [skills, setSkills] = useState<{ id: string; name: string; activeVersion: number | null }[]>(
      [],
    );
  const [form, setForm] = useState<Definition>(() => ({
    ...ScheduleDefinition.parse({ name: "routine", taskPrompt: "routine" }),
    name: "",
    taskPrompt: "",
  }));
  const [agentId, setAgentId] = useState(""),
    [roomId, setRoomId] = useState(""),
    [phrase, setPhrase] = useState(""),
    [inputs, setInputs] = useState("{}"),
    [editing, setEditing] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState<string | null>(null),
    [note, setNote] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [failedOnly, setFailedOnly] = useState(false);
  const date = (value: string) =>
    new Date(value).toLocaleString(undefined, { timeZone: form.timezone });
  const load = async () => {
    const [list, history] = await Promise.all([
      api<{ schedules: Schedule[] }>("GET", "/schedules"),
      api<{ runs: Run[] }>("GET", "/schedules/runs"),
    ]);
    setItems(list.schedules);
    setRuns(history.runs);
  };
  useEffect(() => {
    void load().catch(() => setError(t("ui.loadFailed")));
    void api<{ agents: Agent[] }>("GET", "/agents")
      .then((r) => {
        setAgents(r.agents);
        setAgentId(r.agents[0]?.id ?? "");
      })
      .catch(() => {});
    void api<{ rooms: { id: string; name: string }[] }>("GET", "/rooms?kind=room")
      .then((r) => setRooms(r.rooms))
      .catch(() => {});
    void api<{ skills: { id: string; name: string; activeVersion: number | null }[] }>(
      "GET",
      "/skills",
    )
      .then((r) => setSkills(r.skills.filter((s) => s.activeVersion)))
      .catch(() => {});
    void api<{ timezone: string }>("GET", "/settings")
      .then((r) => setForm((f) => ({ ...f, timezone: r.timezone })))
      .catch(() => {});
    const timer = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, []);
  const change = <K extends keyof Definition>(key: K, value: Definition[K]) => {
    setForm((old) => ({ ...old, [key]: value }));
    setPreview(null);
  };
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("schedules.failed"));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await act(async () => {
      const definition = { ...form, inputs: JSON.parse(inputs) as Record<string, unknown> };
      if (!preview) {
        const result = await api<Preview>("POST", "/schedules/preview", {
          definition,
          ...(phrase ? { phrase } : {}),
        });
        setForm(result.definition);
        setPreview(result);
        return;
      }
      if (editing) await api("PATCH", `/schedules/${editing}`, definition);
      else
        await api("POST", "/schedules", {
          agentId: agentId || null,
          roomId: roomId || null,
          definition,
        });
      setEditing(null);
      setPreview(null);
      setNote(t("schedules.saved"));
      setForm((f) => ({ ...f, name: "", taskPrompt: "" }));
      setPhrase("");
    });
  };
  const edit = (row: Schedule, duplicate = false) => {
    setForm({
      ...row.definition,
      name: duplicate ? `${row.definition.name} (2)` : row.definition.name,
    });
    setEditing(duplicate ? null : row.id);
    setAgentId(row.agentId ?? "");
    setRoomId(row.roomId ?? "");
    setInputs(JSON.stringify(row.definition.inputs, null, 2));
    setPhrase("");
    setPreview(null);
    document
      .getElementById("schedule-editor")
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const importFile = async (file: File) => {
    await act(async () => {
      const result = await api<{ count: number }>("POST", "/schedules/import", {
        yaml: await file.text(),
      });
      setNote(t("schedules.imported", { count: result.count }));
    });
  };
  const field = "rounded-blob border border-line bg-panel px-3 py-2 text-ink";
  const numeric = (
    key:
      | "budgetUsdPerRun"
      | "budgetUsdPerDay"
      | "maxRuntimeS"
      | "retries"
      | "retryBackoffS"
      | "jitterS",
    label: string,
    min = 0,
  ) => (
    <label className="flex flex-col gap-2 text-sm">
      {t(`schedules.${label}`)}
      <input
        type="number"
        min={min}
        step={key.startsWith("budget") ? 0.01 : 1}
        value={form[key]}
        onChange={(e) => change(key, Number(e.target.value))}
        className={field}
        required
      />
    </label>
  );
  return (
    <section className="flex flex-col gap-5">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t("ui.yourTeam")}</p>
          <h2>{t("schedules.title")}</h2>
          <p className="page-description">{t("schedules.intro")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="agent-computer px-3" href="/api/schedules/export" download>
            {t("schedules.export")}
          </a>
          <label className="agent-computer cursor-pointer px-3">
            {t("schedules.import")}
            <input
              type="file"
              accept=".yaml,.yml"
              className="sr-only"
              onChange={(e) => {
                if (e.target.files?.[0]) void importFile(e.target.files[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-accent">
          {error}
        </p>
      )}
      {note && (
        <p role="status" className="rounded-blob bg-mint p-3 text-sm">
          {note}
        </p>
      )}
      {!items.some((r) => !r.systemKey) && (
        <PageState
          title={t("schedules.empty")}
          description={t("schedules.emptyHelp")}
          icon="schedules"
        />
      )}
      <ul className="grid gap-3 lg:grid-cols-2">
        {items.map((row) => (
          <li
            key={row.id}
            className="flex flex-col gap-3 rounded-blob border border-line bg-panel p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{row.definition.name}</h3>
                <p className="mt-1 text-xs text-muted">
                  {row.systemKey
                    ? t("schedules.system")
                    : (agents.find((a) => a.id === row.agentId)?.name ??
                      rooms.find((r) => r.id === row.roomId)?.name)}
                </p>
              </div>
              <span className="status-badge">
                {t(row.enabled ? "schedules.enabled" : "schedules.paused")}
              </span>
            </div>
            <p className="text-sm text-muted">{row.definition.taskPrompt}</p>
            <p className="text-xs">
              {t("schedules.at")}:{" "}
              {row.nextRunAt
                ? new Date(row.nextRunAt).toLocaleString(undefined, {
                    timeZone: row.definition.timezone,
                  })
                : t("schedules.noNext")}{" "}
              · {row.definition.timezone}
            </p>
            {row.lastStatus && (
              <p className="text-xs text-muted">
                {t("schedules.last")}:{" "}
                {t(`schedules.status.${row.lastStatus}`, { defaultValue: row.lastStatus })}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {[
                "toggle",
                "run",
                "dry",
                ...(!row.systemKey ? ["edit", "duplicate", "remove"] : []),
              ].map((op) => (
                <button
                  key={op}
                  type="button"
                  className="agent-computer px-3"
                  disabled={busy}
                  onClick={() => {
                    if (op === "edit" || op === "duplicate") return edit(row, op === "duplicate");
                    if (op === "remove" && !window.confirm(t("schedules.removeConfirm"))) return;
                    void act(async () => {
                      if (op === "toggle")
                        await api("PATCH", `/schedules/${row.id}`, { enabled: !row.enabled });
                      else if (op === "remove") await api("DELETE", `/schedules/${row.id}`);
                      else {
                        const result = await api<{ prompt?: string; permission?: string }>(
                          "POST",
                          `/schedules/${row.id}/run`,
                          { dryRun: op === "dry" },
                        );
                        setNote(
                          op === "dry"
                            ? `${t("schedules.dry")}: ${result.prompt ?? ""} · ${t(`schedules.${result.permission ?? "read"}`)}`
                            : t("schedules.queued"),
                        );
                      }
                    });
                  }}
                >
                  {op === "toggle"
                    ? t(row.enabled ? "schedules.pause" : "schedules.resume")
                    : t(`schedules.${op}`)}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <form
        id="schedule-editor"
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4 rounded-blob border border-line bg-panel p-6"
      >
        <h3 className="text-lg font-semibold">{t(editing ? "schedules.edit" : "schedules.new")}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm">
            {t("schedules.name")}
            <input
              className={field}
              value={form.name}
              onChange={(e) => change("name", e.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            {t("schedules.timezone")}
            <input
              className={field}
              value={form.timezone}
              onChange={(e) => change("timezone", e.target.value)}
              required
            />
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm">
            {t("schedules.target")}
            <select
              disabled={Boolean(editing)}
              className={field}
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                setRoomId("");
                setPreview(null);
              }}
            >
              <option value="">{t("schedules.none")}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm">
            {t("schedules.room")}
            <select
              disabled={Boolean(editing)}
              className={field}
              value={roomId}
              onChange={(e) => {
                setRoomId(e.target.value);
                setAgentId("");
                setPreview(null);
              }}
            >
              <option value="">—</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-2 text-sm">
          {t("schedules.prompt")}
          <textarea
            rows={3}
            className={field}
            value={form.taskPrompt}
            onChange={(e) => change("taskPrompt", e.target.value)}
            required
            minLength={3}
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          {t("schedules.phrase")}
          <input
            className={field}
            value={phrase}
            onChange={(e) => {
              setPhrase(e.target.value);
              setPreview(null);
            }}
            placeholder={t("schedules.phraseHint")}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm">
            {t("schedules.kind")}
            <select
              className={field}
              value={form.kind}
              onChange={(e) => {
                change("kind", e.target.value as Definition["kind"]);
                setPhrase("");
              }}
            >
              {(["cron", "once", "interval"] as const).map((v) => (
                <option key={v} value={v}>
                  {t(`schedules.${v}`)}
                </option>
              ))}
            </select>
          </label>
          {form.kind === "cron" ? (
            <label className="flex flex-col gap-2 text-sm">
              {t("schedules.cron")}
              <input
                className={field}
                value={form.cronExpr}
                onChange={(e) => {
                  change("cronExpr", e.target.value);
                  setPhrase("");
                }}
                required
              />
            </label>
          ) : form.kind === "interval" ? (
            <label className="flex flex-col gap-2 text-sm">
              {t("schedules.intervalS")}
              <input
                type="number"
                min={300}
                className={field}
                value={form.intervalS}
                onChange={(e) => change("intervalS", Number(e.target.value))}
              />
            </label>
          ) : (
            <label className="flex flex-col gap-2 text-sm">
              {t("schedules.runAt")}
              <input
                type="datetime-local"
                className={field}
                onChange={(e) =>
                  change("runAt", e.target.value ? new Date(e.target.value).toISOString() : null)
                }
                required
              />
            </label>
          )}
        </div>
        <details>
          <summary className="cursor-pointer text-sm text-muted">{t("schedules.advanced")}</summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {numeric("budgetUsdPerRun", "perRun", 0.01)}
            {numeric("budgetUsdPerDay", "perDay", 0.01)}
            {numeric("maxRuntimeS", "runtime", 1)}
            {numeric("retries", "retries")}
            {numeric("retryBackoffS", "backoff", 1)}
            {numeric("jitterS", "jitter")}
            <label className="flex flex-col gap-2 text-sm">
              {t("schedules.catchup")}
              <select
                className={field}
                value={form.catchupPolicy}
                onChange={(e) =>
                  change("catchupPolicy", e.target.value as Definition["catchupPolicy"])
                }
              >
                {["skip", "run_once", "run_all"].map((v) => (
                  <option key={v} value={v}>
                    {t(`schedules.${v}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm">
              {t("schedules.overlap")}
              <select
                className={field}
                value={form.overlapPolicy}
                onChange={(e) =>
                  change("overlapPolicy", e.target.value as Definition["overlapPolicy"])
                }
              >
                {["skip", "queue", "allow"].map((v) => (
                  <option key={v} value={v}>
                    {t(`schedules.${v}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm">
              {t("schedules.permission")}
              <select
                className={field}
                value={form.actionKind}
                onChange={(e) => change("actionKind", e.target.value as Definition["actionKind"])}
              >
                {["read", "write", "send", "spend", "delete", "login"].map((v) => (
                  <option key={v} value={v}>
                    {t(`schedules.${v}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm">
              {t("schedules.skill")}
              <select
                className={field}
                value={form.skillId ?? ""}
                onChange={(e) => change("skillId", e.target.value || null)}
              >
                <option value="">{t("schedules.noSkill")}</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {form.skillId && (
              <label className="flex flex-col gap-2 text-sm">
                {t("schedules.input")}
                <textarea
                  className={field}
                  value={inputs}
                  onChange={(e) => {
                    setInputs(e.target.value);
                    setPreview(null);
                  }}
                />
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.requiresApprovalFirstRun}
                onChange={(e) => change("requiresApprovalFirstRun", e.target.checked)}
              />
              {t("schedules.approval")}
            </label>
          </div>
        </details>
        {preview && (
          <div className="rounded-blob border border-line bg-cream p-4">
            <h4 className="mb-2 text-sm font-semibold">{t("schedules.next")}</h4>
            <ol className="flex flex-wrap gap-3 text-xs text-muted">
              {preview.nextRuns.map((at) => (
                <li key={at}>{date(at)}</li>
              ))}
            </ol>
            {preview.warning && (
              <p className="mt-3 text-sm text-amber-200">
                {t("schedules.warning", {
                  runs: preview.runsPerDay,
                  cost: preview.monthlyEstimateUsd.toFixed(2),
                })}
              </p>
            )}
          </div>
        )}
        <div className="flex gap-3">
          <button className="primary-button self-start" disabled={busy || (!agentId && !roomId)}>
            <Icon name="schedules" size={16} />
            {t(preview ? "schedules.confirm" : "schedules.preview")}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setPreview(null);
              }}
              className="text-sm underline"
            >
              {t("ui.cancel")}
            </button>
          )}
        </div>
      </form>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{t("schedules.history")}</h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={failedOnly}
            onChange={(e) => setFailedOnly(e.target.checked)}
          />
          {t("schedules.dead")}
        </label>
      </div>
      {runs.length === 0 ? (
        <p className="text-sm text-muted">{t("schedules.noRuns")}</p>
      ) : (
        <div className="overflow-x-auto rounded-blob border border-line">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                <th>{t("schedules.name")}</th>
                <th>{t("schedules.runAt")}</th>
                <th>{t("schedules.last")}</th>
                <th>USD</th>
                <th>{t("schedules.eventTrail")}</th>
              </tr>
            </thead>
            <tbody>
              {runs
                .filter((r) => !failedOnly || r.status === "failed")
                .map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td>{items.find((s) => s.id === r.scheduleId)?.definition.name}</td>
                    <td>{date(r.scheduledAt)}</td>
                    <td>
                      {t(`schedules.status.${r.status}`, { defaultValue: r.status })}
                      {r.error && <p className="mt-1 max-w-xs text-accent">{r.error}</p>}
                    </td>
                    <td>{r.costUsd.toFixed(4)}</td>
                    <td>
                      {r.taskId && items.find((s) => s.id === r.scheduleId)?.agentId && (
                        <button
                          className="underline"
                          type="button"
                          onClick={() =>
                            go({
                              name: "computer",
                              agentId: items.find((s) => s.id === r.scheduleId)!.agentId!,
                            })
                          }
                        >
                          {t("schedules.task")}
                        </button>
                      )}
                      {r.eventIds[0] && (
                        <a
                          className="ml-2 underline"
                          href={`/api/events?from=${r.eventIds[0]}&limit=20`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          #{r.eventIds[0]}
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
