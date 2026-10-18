import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";
import { LoadingState, PageState } from "../components/PageState.js";
import { Rules } from "../components/Rules.js";

interface Approval {
  id: string;
  agentName: string | null;
  kind: string;
  summary: string;
  reason: string;
  createdAt: string;
}

type Decision = "approve_once" | "approve_always" | "deny";

/** The approval inbox: approve once, always for this pattern, or deny. */
export function Approvals() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = async () => {
    try {
      setItems((await api<{ approvals: Approval[] }>("GET", "/approvals")).approvals);
    } catch {
      setError(t("ui.refreshFailed"));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, []);

  const decide = async (id: string, decision: Decision) => {
    if (pending) return;
    setPending(id);
    setError(null);
    try {
      await api("POST", `/approvals/${id}/decide`, { decision });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ui.failed"));
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xl font-extrabold">{t("approvals.title")}</h2>
      <p className="text-sm text-muted">{t("ui.approvalsIntro")}</p>
      {error && (
        <p role="alert" className="text-accent">
          {error}
        </p>
      )}
      {loading ? (
        <LoadingState />
      ) : (
        items.length === 0 &&
        !error && (
          <PageState title={t("ui.allClear")} description={t("approvals.empty")} icon="approvals" />
        )
      )}
      <ul className="flex flex-col gap-3">
        {items.map((a) => (
          <li key={a.id} className="flex flex-col gap-2 rounded-blob bg-panel p-4 shadow-soft">
            <p>
              <strong>{a.agentName ?? t("approvals.someone")}</strong> {t("approvals.wantsTo")}{" "}
              <span className="rounded-blob bg-peach px-2 py-0.5 text-sm">
                {t(`kinds.${a.kind}`, { defaultValue: a.kind })}
              </span>
            </p>
            <code className="break-words rounded-blob bg-cream px-3 py-2 text-sm text-ink">
              {a.summary}
            </code>
            <p className="text-sm opacity-80">{a.reason}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void decide(a.id, "approve_once")}
                className="rounded-blob bg-rainbow px-4 py-2 font-bold shadow-soft"
              >
                {t("approvals.once")}
              </button>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void decide(a.id, "approve_always")}
                className="rounded-blob bg-sky px-4 py-2 font-bold shadow-soft"
              >
                {t("approvals.always")}
              </button>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void decide(a.id, "deny")}
                className="rounded-blob bg-lilac px-4 py-2 font-bold shadow-soft"
              >
                {t("approvals.deny")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <Rules />
    </section>
  );
}
