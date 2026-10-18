import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";

interface Check {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}
interface Health {
  version: string;
  uptimeSeconds: number;
  databaseMs: number;
  tasks24h: Record<string, number>;
  failureRate: number;
  llm24h: { calls: number; errors: number; costUsd: number };
  computers: Record<string, number>;
  schedules: { enabled: number; failing: number };
  deadLetters: number;
  canary: { ok: boolean; at: string; checks: Check[] } | null;
}
interface DeadLetter {
  id: string;
  kind: "task" | "schedule_run";
  summary: string;
  reason: string;
  createdAt: string;
}
interface Run {
  id: string;
  agentName: string | null;
  goal: string;
  status: string;
  schedule: string | null;
  error: string | null;
  costUsd: number;
  createdAt: string;
}
interface Incident {
  id: string;
  title: string;
  severity: string;
  createdAt: string;
}
interface Pack {
  name: string;
  installed: boolean;
  agents: { key: string; name: string; role: string; installedAs: string | null }[];
}

const duration = (s: number) =>
  s < 3600
    ? `${Math.round(s / 60)} min`
    : s < 86_400
      ? `${Math.round(s / 3600)} h`
      : `${Math.round(s / 86_400)} d`;

/** Operations: health dashboard, canary checks, dead letters, run history, incidents and packs. */
export function Operations() {
  const { t } = useTranslation();
  const o = (k: string, v?: Record<string, unknown>) => t(`ops.${k}`, v);
  const p = (k: string, v?: Record<string, unknown>) => t(`packs.${k}`, v);
  const [health, setHealth] = useState<Health | null>(null);
  const [dead, setDead] = useState<DeadLetter[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [query, setQuery] = useState({ q: "", status: "" });
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentTitle, setIncidentTitle] = useState("");
  const [packs, setPacks] = useState<Pack[]>([]);
  const [report, setReport] = useState<{ markdown: string; awaitingApproval: string[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const searchRuns = async (q = query) => {
    const params = new URLSearchParams();
    if (q.q) params.set("q", q.q);
    if (q.status) params.set("status", q.status);
    setRuns((await api<{ runs: Run[] }>("GET", `/ops/runs?${params}`)).runs);
  };
  const load = async () => {
    const [h, d, i, pk] = await Promise.all([
      api<Health>("GET", "/ops/health"),
      api<{ deadLetters: DeadLetter[] }>("GET", "/ops/dead-letters"),
      api<{ incidents: Incident[] }>("GET", "/ops/incidents"),
      api<{ packs: Pack[] }>("GET", "/packs"),
    ]);
    setHealth(h);
    setDead(d.deadLetters);
    setIncidents(i.incidents);
    setPacks(pk.packs);
  };
  useEffect(() => {
    void load().catch(() => setError(o("noCanary")));
    void searchRuns();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : p("failed"));
    } finally {
      setBusy(false);
    }
  };
  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    void searchRuns();
  };
  const store = packs.find((x) => x.name === "store-operator");

  return (
    <section className="flex max-w-5xl flex-col gap-5">
      <header>
        <p className="eyebrow">NorthBot</p>
        <h2 className="text-3xl font-extrabold">{o("title")}</h2>
        <p className="text-muted">{o("intro")}</p>
      </header>
      {error && (
        <p role="alert" className="text-accent">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}

      {health && (
        <div className="settings-card flex flex-col gap-3" aria-label={o("health")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xl font-bold">{o("health")}</h3>
            <span className="text-sm text-muted">
              v{health.version} · {o("uptime", { time: duration(health.uptimeSeconds) })} ·{" "}
              {o("dbLatency", { ms: health.databaseMs })}
            </span>
          </div>
          <dl className="grid gap-2 sm:grid-cols-4">
            {[
              [
                o("tasks24h"),
                Object.entries(health.tasks24h)
                  .map(([k, v]) => `${t(`tasks.status.${k}`, { defaultValue: k })} ${v}`)
                  .join(" · ") || "0",
              ],
              [o("failureRate"), `${Math.round(health.failureRate * 100)}%`],
              [
                o("llm24h"),
                `${health.llm24h.calls} · ${health.llm24h.errors} ${o("errors")} · $${health.llm24h.costUsd.toFixed(2)} ${o("cost")}`,
              ],
              [
                o("schedules"),
                `${health.schedules.enabled} · ${health.schedules.failing} ${o("failing")}`,
              ],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-line p-3">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="font-bold">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-bold">{o("canary")}</h4>
            <div className="flex gap-3 text-sm">
              <a className="underline" href="/api/status" target="_blank" rel="noreferrer">
                {o("statusPage")}
              </a>
              <button
                type="button"
                disabled={busy}
                className="rounded-blob bg-sky px-3 py-1 font-bold shadow-soft"
                onClick={() => void act(() => api("POST", "/ops/canary"))}
              >
                {o("runCanary")}
              </button>
            </div>
          </div>
          {health.canary ? (
            <ul className="grid gap-2 sm:grid-cols-2" data-testid="canary-checks">
              {health.canary.checks.map((c) => (
                <li
                  key={c.name}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line p-2 text-sm"
                >
                  <span>{o(`checks.${c.name}`)}</span>
                  <span className={c.ok ? "text-mint" : "text-accent"} title={c.error}>
                    {c.ok ? o("ok") : o("failingCheck")} · {c.ms} ms
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{o("noCanary")}</p>
          )}
        </div>
      )}

      <div className="settings-card flex flex-col gap-3">
        <h3 className="text-xl font-bold">{o("dead")}</h3>
        {dead.length === 0 && <p className="text-muted">{o("deadEmpty")}</p>}
        <ul className="flex flex-col gap-2">
          {dead.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3 text-sm"
            >
              <div>
                <strong>{o(`kinds.${d.kind}`)}:</strong> {d.summary}
                <p className="text-xs text-accent">{d.reason}</p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-blob bg-rainbow px-3 py-1 font-bold shadow-soft"
                  onClick={() => void act(() => api("POST", `/ops/dead-letters/${d.id}/retry`))}
                >
                  {o("retry")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-blob bg-peach px-3 py-1 shadow-soft"
                  onClick={() => void act(() => api("POST", `/ops/dead-letters/${d.id}/dismiss`))}
                >
                  {o("dismiss")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="settings-card flex flex-col gap-3">
        <h3 className="text-xl font-bold">{o("runs")}</h3>
        <form onSubmit={submitSearch} className="flex flex-wrap gap-2" role="search">
          <input
            className="flex-1 rounded-blob border border-line bg-peach px-3 py-2 text-ink"
            value={query.q}
            onChange={(e) => setQuery({ ...query, q: e.target.value })}
            placeholder={o("search")}
            aria-label={o("search")}
          />
          <select
            aria-label={o("allStatuses")}
            className="rounded-blob border border-line bg-peach px-3 py-2 text-ink"
            value={query.status}
            onChange={(e) => setQuery({ ...query, status: e.target.value })}
          >
            <option value="">{o("allStatuses")}</option>
            {["done", "failed", "blocked", "killed", "running"].map((s) => (
              <option key={s} value={s}>
                {t(`tasks.status.${s}`, { defaultValue: s })}
              </option>
            ))}
          </select>
          <button className="rounded-blob bg-sky px-4 py-2 font-bold shadow-soft">
            {t("memory.searchButton")}
          </button>
        </form>
        {runs.length === 0 ? (
          <p className="text-muted">{o("noRuns")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="run-history">
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td className="p-2 text-xs text-muted">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="p-2 font-bold">{r.agentName}</td>
                    <td className="p-2">
                      {r.goal}
                      {r.schedule && (
                        <span className="block text-xs text-muted">⏰ {r.schedule}</span>
                      )}
                      {r.error && <span className="block text-xs text-accent">{r.error}</span>}
                    </td>
                    <td className="p-2">
                      {t(`tasks.status.${r.status}`, { defaultValue: r.status })}
                    </td>
                    <td className="p-2 text-xs">${r.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="settings-card flex flex-col gap-3">
        <h3 className="text-xl font-bold">{o("incidents")}</h3>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api("POST", "/ops/incidents", incidentTitle ? { title: incidentTitle } : {});
              setIncidentTitle("");
            });
          }}
        >
          <input
            className="flex-1 rounded-blob border border-line bg-peach px-3 py-2 text-ink"
            value={incidentTitle}
            onChange={(e) => setIncidentTitle(e.target.value)}
            placeholder={o("incidentTitle")}
            aria-label={o("incidentTitle")}
          />
          <button
            disabled={busy}
            className="rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft"
          >
            {o("makeIncident")}
          </button>
        </form>
        <ul className="flex flex-col gap-1 text-sm">
          {incidents.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>{i.title}</strong> · {o("severity")}: {i.severity} ·{" "}
                {new Date(i.createdAt).toLocaleString()}
              </span>
              <a className="underline" href={`/api/ops/incidents/${i.id}.md`}>
                {o("download")}
              </a>
            </li>
          ))}
        </ul>
      </div>

      {store && (
        <div className="settings-card flex flex-col gap-3">
          <h3 className="text-xl font-bold">
            {p("title")}: {p("storeTitle")}
          </h3>
          <p className="text-sm text-muted">{p("storeIntro")}</p>
          <p className="text-sm">{store.agents.map((a) => `${a.name} (${a.role})`).join(" · ")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || store.installed}
              className="rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft disabled:opacity-60"
              onClick={() =>
                void act(async () => {
                  const r = await api<{ agents: number; rules: number; schedules: number }>(
                    "POST",
                    "/packs/store-operator/install",
                  );
                  setNote(p("installedNote", r));
                })
              }
            >
              {store.installed ? p("installed") : p("install")}
            </button>
            {store.installed && (
              <button
                type="button"
                disabled={busy}
                className="rounded-blob bg-sky px-4 py-2 font-bold shadow-soft"
                onClick={() =>
                  void act(async () =>
                    setReport(await api("POST", "/packs/store-operator/simulate", {})),
                  )
                }
              >
                {p("simulate")}
              </button>
            )}
          </div>
          {report && (
            <div className="flex flex-col gap-2">
              <pre
                className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-cream p-3 text-xs"
                data-testid="profit-report"
              >
                {report.markdown}
              </pre>
              {report.awaitingApproval.length > 0 && (
                <div className="text-sm">
                  <strong>{p("awaiting")}</strong>
                  <ul className="list-disc pl-5">
                    {report.awaitingApproval.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
