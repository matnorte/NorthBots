import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Avatar } from "@northbot/shared";
import { api, ApiError } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { Icon } from "../components/Icon.js";
import { LoadingState, PageState } from "../components/PageState.js";
import { PermissionSlider, type Autonomy } from "../components/PermissionSlider.js";
import { useSession } from "../store/session.js";

export interface Agent {
  id: string;
  name: string;
  nameLocked: boolean;
  status: string;
  mood: string;
  avatar: Partial<Avatar>;
  budgetDailyUsd: number;
  autonomyLevel: Autonomy;
  sandboxId: string | null;
}

interface Mood {
  mood: string;
  cause: string;
  fix: string | null;
  detail: Record<string, string>;
}

function AgentCard({ agent, reload }: { agent: Agent; reload: () => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const go = useSession((s) => s.go);
  const [mood, setMood] = useState<Mood | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(agent.name);
  const [error, setError] = useState<string | null>(null);
  const budget = new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(agent.budgetDailyUsd);

  useEffect(() => {
    let mounted = true;
    void api<Mood>("GET", `/agents/${agent.id}/mood`)
      .then((m) => {
        if (mounted) setMood(m);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [agent.id, agent.mood]);

  const fix = async () => {
    setError(null);
    try {
      switch (mood?.fix) {
        case "open_approvals":
        case "review_rules":
        case "review_blocked_site":
          return go({ name: "approvals" });
        case "raise_budget": {
          const v = window.prompt(t("agents.newBudget"), String(agent.budgetDailyUsd * 2));
          if (v && Number.isFinite(Number(v)) && Number(v) > 0)
            await api("PATCH", `/agents/${agent.id}`, { budgetDailyUsd: Number(v) });
          return reload();
        }
        case "say_thanks":
          return void (await api("POST", `/agents/${agent.id}/cheer`, { how: "thanks" }));
        case "say_its_ok":
          return void (await api("POST", `/agents/${agent.id}/cheer`, { how: "its_ok" }));
        default:
          return go({ name: "computer", agentId: agent.id });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ui.failed"));
    }
  };

  const setLevel = async (autonomyLevel: Autonomy) => {
    setError(null);
    try {
      await api("PATCH", `/agents/${agent.id}`, { autonomyLevel });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("permissions.failed"));
    }
  };

  const rename = async () => {
    setError(null);
    try {
      await api("PATCH", `/agents/${agent.id}`, { name: name.trim() });
      setRenaming(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("agents.renameFailed"));
    }
  };

  return (
    <li className={`agent-card status-${agent.status}`} data-testid="agent-card">
      <div className="agent-card-top">
        <span className={`status-badge status-${agent.status}`}>
          <span />
          {t(`status.${agent.status}`, { defaultValue: agent.status })}
        </span>
        <button
          type="button"
          className="agent-rename"
          aria-label={`${t("agents.rename")} ${agent.name}`}
          onClick={() => {
            setName(agent.name);
            setRenaming(true);
          }}
        >
          {t("agents.rename")}
        </button>
      </div>
      <div className="agent-portrait">
        <AgentAvatar
          avatar={agent.avatar}
          mood={mood?.mood ?? agent.mood}
          name={agent.name}
          status={agent.status}
          size={112}
        />
      </div>
      <div className="agent-identity">
        {renaming ? (
          <form
            className="rename-form"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label={t("agents.rename")}
              minLength={2}
              maxLength={12}
              required
            />
            <button type="submit">{t("agents.save")}</button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("ui.cancel")}
              onClick={() => setRenaming(false)}
            >
              <Icon name="close" size={14} />
            </button>
          </form>
        ) : (
          <h3>{agent.name}</h3>
        )}
        <p>{t("ui.agentCompanion")}</p>
      </div>
      {mood && mood.mood !== "content" && (
        <div className="agent-mood">
          <span>
            <strong>{t(`moods.${mood.mood}`, { defaultValue: mood.mood })}</strong> · {mood.cause}
          </span>
          {mood.fix && (
            <button type="button" onClick={() => void fix()}>
              {t(`fixes.${mood.fix}`)}
              <Icon name="arrow" size={14} />
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-accent">
          {error}
        </p>
      )}
      <div className="agent-meta">
        <span>
          <Icon name="computer" size={14} />
          {t(agent.sandboxId ? "ui.computerReady" : "ui.noComputer")}
        </span>
        <span title={t("ui.dailyBudget")}>
          {budget}
          <small> / {t("ui.day")}</small>
        </span>
      </div>
      <PermissionSlider compact value={agent.autonomyLevel} onChange={(l) => void setLevel(l)} />
      <div className="agent-actions">
        <button
          type="button"
          className="agent-chat"
          onClick={() => go({ name: "chat", agentId: agent.id })}
        >
          <Icon name="rooms" size={16} />
          {t("agents.chat")}
          <Icon name="arrow" size={15} />
        </button>
        <button
          type="button"
          className="agent-computer"
          onClick={() => go({ name: "computer", agentId: agent.id })}
          title={t("agents.computer")}
        >
          <Icon name="computer" size={16} />
          <span>{t("agents.computer")}</span>
        </button>
      </div>
    </li>
  );
}

export function Agents() {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      setAgents((await api<{ agents: Agent[] }>("GET", "/agents")).agents);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (agents?.length === 0) go({ name: "hatch" });
  }, [agents, go]);

  if (!agents)
    return error ? (
      <PageState
        title={t("ui.failed")}
        description={t("ui.loadFailed")}
        action={{ label: t("ui.retry"), onClick: () => void load() }}
      />
    ) : (
      <LoadingState />
    );
  if (agents.length === 0) return null;
  const active = agents.filter((a) => a.status === "working").length;
  const attention = agents.filter((a) => ["blocked", "waiting"].includes(a.status)).length;
  const resting = agents.filter((a) => ["resting", "idle"].includes(a.status)).length;
  const visible = agents.filter(
    (a) =>
      a.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()) &&
      (filter === "all" ||
        (filter === "attention"
          ? ["blocked", "waiting"].includes(a.status)
          : filter === "ready"
            ? ["resting", "idle"].includes(a.status)
            : a.status === filter)),
  );

  return (
    <section className="agents-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t("ui.yourTeam")}</p>
          <h2>
            {t("agents.title")}
            <span className="heading-count">{agents.length}</span>
          </h2>
          <p className="page-description">{t("ui.agentsIntro")}</p>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => go({ name: "hatch_short" })}
        >
          <Icon name="plus" size={17} />
          {t("agents.hatchAnother")}
        </button>
      </div>
      <div className="overview-stats">
        {[
          { key: "all", label: "totalAgents", value: agents.length, icon: "agents" as const },
          { key: "working", label: "atWork", value: active, icon: "spark" as const },
          { key: "attention", label: "needsYou", value: attention, icon: "approvals" as const },
          { key: "ready", label: "ready", value: resting, icon: "clock" as const },
        ].map((s) => (
          <button
            type="button"
            key={s.key}
            className={`stat-card stat-${s.key} ${filter === s.key ? "is-selected" : ""}`}
            aria-pressed={filter === s.key}
            onClick={() => setFilter(s.key)}
          >
            <span className="stat-heading">
              {t(`ui.${s.label}`)}
              <Icon name={s.icon} size={17} />
            </span>
            <strong>{s.value.toString().padStart(2, "0")}</strong>
            <span className="stat-footnote">
              <span className="stat-dot" />
              {t(`ui.stat_${s.key}`)}
            </span>
          </button>
        ))}
      </div>
      {attention > 0 && (
        <div className="attention-banner">
          <span className="attention-icon">
            <Icon name="approvals" size={18} />
          </span>
          <div>
            <strong>{t("ui.attentionTitle", { count: attention })}</strong>
            <p>{t("ui.attentionBody")}</p>
          </div>
          <button type="button" onClick={() => go({ name: "approvals" })}>
            {t("ui.reviewApprovals")}
            <Icon name="arrow" size={16} />
          </button>
        </div>
      )}
      <div className="agents-toolbar">
        <div className="filter-tabs" role="group" aria-label={t("ui.filterStatus")}>
          {["all", "working", "attention", "ready"].map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {t(`ui.filter_${key}`)}
            </button>
          ))}
        </div>
        <div className="agents-tools">
          <label className="search-field">
            <Icon name="search" size={16} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("ui.searchAgents")}
              aria-label={t("ui.searchAgents")}
            />
          </label>
          <div className="layout-toggle" role="group" aria-label={t("ui.layout")}>
            {(["grid", "list"] as const).map((l) => (
              <button
                type="button"
                key={l}
                aria-pressed={layout === l}
                aria-label={t(`ui.${l}`)}
                onClick={() => setLayout(l)}
              >
                <Icon name={l} size={16} />
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="result-count" aria-live="polite">
        {t("ui.showingAgents", { count: visible.length, total: agents.length })}
      </p>
      {error && (
        <p role="alert" className="text-sm text-accent">
          {t("ui.refreshFailed")}
        </p>
      )}
      {visible.length ? (
        <ul className={`agents-grid ${layout === "list" ? "agents-list" : ""}`}>
          {visible.map((a) => (
            <AgentCard key={a.id} agent={a} reload={load} />
          ))}
        </ul>
      ) : (
        <PageState
          title={t("ui.noMatches")}
          description={t("ui.noMatchesHelp")}
          icon="search"
          action={{
            label: t("ui.clearFilters"),
            onClick: () => {
              setQuery("");
              setFilter("all");
            },
          }}
        />
      )}
      <button type="button" className="office-invitation" onClick={() => go({ name: "office" })}>
        <span className="office-invitation-icon">
          <Icon name="office" size={23} />
        </span>
        <span>
          <strong>{t("ui.visitOffice")}</strong>
          <small>{t("ui.officeInvite")}</small>
        </span>
        <span className="office-invitation-link">
          {t("ui.openOffice")}
          <Icon name="arrow" size={17} />
        </span>
      </button>
    </section>
  );
}
