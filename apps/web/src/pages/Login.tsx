import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api.js";
import { useSession } from "../store/session.js";

export function Login() {
  const { t } = useTranslation();
  const { login, signup } = useSession();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await (mode === "login" ? login(email, password) : signup(email, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.failed"));
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto mt-16 flex max-w-sm flex-col gap-3 rounded-blob bg-panel p-6 shadow-soft">
      <h2 className="text-2xl font-extrabold">{mode === "login" ? t("auth.welcomeBack") : t("auth.createAccount")}</h2>
      <label className="flex flex-col gap-1">
        {t("auth.email")}
        <input className="rounded-blob border border-line px-3 py-2 text-ink" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label className="flex flex-col gap-1">
        {t("auth.password")}
        <input
          className="rounded-blob border border-line px-3 py-2 text-ink"
          type="password"
          minLength={mode === "signup" ? 10 : 1}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error && <p role="alert" className="text-accent">{error}</p>}
      <button className="rounded-blob bg-rainbow px-4 py-3 font-bold shadow-soft transition-transform ease-squish active:scale-95">
        {mode === "login" ? t("auth.signIn") : t("auth.signUp")}
      </button>
      <button type="button" className="underline" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
        {mode === "login" ? t("auth.needAccount") : t("auth.haveAccount")}
      </button>
    </form>
  );
}
