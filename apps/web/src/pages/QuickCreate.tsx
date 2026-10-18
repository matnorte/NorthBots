import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";
import { useSession } from "../store/session.js";

/** Skips hatching: a name and done. */
export function QuickCreate() {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("POST", "/agents", { name });
      go({ name: "agents" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("agents.createFailed"));
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-3">
      <h2 className="text-2xl font-extrabold">{t("hatch.quick")}</h2>
      <input
        className="rounded-blob border border-lilac px-3 py-2 text-ink"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("agents.namePlaceholder")}
        aria-label={t("agents.namePlaceholder")}
        minLength={2}
        maxLength={12}
        required
      />
      <button className="rounded-blob bg-accent px-4 py-3 font-bold text-white shadow-soft">{t("agents.create")}</button>
      {error && <p role="alert" className="text-accent">{error}</p>}
      <button type="button" className="underline" onClick={() => go({ name: "hatch" })}>
        {t("hatch.backToHatch")}
      </button>
    </form>
  );
}
