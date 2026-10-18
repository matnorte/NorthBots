import { useTranslation } from "react-i18next";
import { AVATAR_COLORS, AVATAR_SHAPES, avatarDataUrl, COLOR_HEX, lookKey, type Avatar } from "@northbot/shared";

export interface TakenLook {
  avatar: Avatar;
  name: string;
}

/** 10 shapes and 15 colours. A shape + colour already used by another agent can't be picked. */
export function LookPicker({ value, onChange, taken }: { value: Avatar; onChange: (a: Avatar) => void; taken: TakenLook[] }) {
  const { t } = useTranslation();
  const owner = new Map(taken.map((x) => [lookKey(x.avatar), x.name]));

  return (
    <div className="flex w-full flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-bold">{t("hatch.parts.shape")}</legend>
        <div className="grid grid-cols-5 gap-2">
          {AVATAR_SHAPES.map((shape) => (
            <button
              key={shape}
              type="button"
              aria-pressed={value.shape === shape}
              aria-label={t(`avatar.shapes.${shape}`)}
              title={t(`avatar.shapes.${shape}`)}
              onClick={() => onChange({ ...value, shape })}
              className={`flex items-center justify-center rounded-blob p-1 ${value.shape === shape ? "rainbow-border bg-lilac" : "bg-panel"}`}
            >
              <img src={avatarDataUrl({ shape, color: value.color }, "content", 44)} alt="" width={44} height={44} />
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-bold">{t("hatch.parts.color")}</legend>
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
          {AVATAR_COLORS.map((color) => {
            const by = owner.get(lookKey({ shape: value.shape, color }));
            const label = by ? `${t(`avatar.colors.${color}`)} (${t("hatch.lookTaken", { name: by })})` : t(`avatar.colors.${color}`);
            return (
              <button
                key={color}
                type="button"
                aria-pressed={value.color === color}
                aria-label={label}
                title={label}
                disabled={Boolean(by)}
                onClick={() => onChange({ ...value, color })}
                className={`h-10 rounded-full border-4 disabled:cursor-not-allowed disabled:opacity-25 ${value.color === color ? "border-ink" : "border-transparent"}`}
                style={{ background: COLOR_HEX[color].fill }}
              />
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
