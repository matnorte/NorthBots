import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useHealth } from "./store/health.js";

export function App() {
  const { t } = useTranslation();
  const { status, check } = useHealth();

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-4xl font-extrabold">{t("app.title")}</h1>
      <p className="text-lg">{t("app.tagline")}</p>
      <p
        role="status"
        className="rounded-blob bg-mint px-4 py-2 shadow-soft"
        data-testid="health-status"
      >
        {t(`health.${status}`)}
      </p>
    </main>
  );
}
