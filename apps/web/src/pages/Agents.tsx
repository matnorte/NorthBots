import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api.js";
import { useSession } from "../store/session.js";

export interface Agent {
  id: string;
  name: string;
  status: string;
  mood: string;
  sandboxId: string | null;
}

export function Agents() {
  const { t } = useTranslation();
  const go = useSession((s) => s.go);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => setAgents((await api<{ agents: Agent[] }>("GET", "/agents")).agents);
  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/agents", { name });
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("agents.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xl font-extrabold">{t("agents.title")}</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {agents.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => go({ name: "computer", agentId: a.id })}
              className="w-full rounded-blob bg-mint p-4 text-left shadow-soft transition-transform ease-squish hover:-translate-y-0.5 active:scale-95"
            >
              <span className="block text-lg font-bold">{a.name}</span>
              <span className="text-sm">{t(`status.${a.status}`)}</span>
            </button>
          </li>
        ))}
        {agents.length === 0 && <li className="rounded-blob bg-sky p-4">{t("agents.empty")}</li>}
      </ul>
      <form onSubmit={create} className="flex gap-2">
        <input
          className="flex-1 rounded-blob border border-lilac px-3 py-2 text-ink"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("agents.namePlaceholder")}
          aria-label={t("agents.namePlaceholder")}
          minLength={2}
          maxLength={12}
          required
        />
        <button disabled={busy} className="rounded-blob bg-accent px-4 py-2 font-bold text-white shadow-soft disabled:opacity-50">
          {busy ? t("agents.creating") : t("agents.create")}
        </button>
      </form>
      {error && <p role="alert" className="text-accent">{error}</p>}
    </section>
  );
}
