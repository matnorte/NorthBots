import { Connections } from "./Connections.js";
import { ModelProvider } from "./ModelProvider.js";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";
import { LoadingState, PageState } from "../components/PageState.js";
import type { Agent } from "./Agents.js";
import i18n from "../i18n/index.js";

interface WorkspaceSettings {
  name: string;
  timezone: string;
  locale: "en" | "pt-BR" | "es";
  moodsEnabled: boolean;
  quietHours: { start: string; end: string } | null;
  coordinatorAgentId: string | null;
  ideaBinDays: number;
}

export function Settings() {
  const { t } = useTranslation();
  const [s, setS] = useState<WorkspaceSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<WorkspaceSettings>("GET", "/settings")
      .then(setS)
      .catch(() => setError(t("ui.failed")));
    void api<{ agents: Agent[] }>("GET", "/agents")
      .then((r) => setAgents(r.agents))
      .catch(() => {});
  }, []);
  if (!s) return error ? <PageState title={error} /> : <LoadingState />;

  const save = async (patch: Partial<WorkspaceSettings>) => {
    setError(null);
    try {
      const next = await api<WorkspaceSettings>("PATCH", "/settings", patch);
      setS(next);
      if (patch.locale) void i18n.changeLanguage(patch.locale);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ui.failed"));
    }
  };

  return (
    <section className="settings-page flex max-w-2xl flex-col gap-4">
      <h2 className="text-2xl font-extrabold">{t("settings.title")}</h2>
      {error && (
        <p role="alert" className="text-accent">
          {error}
        </p>
      )}
      <div className="settings-card">
        <label className="flex flex-col gap-1">
          {t("settings.language")}
          <select
            className="rounded-blob border border-line px-3 py-2 text-ink"
            value={s.locale}
            onChange={(e) => void save({ locale: e.target.value as WorkspaceSettings["locale"] })}
          >
            <option value="en">English</option>
            <option value="pt-BR">Português (Brasil)</option>
            <option value="es">Español</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          {t("settings.timezone")}
          <input
            className="rounded-blob border border-line px-3 py-2 text-ink"
            defaultValue={s.timezone}
            onBlur={(e) => e.target.value !== s.timezone && void save({ timezone: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={s.moodsEnabled}
            onChange={(e) => void save({ moodsEnabled: e.target.checked })}
          />
          {t("settings.moods")}
        </label>
      </div>
      <fieldset className="settings-card flex flex-col gap-2">
        <legend className="font-bold">{t("settings.quietHours")}</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={s.quietHours !== null}
            onChange={(e) =>
              void save({ quietHours: e.target.checked ? { start: "22:00", end: "08:00" } : null })
            }
          />
          {t("settings.quietOn")}
        </label>
        {s.quietHours && (
          <div className="flex gap-2">
            <input
              type="time"
              aria-label={t("settings.quietStart")}
              className="rounded-blob border border-line px-2 py-1 text-ink"
              value={s.quietHours.start}
              onChange={(e) =>
                s.quietHours &&
                void save({ quietHours: { ...s.quietHours, start: e.target.value } })
              }
            />
            <input
              type="time"
              aria-label={t("settings.quietEnd")}
              className="rounded-blob border border-line px-2 py-1 text-ink"
              value={s.quietHours.end}
              onChange={(e) =>
                s.quietHours && void save({ quietHours: { ...s.quietHours, end: e.target.value } })
              }
            />
          </div>
        )}
      </fieldset>
      <div className="settings-card">
        <label className="flex flex-col gap-1">
          {t("settings.coordinator")}
          <select
            className="rounded-blob border border-line px-3 py-2 text-ink"
            value={s.coordinatorAgentId ?? ""}
            onChange={(e) => void save({ coordinatorAgentId: e.target.value || null })}
          >
            <option value="">{t("settings.noCoordinator")}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">{t("settings.coordinatorHelp")}</span>
        </label>
        <label className="flex flex-col gap-1">
          {t("settings.ideaBinDays")}
          <input
            type="number"
            min={1}
            max={365}
            className="w-28 rounded-blob border border-line px-3 py-2 text-ink"
            defaultValue={s.ideaBinDays}
            onBlur={(e) =>
              Number(e.target.value) !== s.ideaBinDays &&
              void save({ ideaBinDays: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <ModelProvider />
      <Connections />
      {saved && <p role="status">{t("settings.saved")}</p>}
    </section>
  );
}

