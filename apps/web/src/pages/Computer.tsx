import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api.js";
import { AgentAvatar } from "../components/AgentAvatar.js";
import { Screen } from "../components/Screen.js";
import { Tasks } from "../components/Tasks.js";
import { Terminal } from "../components/Terminal.js";
import { useSession } from "../store/session.js";
import type { Agent } from "./Agents.js";

/** An agent's computer: its terminal and its browser, live, with hibernate and wake. */
export function Computer({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [state, setState] = useState<string>("running");

  useEffect(() => {
    const load = () => void api<Agent>("GET", `/agents/${agentId}`).then(setAgent);
    load();
    void api<{ state: string }>("GET", `/agents/${agentId}/computer`).then((r) => setState(r.state));
    // Keep the status (and its animation) live while a task runs.
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [agentId]);

  const toggleSleep = async () => {
    const op = state === "hibernated" ? "wake" : "hibernate";
    setState((await api<{ state: string }>("POST", `/agents/${agentId}/computer/${op}`)).state);
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="underline" onClick={() => go({ name: "agents" })}>
          {t("computer.back")}
        </button>
        <h2 className="flex items-center gap-3 text-2xl font-extrabold">
          {agent && <AgentAvatar avatar={agent.avatar} mood={agent.mood} name={agent.name} size={56} status={agent.status} />}
          {t("computer.title", { name: agent?.name ?? "…" })}
        </h2>
        <button type="button" onClick={toggleSleep} className="rounded-blob bg-lilac px-4 py-2 font-bold shadow-soft">
          {state === "hibernated" ? t("computer.wake") : t("computer.hibernate")}
        </button>
      </div>
      <p role="status">{t(`computer.state.${state}`)}</p>
      <Tasks agentId={agentId} agentName={agent?.name ?? ""} />
      {state === "running" && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* min-w-0: grid items otherwise grow to the terminal canvas width on small screens. */}
          <div className="min-w-0">
            <h3 className="mb-2 font-bold">{t("computer.terminal")}</h3>
            <Terminal agentId={agentId} label={t("computer.terminal")} />
          </div>
          <Screen agentId={agentId} />
        </div>
      )}
    </section>
  );
}
