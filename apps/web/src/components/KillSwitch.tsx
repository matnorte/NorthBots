import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api.js";

/** One button that stops every agent. Asks once before engaging. */
export function KillSwitch() {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);

  useEffect(() => {
    void api<{ active: boolean }>("GET", "/kill-switch").then((r) => setActive(r.active));
  }, []);

  const toggle = async () => {
    if (!active && !window.confirm(t("kill.confirm"))) return;
    const r = await api<{ active: boolean }>("POST", "/kill-switch", { engage: !active });
    setActive(r.active);
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      aria-pressed={active}
      className="kill-switch"
    >
      {active ? t("kill.release") : t("kill.engage")}
    </button>
  );
}
