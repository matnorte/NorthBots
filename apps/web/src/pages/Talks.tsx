import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Avatar } from "@northbot/shared";
import { api, ApiError } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { useSession } from "../store/session.js";
import type { Agent } from "./Agents.js";
import { AgentChips, MessageList, type RoomMessage } from "./Rooms.js";

const STAGES = ["brief", "prepare", "present", "qa", "challenge", "decide", "record", "learn", "done"] as const;

interface Talk {
  id: string;
  roomId: string;
  title: string;
  question: string;
  presenterAgentId: string;
  dissenterAgentId: string | null;
  audience: string[];
  decisionMode: string;
  budgetUsd: number;
  spentUsd: number;
  stage: string;
  deck: { slides: { title: string; bullets: string[]; notes: string }[]; evidence: { claim: string; source: string }[]; recommendation: string } | null;
  qa: { id: string; from: string; question: string; answer: string | null }[];
  challenge: { objection: string; rebuttal: string } | null;
  votes: { agentId: string; name: string; vote: string; why: string }[];
  decision: { decision: string; rationale: string; tally: { yes: number; no: number; abstain: number }; decidedBy: string; dissent: string | null; outcome: string } | null;
  error: string | null;
}
interface RoomBits {
  members: { agentId: string; name: string; role: string; avatar: Partial<Avatar>; status: string }[];
  messages: RoomMessage[];
}

function StageBar({ stage }: { stage: string }) {
  const { t } = useTranslation();
  const at = STAGES.indexOf(stage as (typeof STAGES)[number]);
  return (
    <ol className="flex flex-wrap gap-1 text-xs" aria-label={t("talks.stages.brief")}>
      {STAGES.map((s, i) => (
        <li
          key={s}
          aria-current={s === stage ? "step" : undefined}
          className={`rounded-blob px-2 py-1 ${s === stage ? "bg-rainbow font-bold" : i < at || stage === "done" ? "bg-lilac" : "bg-peach text-muted"}`}
        >
          {t(`talks.stages.${s}`)}
        </li>
      ))}
      {stage === "stopped" && <li className="rounded-blob bg-accent px-2 py-1 font-bold text-cream">{t("talks.stages.stopped")}</li>}
    </ol>
  );
}

