import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";

interface Rule {
  id: string;
  text: string;
  rule: { effect?: string };
  source: string;
}

/** Permission rules in plain language ("never buy anything over $50"). */
export function Rules() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<Rule[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => setRules((await api<{ rules: Rule[] }>("GET", "/rules")).rules);
  useEffect(() => {
    void load();
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("POST", "/rules", { text });
      setText("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("rules.failed"));
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-label={t("rules.title")}>
      <h3 className="text-xl font-extrabold">{t("rules.title")}</h3>
      <ul className="flex flex-col gap-2">
        {rules.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 rounded-blob bg-panel px-3 py-2">
            <span>
              <span className="mr-2 rounded-blob bg-lilac px-2 text-xs text-ink">{t(`rules.effects.${r.rule.effect ?? "ask"}`)}</span>
              {r.text}
            </span>
            <button type="button" className="text-sm underline" onClick={() => void api("DELETE", `/rules/${r.id}`).then(load)}>
              {t("rules.remove")}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex gap-2">
        <input className="flex-1 rounded-blob border border-line px-3 py-2 text-ink" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("rules.placeholder")} aria-label={t("rules.placeholder")} />
        <button className="rounded-blob bg-rainbow px-4 py-2 font-bold">{t("rules.add")}</button>
      </form>
      {error && <p role="alert" className="text-accent">{error}</p>}
    </section>
  );
}
