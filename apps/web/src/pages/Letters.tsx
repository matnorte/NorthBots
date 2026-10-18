import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { PageState } from "../components/PageState.js";
import type { Agent } from "./Agents.js";

const TYPES = ["request", "question", "idea", "urgent", "fyi"] as const;

interface Candidate {
  agentId: string;
  name: string;
  score: number;
  skill: number;
  memory: number;
  success: number;
  load: number;
  cost: number;
}
interface Stamp {
  handledBy: string | null;
  handledByName: string | null;
  why: string;
  confidence: number;
  lowConfidence: boolean;
  candidates: Candidate[];
}
interface Letter {
  id: string;
  type: (typeof TYPES)[number];
  subject: string;
  body: string;
  from: { kind: string; agentId: string | null; userId: string | null };
  toAgentId: string | null;
  status: string;
  stamp: Stamp | null;
  replyToId: string | null;
  createdAt: string;
}

function StampCard({ stamp }: { stamp: Stamp }) {
  const { t } = useTranslation();
  return (
    <div className={`rounded-blob border-2 border-dashed p-3 text-sm ${stamp.lowConfidence ? "border-accent" : "border-line"}`}>
      <p className="font-bold">
        {t("letters.stamp")}: {stamp.handledByName ? t("letters.handledBy", { name: stamp.handledByName }) : t("letters.noHandler")}{" "}
        <span className="text-muted">({t("letters.confidence", { pct: Math.round(stamp.confidence * 100) })})</span>
      </p>
      <p>{stamp.why}</p>
      {stamp.candidates.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer underline">{t("letters.candidates")}</summary>
          <ul className="mt-1 text-xs text-muted">
            {stamp.candidates.map((c) => (
              <li key={c.agentId}>{t("letters.score", { ...c })}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Letters: write one, see the mail agent's stamp, follow replies, and place letters it could not. */
export function Letters() {
  const { t } = useTranslation();
  const [letters, setLetters] = useState<Letter[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [form, setForm] = useState({ type: "request" as Letter["type"], subject: "", body: "", toAgentId: "" });
  const [error, setError] = useState<string | null>(null);

  const load = async () => setLetters((await api<{ letters: Letter[] }>("GET", "/letters")).letters);
  useEffect(() => {
    void api<{ agents: Agent[] }>("GET", "/agents").then((r) => setAgents(r.agents));
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, []);

  const agent = (id: string | null) => agents.find((a) => a.id === id);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("POST", "/letters", { ...form, toAgentId: form.toAgentId || null });
      setForm({ ...form, subject: "", body: "" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("letters.failed"));
    }
  };
  const assign = async (letterId: string, agentId: string) => {
    await api("POST", `/letters/${letterId}/assign`, { agentId });
    await load();
  };
  const field = "rounded-blob border border-line bg-peach px-3 py-2 text-ink";
  const threads = letters.filter((l) => !l.replyToId);
  const repliesTo = (id: string) => letters.filter((l) => l.replyToId === id);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-2xl font-extrabold">{t("letters.title")}</h2>
        <p className="text-sm text-muted">{t("letters.intro")}</p>
      </div>
      <form onSubmit={send} className="flex flex-col gap-2 rounded-blob bg-panel p-4 shadow-soft">
        <h3 className="font-bold">{t("letters.write")}</h3>
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1 text-sm">
            {t("letters.type")}
            <select className={field} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Letter["type"] })}>
              {TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(`letters.types.${ty}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("letters.to")}
            <select className={field} value={form.toAgentId} onChange={(e) => setForm({ ...form, toAgentId: e.target.value })}>
              <option value="">{t("letters.anyone")}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            {t("letters.subject")}
            <input className={field} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </label>
        </div>
        <textarea className={`${field} min-h-24`} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} aria-label={t("letters.body")} placeholder={t("letters.body")} required />
        {error && (
          <p role="alert" className="text-accent">
            {error}
          </p>
        )}
        <button className="self-start rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft">{t("letters.send")}</button>
      </form>
      {threads.length === 0 && <PageState title={t("letters.empty")} description={t("ui.lettersEmptyHelp")} icon="letters" />}
      <ul className="flex flex-col gap-3">
        {threads.map((l) => {
          const from = agent(l.from.agentId);
          return (
            <li key={l.id} className="flex flex-col gap-2 rounded-blob bg-panel p-4 shadow-soft">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 font-bold">
                  <span className={`rounded-blob px-2 py-0.5 text-xs ${l.type === "urgent" ? "bg-accent text-cream" : "bg-sky"}`}>{t(`letters.types.${l.type}`)}</span>
                  {l.subject || l.body.slice(0, 60)}
                </p>
                <span className="text-xs text-muted">
                  {t("letters.from", { name: from?.name ?? t("letters.you") })} · {t(`letters.statuses.${l.status}`, { defaultValue: l.status })} · {new Date(l.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm">{l.body}</p>
              {l.stamp && <StampCard stamp={l.stamp} />}
              {l.status === "needs_human" && (
                <label className="flex items-center gap-2 text-sm">
                  {t("letters.assign")}
                  <select className={field} defaultValue="" onChange={(e) => e.target.value && void assign(l.id, e.target.value)}>
                    <option value="" disabled>
                      …
                    </option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {repliesTo(l.id).length > 0 && (
                <div className="flex flex-col gap-2 border-l-4 border-line pl-3">
                  <h4 className="text-sm font-bold">{t("letters.replies")}</h4>
                  {repliesTo(l.id).map((r) => {
                    const by = agent(r.from.agentId);
                    return (
                      <div key={r.id} className="flex gap-2">
                        {by && <AgentAvatar avatar={by.avatar} size={32} name={by.name} />}
                        <div>
                          <p className="text-xs text-muted">{t("letters.from", { name: by?.name ?? "?" })}</p>
                          <p className="whitespace-pre-wrap text-sm">{r.body}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
