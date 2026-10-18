import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";
import { PageState } from "../components/PageState.js";
import type { Agent } from "./Agents.js";

interface Fact {
  id: string;
  agentId: string | null;
  text: string;
  source: string | null;
  derivedFrom: string[];
  createdAt: string;
  expiresAt: string | null;
  score?: number;
}

/** "all", "shared", or an agent id. */
type Who = string;

function FactCard({ fact, agentName, reload, say }: { fact: Fact; agentName: string | null; reload: () => Promise<void>; say: (msg: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.text);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("PATCH", `/memory/${fact.id}`, { text });
      setEditing(false);
      await reload();
    } catch {
      say(t("memory.failed"));
    }
  };

  const forget = async () => {
    if (!window.confirm(t("memory.forgetConfirm"))) return;
    const r = await api<{ forgotten: string[] }>("DELETE", `/memory/${fact.id}`);
    say(t("memory.forgotten", { count: r.forgotten.length }));
    await reload();
  };

  return (
    <li className="flex flex-col gap-2 rounded-blob bg-panel p-4 shadow-soft">
      {editing ? (
        <form onSubmit={save} className="flex flex-col gap-2">
          <textarea
            className="min-h-20 rounded-blob border border-line bg-peach px-3 py-2 text-ink"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={t("memory.edit")}
            required
            minLength={2}
          />
          <div className="flex gap-2">
            <button className="rounded-blob bg-rainbow px-4 py-1 font-bold shadow-soft">{t("memory.save")}</button>
            <button type="button" className="underline" onClick={() => (setEditing(false), setText(fact.text))}>
              {t("memory.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <p className="break-words">{fact.text}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="rounded-blob bg-peach px-2 py-0.5">{agentName ? t("memory.private", { name: agentName }) : t("memory.shared")}</span>
        {fact.source && <span>{t("memory.from", { source: fact.source })}</span>}
        <span>{new Date(fact.createdAt).toLocaleString()}</span>
        {fact.expiresAt && <span>{t("memory.expires", { date: new Date(fact.expiresAt).toLocaleDateString() })}</span>}
        {fact.score !== undefined && <span className="text-rainbow font-bold">{t("memory.match", { pct: Math.round(fact.score * 100) })}</span>}
      </div>
      {!editing && (
        <div className="flex gap-3 text-sm">
          <button type="button" className="underline" onClick={() => setEditing(true)}>
            {t("memory.edit")}
          </button>
          <button type="button" className="text-accent underline" onClick={() => void forget()}>
            {t("memory.forget")}
          </button>
        </div>
      )}
    </li>
  );
}

/** Memory: browse or search what agents remember, add, edit, forget, export and import. */
export function Memory() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [who, setWho] = useState<Who>("all");
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const names = new Map(agents.map((a) => [a.id, a.name]));

  const load = async (q = searched, w = who) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (w === "shared") params.set("scope", "shared");
    else if (w !== "all") params.set("agentId", w);
    const qs = params.toString();
    setFacts((await api<{ facts: Fact[] }>("GET", `/memory${qs ? `?${qs}` : ""}`)).facts);
  };

  useEffect(() => {
    void api<{ agents: Agent[] }>("GET", "/agents").then((r) => setAgents(r.agents));
  }, []);
  useEffect(() => {
    void load();
  }, [who, searched]);

  const search = (e: FormEvent) => {
    e.preventDefault();
    setSearched(query.trim());
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("POST", "/memory", { text, agentId: who === "all" || who === "shared" ? null : who });
      setText("");
      await load();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : t("memory.failed"));
    }
  };

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/memory/import", { method: "POST", credentials: "same-origin", body: form });
    const body = (await res.json()) as { count?: number; format?: string; message?: string };
    setNote(res.ok ? t("memory.imported", { count: body.count, format: body.format }) : (body.message ?? t("memory.importFailed")));
    await load();
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-extrabold">{t("memory.title")}</h2>
          <p className="text-sm text-muted">{t("memory.intro")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/api/memory/export" download className="rounded-blob bg-sky px-4 py-2 font-bold shadow-soft">
            {t("memory.export")}
          </a>
          <label className="cursor-pointer rounded-blob bg-lilac px-4 py-2 font-bold shadow-soft">
            {t("memory.import")}
            <input type="file" accept=".zip,.json,.txt,.md" className="sr-only" onChange={(e) => void upload(e)} />
          </label>
        </div>
      </div>
      {note && (
        <p role="status" className="rounded-blob bg-mint p-3 text-sm">
          {note}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="flex items-center gap-2 text-sm">
          {t("memory.who")}
          <select className="rounded-blob border border-line bg-peach px-3 py-2 text-ink" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="all">{t("memory.allMemories")}</option>
            <option value="shared">{t("memory.everyone")}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <form onSubmit={search} className="flex flex-1 gap-2" role="search">
          <input
            className="flex-1 rounded-blob border border-line bg-peach px-3 py-2 text-ink"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("memory.search")}
            aria-label={t("memory.search")}
          />
          <button className="rounded-blob bg-sky px-4 py-2 font-bold shadow-soft">{t("memory.searchButton")}</button>
          {searched && (
            <button type="button" className="underline" onClick={() => (setQuery(""), setSearched(""))}>
              {t("memory.clear")}
            </button>
          )}
        </form>
      </div>
      <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row">
        <input
          className="flex-1 rounded-blob border border-line bg-peach px-3 py-2 text-ink"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("memory.addPlaceholder")}
          aria-label={t("memory.addPlaceholder")}
          required
          minLength={2}
        />
        <button className="rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft">{t("memory.add")}</button>
      </form>
      {facts.length === 0 && <PageState title={t("memory.empty")} description={t("ui.memoryEmptyHelp")} icon="memory" />}
      <ul className="flex flex-col gap-3">
        {facts.map((f) => (
          <FactCard key={`${f.id}:${f.text}`} fact={f} agentName={f.agentId ? (names.get(f.agentId) ?? "?") : null} reload={() => load()} say={setNote} />
        ))}
      </ul>
    </section>
  );
}
