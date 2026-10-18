import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { KillSwitch } from "./components/KillSwitch.js";
import { Agents } from "./pages/Agents.js";
import { Approvals } from "./pages/Approvals.js";
import { Computer } from "./pages/Computer.js";
import { Login } from "./pages/Login.js";
import { useHealth } from "./store/health.js";
import { useSession } from "./store/session.js";

export function App() {
  const { t } = useTranslation();
  const health = useHealth();
  const { me, loading, view, load, logout, go } = useSession();

  useEffect(() => {
    void health.check();
    void load();
  }, []);

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold">{t("app.title")}</h1>
          <p className="text-sm">{t("app.tagline")}</p>
        </div>
        <div className="flex items-center gap-3">
          <span role="status" data-testid="health-status" className="rounded-blob bg-mint px-3 py-1 text-sm shadow-soft">
            {t(`health.${health.status}`)}
          </span>
          {me && <KillSwitch />}
          {me && (
            <button type="button" className="underline" onClick={() => void logout()}>
              {t("auth.signOut")}
            </button>
          )}
        </div>
      </header>
      {me && (
        <nav className="flex gap-4" aria-label={t("nav.label")}>
          <button type="button" className={view.name === "approvals" ? "underline" : "font-bold underline"} onClick={() => go({ name: "agents" })}>
            {t("nav.agents")}
          </button>
          <button type="button" className={view.name === "approvals" ? "font-bold underline" : "underline"} onClick={() => go({ name: "approvals" })}>
            {t("nav.approvals")}
          </button>
        </nav>
      )}
      <main>
        {loading ? null : !me ? (
          <Login />
        ) : view.name === "computer" ? (
          <Computer agentId={view.agentId} />
        ) : view.name === "approvals" ? (
          <Approvals />
        ) : (
          <Agents />
        )}
      </main>
    </div>
  );
}
