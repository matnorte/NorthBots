import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { KillSwitch } from "./components/KillSwitch.js";
import { Notifications } from "./components/Notifications.js";
import { Icon } from "./components/Icon.js";
import { LoadingState, PageState } from "./components/PageState.js";
import { Agents } from "./pages/Agents.js";
import { Approvals } from "./pages/Approvals.js";
import { Chat } from "./pages/Chat.js";
import { Hatch } from "./pages/Hatch.js";
import { Ideas } from "./pages/Ideas.js";
import { Letters } from "./pages/Letters.js";
import { Login } from "./pages/Login.js";
import { Memory } from "./pages/Memory.js";
import { QuickCreate } from "./pages/QuickCreate.js";
import { Room, Rooms } from "./pages/Rooms.js";
import { Settings } from "./pages/Settings.js";
import { Skills } from "./pages/Skills.js";
import { TalkView, Talks } from "./pages/Talks.js";
import { useHealth } from "./store/health.js";
import { useSession, type View } from "./store/session.js";

const Office = lazy(() => import("./pages/Office.js").then((m) => ({ default: m.Office })));
const Computer = lazy(() => import("./pages/Computer.js").then((m) => ({ default: m.Computer })));
const NAV = [
  "agents",
  "office",
  "approvals",
  "rooms",
  "letters",
  "talks",
  "ideas",
  "memory",
  "skills",
  "settings",
] as const;
type Tab = (typeof NAV)[number];

function Page({ view }: { view: View }) {
  switch (view.name) {
    case "computer":
      return (
        <Suspense fallback={<LoadingState />}>
          <Computer key={view.agentId} agentId={view.agentId} />
        </Suspense>
      );
    case "chat":
      return <Chat key={view.agentId} agentId={view.agentId} />;
    case "approvals":
      return <Approvals />;
    case "office":
      return (
        <Suspense fallback={<LoadingState />}>
          <Office />
        </Suspense>
      );
    case "rooms":
      return <Rooms />;
    case "room":
      return <Room key={view.roomId} roomId={view.roomId} />;
    case "letters":
      return <Letters />;
    case "talks":
      return <Talks />;
    case "talk":
      return <TalkView key={view.talkId} talkId={view.talkId} />;
    case "ideas":
      return <Ideas />;
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
  const { me, loading, loadError, view, load, logout, go } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const current =
    view.name === "room"
      ? "rooms"
      : view.name === "talk"
        ? "talks"
        : ["chat", "computer", "hatch", "hatch_short", "quick"].includes(view.name)
          ? "agents"
          : view.name;

  useEffect(() => {
    void health.check();
    void load();
    const timer = setInterval(() => void useHealth.getState().check(), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setMenuOpen(false);
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [view]);
  useEffect(() => {
    if (!menuOpen) return;
    const sidebar = document.getElementById("workspace-navigation");
    sidebar?.querySelector<HTMLButtonElement>("button")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || window.innerWidth > 900) return;
      const buttons = sidebar?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      const first = buttons?.[0],
        last = buttons?.[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => window.removeEventListener("keydown", trap);
  }, [menuOpen]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        document.querySelector<HTMLButtonElement>(".mobile-menu")?.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  const navButton = (name: Tab) => (
    <button
      key={name}
      type="button"
      aria-current={current === name ? "page" : undefined}
      className={`nav-item ${current === name ? "is-active" : ""}`}
      onClick={() => go({ name })}
    >
      <Icon name={name} />
      <span>{t(`nav.${name}`)}</span>
      {current === name && <span className="nav-active-dot" />}
    </button>
  );
  const brand = (
    <>
      <span className="brand-mark">
        <Icon name="spark" size={23} />
      </span>
      <span className="brand-name">
        {t("app.title")}
        <span className="brand-caption">{t("ui.workspace")}</span>
      </span>
    </>
  );

  return (
    <div className={`app-shell ${me ? "is-authenticated" : "is-guest"}`}>
      <a className="skip-link" href="#main-content">
        {t("ui.skip")}
      </a>
      {me && (
        <>
          {menuOpen && (
            <button
              className="sidebar-backdrop"
              type="button"
              aria-label={t("ui.closeMenu")}
              onClick={() => setMenuOpen(false)}
            />
          )}
          <aside className={`app-sidebar ${menuOpen ? "is-open" : ""}`} id="workspace-navigation">
            <button
              type="button"
              className="brand"
              onClick={() => go({ name: "agents" })}
              aria-label={t("app.title")}
            >
              {brand}
            </button>
            <div className="workspace-badge">
              <span className="workspace-monogram">N</span>
              <div>
                <strong>{t("ui.myWorkspace")}</strong>
                <span>{t("ui.selfHosted")}</span>
              </div>
              <span className="live-dot" />
            </div>
            <nav aria-label={t("nav.label")}>
              <p className="nav-group-label">{t("ui.overview")}</p>
              {NAV.slice(0, 3).map(navButton)}
              <p className="nav-group-label">{t("ui.collaborate")}</p>
              {NAV.slice(3, 7).map(navButton)}
              <p className="nav-group-label">{t("ui.knowledge")}</p>
              {NAV.slice(7, 9).map(navButton)}
            </nav>
            <div className="sidebar-bottom">
              {navButton("settings")}
              <div className="sidebar-note">
                <Icon name="spark" size={17} />
                <span>{t("ui.alwaysOn")}</span>
              </div>
              <button type="button" className="account-button" onClick={() => void logout()}>
                <span className="account-monogram">{me.email.charAt(0).toUpperCase()}</span>
                <span className="account-email">
                  {me.email}
                  <small>{t("auth.signOut")}</small>
                </span>
                <Icon name="logout" size={16} />
              </button>
            </div>
          </aside>
        </>
      )}
      <div className="app-body">
        <header className="app-topbar">
          {me ? (
            <div className="topbar-location">
              <button
                type="button"
                className="icon-button mobile-menu"
                aria-label={t("ui.openMenu")}
                aria-expanded={menuOpen}
                aria-controls="workspace-navigation"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <Icon name="menu" />
              </button>
              <span className="topbar-workspace">{t("ui.workspace")}</span>
              <span className="breadcrumb-slash">/</span>
              <span>{t(`nav.${current}`)}</span>
            </div>
          ) : (
            <div className="brand">{brand}</div>
          )}
          <div className="topbar-actions">
            <span
              role="status"
              data-testid="health-status"
              className={`health-indicator health-${health.status}`}
            >
              <span />
              {t(`health.${health.status}`)}
            </span>
            {me && <Notifications />}
            {me && <KillSwitch />}
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className={`app-main page-${view.name}`}>
          {loading ? (
            <LoadingState />
          ) : loadError ? (
            <PageState
              title={t("ui.sessionFailed")}
              action={{ label: t("ui.retry"), onClick: () => void load() }}
            />
          ) : !me ? (
            <Login />
          ) : (
            <Page view={view} />
          )}
        </main>
        <footer className="app-footer">
          <span>
            {t("app.title")}
            <span className="footer-dot">·</span>
            {t("ui.footer")}
          </span>
          <span className="footer-secondary">{t("ui.selfHosted")}</span>
        </footer>
      </div>
    </div>
  );
}
