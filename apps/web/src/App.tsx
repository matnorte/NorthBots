import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { KillSwitch } from "./components/KillSwitch.js";
import { Notifications } from "./components/Notifications.js";
import { Agents } from "./pages/Agents.js";
import { Approvals } from "./pages/Approvals.js";
import { Chat } from "./pages/Chat.js";
import { Computer } from "./pages/Computer.js";
import { Hatch } from "./pages/Hatch.js";
import { Login } from "./pages/Login.js";
import { Memory } from "./pages/Memory.js";
import { QuickCreate } from "./pages/QuickCreate.js";
import { Settings } from "./pages/Settings.js";
import { Skills } from "./pages/Skills.js";
import { useHealth } from "./store/health.js";
import { useSession, type View } from "./store/session.js";

function Page({ view }: { view: View }) {
  switch (view.name) {
    case "computer":
      return <Computer agentId={view.agentId} />;
    case "chat":
      return <Chat agentId={view.agentId} />;
    case "approvals":
      return <Approvals />;
    case "memory":
      return <Memory />;
    case "skills":
      return <Skills />;
    case "hatch":
      return <Hatch />;
    case "hatch_short":
      return <Hatch short />;
    case "quick":
      return <QuickCreate />;
    case "settings":
      return <Settings />;
    default:
      return <Agents />;
  }
}

export function App() {
  const { t } = useTranslation();
  const health = useHealth();
  const { me, loading, view, load, logout, go } = useSession();

  useEffect(() => {
    void health.check();
    void load();
  }, []);

  const tab = (name: "agents" | "approvals" | "memory" | "skills" | "settings") => (
    <button
      type="button"
      aria-current={view.name === name ? "page" : undefined}
      className={view.name === name ? "text-rainbow font-extrabold" : "text-muted underline hover:text-ink"}
      onClick={() => go({ name })}
    >
      {t(`nav.${name}`)}
    </button>
  );

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-rainbow text-3xl font-extrabold">{t("app.title")}</h1>
          <p className="text-sm">{t("app.tagline")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span role="status" data-testid="health-status" className="rounded-blob bg-mint px-3 py-1 text-sm shadow-soft">
            {t(`health.${health.status}`)}
          </span>
          {me && <Notifications />}
          {me && <KillSwitch />}
          {me && (
            <button type="button" className="underline" onClick={() => void logout()}>
              {t("auth.signOut")}
            </button>
          )}
        </div>
      </header>
      <div className="rainbow-bar" aria-hidden="true" />
      {me && (
        <nav className="flex flex-wrap gap-4" aria-label={t("nav.label")}>
          {tab("agents")}
          {tab("approvals")}
          {tab("memory")}
          {tab("skills")}
          {tab("settings")}
        </nav>
      )}
      <main>{loading ? null : !me ? <Login /> : <Page view={view} />}</main>
    </div>
  );
}
