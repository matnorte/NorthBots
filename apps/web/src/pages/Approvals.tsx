import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api.js";

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

  const load = async () => setItems((await api<{ approvals: Approval[] }>("GET", "/approvals")).approvals);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, []);

  const decide = async (id: string, decision: Decision) => {
    await api("POST", `/approvals/${id}/decide`, { decision });
    await load();
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xl font-extrabold">{t("approvals.title")}</h2>
      {items.length === 0 && <p className="rounded-blob bg-mint p-4">{t("approvals.empty")}</p>}
      <ul className="flex flex-col gap-3">
        {items.map((a) => (
          <li key={a.id} className="flex flex-col gap-2 rounded-blob bg-white/80 p-4 shadow-soft dark:bg-white/10">
            <p>
              <strong>{a.agentName ?? t("approvals.someone")}</strong> {t("approvals.wantsTo")}{" "}
              <span className="rounded-blob bg-peach px-2 py-0.5 text-sm">{t(`kinds.${a.kind}`, { defaultValue: a.kind })}</span>
            </p>
            <code className="break-words rounded-blob bg-cream px-3 py-2 text-sm text-ink">{a.summary}</code>
            <p className="text-sm opacity-80">{a.reason}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void decide(a.id, "approve_once")} className="rounded-blob bg-mint px-4 py-2 font-bold shadow-soft">
                {t("approvals.once")}
              </button>
              <button type="button" onClick={() => void decide(a.id, "approve_always")} className="rounded-blob bg-sky px-4 py-2 font-bold shadow-soft">
                {t("approvals.always")}
              </button>
              <button type="button" onClick={() => void decide(a.id, "deny")} className="rounded-blob bg-lilac px-4 py-2 font-bold shadow-soft">
                {t("approvals.deny")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
