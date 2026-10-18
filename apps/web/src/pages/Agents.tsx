import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Avatar } from "@northbot/shared";
import { api, ApiError } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { useSession } from "../store/session.js";

export interface Agent {
  id: string;
  name: string;
  nameLocked: boolean;
  status: string;
  mood: string;
  avatar: Partial<Avatar>;
  budgetDailyUsd: number;
  sandboxId: string | null;
}

interface Mood {
  mood: string;
  cause: string;
  fix: string | null;
  detail: Record<string, string>;
}

function AgentCard({ agent, reload }: { agent: Agent; reload: () => Promise<void> }) {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [mood, setMood] = useState<Mood | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(agent.name);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<Mood>("GET", `/agents/${agent.id}/mood`).then(setMood);
  }, [agent.id, agent.mood]);

  const fix = async () => {
    switch (mood?.fix) {
      case "open_approvals":
      case "review_rules":
      case "review_blocked_site":
        return go({ name: "approvals" });
      case "raise_budget": {
        const v = window.prompt(t("agents.newBudget"), String(agent.budgetDailyUsd * 2));
        if (v && Number(v) > 0) await api("PATCH", `/agents/${agent.id}`, { budgetDailyUsd: Number(v) });
        return reload();
      }
      case "say_thanks":
        return void (await api("POST", `/agents/${agent.id}/cheer`, { how: "thanks" }));
      case "say_its_ok":
        return void (await api("POST", `/agents/${agent.id}/cheer`, { how: "its_ok" }));
      default:
        return go({ name: "computer", agentId: agent.id });
    }
  };

  const rename = async () => {
    setError(null);
    try {
      await api("PATCH", `/agents/${agent.id}`, { name });
      setRenaming(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("agents.renameFailed"));
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-blob bg-white/80 p-4 shadow-soft dark:bg-white/10" data-testid="agent-card">
      <div className="flex items-center gap-3">
        <AgentAvatar avatar={agent.avatar} mood={mood?.mood ?? agent.mood} name={agent.name} />
        <div className="flex-1">
          {renaming ? (
            <div className="flex gap-2">
              <input className="w-28 rounded-blob border border-lilac px-2 py-1 text-ink" value={name} onChange={(e) => setName(e.target.value)} aria-label={t("agents.rename")} />
              <button type="button" className="underline" onClick={() => void rename()}>
                {t("agents.save")}
              </button>
            </div>
          ) : (
            <p className="text-lg font-bold">
              {agent.name}{" "}
              <button type="button" className="text-sm font-normal underline" onClick={() => setRenaming(true)}>
                {t("agents.rename")}
              </button>
            </p>
          )}
          <p className="text-sm">{t(`status.${agent.status}`, { defaultValue: agent.status })}</p>
          {error && <p role="alert" className="text-sm text-accent">{error}</p>}
        </div>
      </div>
      {mood && mood.mood !== "content" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-blob bg-cream px-3 py-2 text-sm text-ink">
          <span>
            <strong>{t(`moods.${mood.mood}`, { defaultValue: mood.mood })}:</strong> {mood.cause}
          </span>
          {mood.fix && (
            <button type="button" className="rounded-blob bg-peach px-3 py-1 font-bold" onClick={() => void fix()}>
              {t(`fixes.${mood.fix}`)}
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2 text-sm">
        <button type="button" className="rounded-blob bg-mint px-3 py-1 font-bold" onClick={() => go({ name: "chat", agentId: agent.id })}>
          {t("agents.chat")}
        </button>
        <button type="button" className="rounded-blob bg-sky px-3 py-1 font-bold" onClick={() => go({ name: "computer", agentId: agent.id })}>
          {t("agents.computer")}
        </button>
      </div>
    </li>
  );
}

export function Agents() {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [agents, setAgents] = useState<Agent[] | null>(null);

  const load = async () => setAgents((await api<{ agents: Agent[] }>("GET", "/agents")).agents);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  // First run: nobody here yet, so start hatching.
  useEffect(() => {
    if (agents?.length === 0) go({ name: "hatch" });
  }, [agents, go]);

  if (!agents || agents.length === 0) return null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-extrabold">{t("agents.title")}</h2>
        <button type="button" className="rounded-blob bg-accent px-4 py-2 font-bold text-white shadow-soft" onClick={() => go({ name: "hatch_short" })}>
          {t("agents.hatchAnother")}
        </button>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {agents.map((a) => (
          <AgentCard key={a.id} agent={a} reload={load} />
        ))}
      </ul>
    </section>
  );
}
