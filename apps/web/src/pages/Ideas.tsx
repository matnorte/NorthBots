import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { PageState } from "../components/PageState.js";
import type { Agent } from "./Agents.js";

type Status = "binned" | "restored" | "expired";
type TriggerKind = "none" | "after" | "memory" | "event";

interface Idea {
  id: string;
  agentId: string | null;
  title: string;
  reason: string;
  triggerText: string | null;
  status: Status;
  tossedAt: string;
  expiresAt: string;
  restoredBy: string | null;
  restoreNote: string | null;
}

/** The idea bin: what agents (and people) set aside, what came back, and what expired. */
export function Ideas() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>("binned");
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [form, setForm] = useState({ title: "", reason: "", kind: "none" as TriggerKind, at: "", text: "", type: "" });
  const [note, setNote] = useState<string | null>(null);

  const load = async (s = status) => setIdeas((await api<{ ideas: Idea[] }>("GET", `/ideas?status=${s}`)).ideas);
  useEffect(() => {
    void api<{ agents: Agent[] }>("GET", "/agents").then((r) => setAgents(r.agents));
  }, []);
  useEffect(() => {
    void load(status);
  }, [status]);

  const trigger = () => {
    if (form.kind === "after" && form.at) return { kind: "after", at: new Date(form.at).toISOString() };
    if (form.kind === "memory" && form.text) return { kind: "memory", text: form.text };
    if (form.kind === "event" && form.type) return { kind: "event", type: form.type };
    return null;
  };
  const toss = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("POST", "/ideas", { title: form.title, reason: form.reason, trigger: trigger() });
      setForm({ ...form, title: "", reason: "", text: "", type: "", at: "" });
      setNote(null);
      await load();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : t("ideas.failed"));
    }
  };
  const restore = async (id: string) => {
    await api("POST", `/ideas/${id}/restore`, {});
    await load();
  };
  const pick = async () => {
    const r = await api<{ restored: string[]; expired: number }>("POST", "/ideas/pick");
    setNote(t("ideas.picked", { count: r.restored.length, expired: r.expired }));
    await load();
  };
  const field = "rounded-blob border border-line bg-peach px-3 py-2 text-ink";

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-extrabold">{t("ideas.title")}</h2>
          <p className="text-sm text-muted">{t("ideas.intro")}</p>
        </div>
        <button type="button" className="rounded-blob bg-sky px-4 py-2 font-bold shadow-soft" onClick={() => void pick()}>
          {t("ideas.pick")}
        </button>
      </div>
      {note && (
        <p role="status" className="rounded-blob bg-mint p-3 text-sm">
          {note}
        </p>
      )}
      <div className="flex gap-2" role="tablist">
        {(["binned", "restored", "expired"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={status === s} className={`rounded-blob px-3 py-1 text-sm shadow-soft ${status === s ? "bg-rainbow font-bold" : "bg-peach"}`} onClick={() => setStatus(s)}>
            {t(`ideas.filters.${s}`)}
          </button>
        ))}
      </div>
      {ideas.length === 0 && <PageState title={t("ideas.empty")} description={t("ui.ideasEmptyHelp")} icon="ideas" />}
      <ul className="grid gap-3 sm:grid-cols-2">
        {ideas.map((i) => {
          const agent = agents.find((a) => a.id === i.agentId);
          return (
            <li key={i.id} className="flex flex-col gap-2 rounded-blob bg-panel p-4 shadow-soft">
              <div className="flex items-center gap-2">
                {agent && <AgentAvatar avatar={agent.avatar} size={32} name={agent.name} />}
                <p className="font-extrabold">{i.title}</p>
              </div>
              {i.reason && <p className="text-sm">{i.reason}</p>}
              <p className="text-xs text-muted">
                {agent && `${t("ideas.by", { name: agent.name })} · `}
                {i.triggerText && `${i.triggerText} · `}
                {i.status === "binned" && t("ideas.expires", { date: new Date(i.expiresAt).toLocaleDateString() })}
                {i.status === "restored" && t("ideas.restoredBy", { who: i.restoredBy === "bin-picker" ? t("ideas.binPicker") : t("ideas.aPerson") })}
              </p>
              {i.restoreNote && <p className="text-sm text-emerald-300">{i.restoreNote}</p>}
              {i.status === "binned" && (
                <button type="button" className="self-start rounded-blob bg-lilac px-3 py-1 text-sm font-bold shadow-soft" onClick={() => void restore(i.id)}>
                  {t("ideas.restore")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <form onSubmit={toss} className="flex flex-col gap-2 rounded-blob bg-panel p-4 shadow-soft">
        <h3 className="font-bold">{t("ideas.toss")}</h3>
        <input className={field} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t("ideas.ideaTitle")} aria-label={t("ideas.ideaTitle")} required minLength={2} />
        <input className={field} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder={t("ideas.reason")} aria-label={t("ideas.reason")} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            {t("ideas.trigger")}
            <select className={field} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as TriggerKind })}>
              {(["none", "after", "memory", "event"] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`ideas.triggers.${k}`)}
                </option>
              ))}
            </select>
          </label>
          {form.kind === "after" && <input type="date" className={field} value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} aria-label={t("ideas.triggerAt")} required />}
          {form.kind === "memory" && <input className={`${field} flex-1`} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder={t("ideas.triggerText")} aria-label={t("ideas.triggerText")} required minLength={3} />}
          {form.kind === "event" && <input className={`${field} flex-1`} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} placeholder="skill.approved" aria-label={t("ideas.triggerType")} required minLength={3} />}
        </div>
        <button className="self-start rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft">{t("ideas.toss")}</button>
      </form>
    </section>
  );
}
