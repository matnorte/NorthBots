import { useTranslation } from "react-i18next";
import { avatarDataUrl, type Avatar, type Expression } from "@northbot/shared";

/** An agent's face. The alt text is the plain-language equivalent for screen readers. */
export function AgentAvatar({
  avatar,
  mood = "content",
  name,
  size = 72,
  idle = true,
}: {
  avatar: Partial<Avatar>;
  mood?: Expression | string;
  name?: string;
  size?: number;
  idle?: boolean;
}) {
  const { t } = useTranslation();
  const expr = mood as Expression;
  const look = t("avatar.look", {
    color: t(`avatar.colors.${avatar.color ?? "coral"}`),
    shape: t(`avatar.shapes.${avatar.shape ?? "circle"}`),
  });
  const alt = name ? t("avatar.alt", { name, look, mood: t(`moods.${expr}`, { defaultValue: expr }) }) : look;
  return <img src={avatarDataUrl(avatar, expr, size)} alt={alt} width={size} height={size} className={idle ? "nb-idle" : ""} />;
}