export function TalkView({ talkId }: { talkId: string }) {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [talk, setTalk] = useState<Talk | null>(null);
  const [room, setRoom] = useState<RoomBits | null>(null);
  const [question, setQuestion] = useState("");
  const [decision, setDecision] = useState({ decision: "", rationale: "" });
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const tk = await api<Talk>("GET", `/talks/${talkId}`);
    setTalk(tk);
    setRoom(await api<RoomBits>("GET", `/rooms/${tk.roomId}`));
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [talkId]);
  if (!talk || !room) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("talks.failed"));
    }
  };
  const ask = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api("POST", `/talks/${talkId}/questions`, { question });
      setQuestion("");
    });
  };
  const decide = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api("POST", `/talks/${talkId}/decide`, decision));
  };
  const member = (id: string | null) => room.members.find((m) => m.agentId === id);
  const presenter = member(talk.presenterAgentId);

  return (
    <section className="flex flex-col gap-4">
      <button type="button" className="self-start underline" onClick={() => go({ name: "talks" })}>
        {t("talks.back")}
      </button>
      <div className="flex flex-wrap items-center gap-3">
        {presenter && <AgentAvatar avatar={presenter.avatar} size={56} name={presenter.name} status={presenter.status} />}
        <div>
          <h2 className="text-2xl font-extrabold">{talk.title}</h2>
          <p>{talk.question}</p>
          <p className="text-xs text-muted">{t("talks.spent", { spent: talk.spentUsd.toFixed(2), budget: talk.budgetUsd.toFixed(2) })}</p>
        </div>
      </div>
      <StageBar stage={talk.stage} />
      {talk.error && <p className="text-accent">{talk.error}</p>}
      {talk.decision && (
        <article className="rainbow-border flex flex-col gap-1 rounded-blob bg-panel p-4 shadow-soft" aria-label={t("talks.decision")}>
          <h3 className="text-rainbow font-extrabold">{t("talks.decision")}</h3>
          <p className="text-lg font-bold">{talk.decision.decision}</p>
          <p className="text-sm">{talk.decision.rationale}</p>
          <p className="text-xs text-muted">
            {t("talks.tally", talk.decision.tally)} · {t("talks.decidedBy", { who: talk.decision.decidedBy === "vote" ? t("talks.modes.vote") : t("talks.modes.human") })}
          </p>
        </article>
      )}
      {talk.stage === "decide" && talk.decisionMode === "human" && (
        <form onSubmit={decide} className="flex flex-col gap-2 rounded-blob bg-panel p-4 shadow-soft">
          <h3 className="font-bold">{t("talks.decideTitle")}</h3>
          <input className="rounded-blob border border-line bg-peach px-3 py-2 text-ink" value={decision.decision} onChange={(e) => setDecision({ ...decision, decision: e.target.value })} placeholder={t("talks.decisionLabel")} aria-label={t("talks.decisionLabel")} required />
          <textarea className="rounded-blob border border-line bg-peach px-3 py-2 text-ink" value={decision.rationale} onChange={(e) => setDecision({ ...decision, rationale: e.target.value })} placeholder={t("talks.rationale")} aria-label={t("talks.rationale")} required />
          <button className="self-start rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft">{t("talks.decide")}</button>
        </form>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          {talk.deck && (
            <div className="flex flex-col gap-2">
              <h3 className="font-bold">{t("talks.deck")}</h3>
              <ol className="flex flex-col gap-2">
                {talk.deck.slides.map((s, i) => (
                  <li key={i} className="rounded-blob bg-panel p-3 shadow-soft">
                    <p className="font-bold">
                      {i + 1}. {s.title}
                    </p>
                    <ul className="list-disc pl-5 text-sm">
                      {s.bullets.map((b, j) => (
                        <li key={j}>{b}</li>
                      ))}
                    </ul>
                    {s.notes && <p className="mt-1 text-xs text-muted">{s.notes}</p>}
                  </li>
                ))}
              </ol>
              {talk.deck.evidence.length > 0 && (
                <div>
                  <h4 className="text-sm font-bold">{t("talks.evidence")}</h4>
                  <ul className="text-sm">
                    {talk.deck.evidence.map((e, i) => (
                      <li key={i}>
                        {e.claim} <span className="text-muted">({e.source})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {talk.challenge && (
            <div className="rounded-blob bg-panel p-3 text-sm shadow-soft">
              <h3 className="font-bold">{t("talks.challenge")}</h3>
              <p>
                <strong>{member(talk.dissenterAgentId)?.name}:</strong> {talk.challenge.objection}
              </p>
              <p className="mt-1">
                <strong>{t("talks.rebuttal")}:</strong> {talk.challenge.rebuttal}
              </p>
            </div>
          )}
          {talk.votes.length > 0 && (
            <div className="text-sm">
              <h3 className="font-bold">{t("talks.votes")}</h3>
              <ul>
                {talk.votes.map((v) => (
                  <li key={v.agentId}>
                    <strong>{v.name}</strong>: {v.vote}
                    {v.why && <span className="text-muted"> — {v.why}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {["brief", "prepare", "present", "qa"].includes(talk.stage) && (
            <form onSubmit={ask} className="flex gap-2">
              <input className="flex-1 rounded-blob border border-line bg-peach px-3 py-2 text-ink" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t("talks.askPlaceholder")} aria-label={t("talks.askPlaceholder")} required minLength={3} />
              <button className="rounded-blob bg-sky px-4 py-2 font-bold shadow-soft">{t("talks.ask")}</button>
            </form>
          )}
          {error && (
            <p role="alert" className="text-accent">
              {error}
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <button type="button" className="self-start text-sm underline" onClick={() => go({ name: "room", roomId: talk.roomId })}>
            {t("talks.room")}
          </button>
          <MessageList messages={room.messages} members={room.members} />
        </div>
      </div>
    </section>
  );
}

/** Talks: list and start one. */
export function Talks() {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [talks, setTalks] = useState<Talk[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [form, setForm] = useState({ title: "", question: "", presenterAgentId: "", audience: [] as string[], dissenterAgentId: "", decisionMode: "vote", budgetUsd: 1 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ talks: Talk[] }>("GET", "/talks").then((r) => setTalks(r.talks));
    void api<{ agents: Agent[] }>("GET", "/agents").then((r) => {
      setAgents(r.agents);
      setForm((f) => ({ ...f, presenterAgentId: f.presenterAgentId || (r.agents[0]?.id ?? "") }));
    });
  }, []);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const talk = await api<Talk>("POST", "/talks", {
        ...form,
        audience: form.audience.filter((a) => a !== form.presenterAgentId),
        dissenterAgentId: form.dissenterAgentId || null,
      });
      go({ name: "talk", talkId: talk.id });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("talks.failed"));
    }
  };
  const field = "rounded-blob border border-line bg-peach px-3 py-2 text-ink";
  const listeners = agents.filter((a) => a.id !== form.presenterAgentId);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-2xl font-extrabold">{t("talks.title")}</h2>
        <p className="text-sm text-muted">{t("talks.intro")}</p>
      </div>
      {talks.length === 0 && <p className="rounded-blob bg-mint p-4">{t("talks.empty")}</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {talks.map((tk) => (
          <li key={tk.id}>
            <button type="button" className="flex w-full flex-col gap-1 rounded-blob bg-panel p-4 text-left shadow-soft hover:bg-peach" onClick={() => go({ name: "talk", talkId: tk.id })}>
              <span className="font-extrabold">{tk.title}</span>
              <span className="text-sm">{tk.question}</span>
              <span className="text-xs text-muted">{t(`talks.stages.${tk.stage}`, { defaultValue: tk.stage })}</span>
              {tk.decision && <span className="text-rainbow text-sm font-bold">{tk.decision.decision}</span>}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={start} className="flex flex-col gap-3 rounded-blob bg-panel p-4 shadow-soft">
        <h3 className="font-bold">{t("talks.new")}</h3>
        <input className={field} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t("talks.talkTitle")} aria-label={t("talks.talkTitle")} required minLength={2} />
        <input className={field} value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} placeholder={t("talks.question")} aria-label={t("talks.question")} required minLength={3} />
        <label className="flex flex-col gap-1 text-sm">
          {t("talks.presenter")}
          <select className={field} value={form.presenterAgentId} onChange={(e) => setForm({ ...form, presenterAgentId: e.target.value })}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <AgentChips agents={listeners} selected={form.audience} onChange={(audience) => setForm({ ...form, audience })} label={t("talks.audience")} />
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {t("talks.dissenter")}
            <select className={field} value={form.dissenterAgentId} onChange={(e) => setForm({ ...form, dissenterAgentId: e.target.value })}>
              <option value="">{t("talks.auto")}</option>
              {listeners
                .filter((a) => form.audience.includes(a.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("talks.mode")}
            <select className={field} value={form.decisionMode} onChange={(e) => setForm({ ...form, decisionMode: e.target.value })}>
              <option value="vote">{t("talks.modes.vote")}</option>
              <option value="human">{t("talks.modes.human")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("talks.budget")}
            <input type="number" min={0} step={0.1} className={`${field} w-28`} value={form.budgetUsd} onChange={(e) => setForm({ ...form, budgetUsd: Number(e.target.value) })} />
          </label>
        </div>
        {error && (
          <p role="alert" className="text-accent">
            {error}
          </p>
        )}
        <button className="self-start rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft" disabled={form.audience.length === 0}>
          {t("talks.start")}
        </button>
      </form>
    </section>
  );
}
