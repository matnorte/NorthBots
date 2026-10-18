import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AUTONOMY_LEVELS } from "@northbot/shared";

export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

/**
 * A five-step slider from "Plan only" to "Full access". `value` is null when several agents
 * are on different levels. Moving to full access asks for confirmation once.
 */
export function PermissionSlider({
  value,
  onChange,
  compact = false,
  disabled = false,
  label,
}: {
  value: Autonomy | null;
  onChange: (level: Autonomy) => void;
  compact?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const index = value ? AUTONOMY_LEVELS.indexOf(value) : -1;
  const pick = (i: number) => {
    const next = AUTONOMY_LEVELS[i];
    if (!next || next === value) return;
    if (next === "full_access" && !window.confirm(t("permissions.confirmFull"))) return;
    onChange(next);
  };
  return (
    <div className={`permission-slider ${compact ? "is-compact" : ""}`} data-level={value ?? "mixed"}>
      <div className="permission-slider-head">
        <label htmlFor={id}>{label ?? t("permissions.title")}</label>
        <strong>{value ? t(`permissions.levels.${value}`) : t("permissions.mixed")}</strong>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={AUTONOMY_LEVELS.length - 1}
        step={1}
        value={index < 0 ? 1 : index}
        disabled={disabled}
        aria-valuetext={value ? t(`permissions.levels.${value}`) : t("permissions.mixed")}
        style={{ ["--fill" as string]: `${(Math.max(0, index) / (AUTONOMY_LEVELS.length - 1)) * 100}%` }}
        onChange={(e) => pick(Number(e.target.value))}
      />
      {!compact && (
        <ol className="permission-slider-ticks" aria-hidden="true">
          {AUTONOMY_LEVELS.map((l, i) => (
            <li key={l}>
              <button type="button" tabIndex={-1} disabled={disabled} className={i === index ? "is-on" : ""} onClick={() => pick(i)}>
                {t(`permissions.levels.${l}`)}
              </button>
            </li>
          ))}
        </ol>
      )}
      {value && <p className="permission-slider-help">{t(`permissions.help.${value}`)}</p>}
    </div>
  );
}
