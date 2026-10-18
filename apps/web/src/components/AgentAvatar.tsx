import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { avatarDataUrl, type Avatar, type Expression } from "@northbot/shared";
import { agentPortrait } from "./portrait.js";

const MOOD_MARKS: Record<string, string> = {
  proud: "✦",
  impatient: "…",
  grumpy: "!",
  confused: "?",
  sad: "·",
  worried: "!",
  overwhelmed: "!!",
  embarrassed: "♡",
  sleepy: "z",
  annoyed: "…",
  dizzy: "↻",
  hearts: "♡",
};

/** Sparkles that orbit a working agent: speed, start offset and colour for each. */
const SPARKS = [
  { speed: "2.2s", delay: "0s", spark: "#f9e46b" },
  { speed: "2.9s", delay: "-1s", spark: "#4fc3f7" },
  { speed: "3.6s", delay: "-2s", spark: "#e879f9" },
];

/**
 * An agent's face. With `status`, it also moves: working agents bounce inside a spinning
 * rainbow ring with orbiting sparkles and a typing bubble; waiting ones sway; resting ones
 * breathe; blocked ones shake. The alt text is the plain-language equivalent.
 */
export function AgentAvatar({
  avatar,
  mood = "content",
  name,
  size = 72,
  status,
}: {
  avatar: Partial<Avatar>;
  mood?: Expression | string;
  name?: string;
  size?: number;
  status?: string;
}) {
  const { t } = useTranslation();
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const portrait = agentPortrait(avatar);
  const expr = mood as Expression;
  const look = t("avatar.look", {
    color: t(`avatar.colors.${avatar.color ?? "coral"}`),
    shape: t(`avatar.shapes.${avatar.shape ?? "circle"}`),
  });
  const doing = status ? `, ${t(`status.${status}`, { defaultValue: status }).toLowerCase()}` : "";
  const alt = name
    ? `${t("avatar.alt", { name, look, mood: t(`moods.${expr}`, { defaultValue: expr }) })}${doing}`
    : look;
  const cls = status === "idle" ? "nb-idle-status" : status ? `nb-${status}` : "nb-idle";

  return (
    <span className={`nb-agent ${cls}`} style={{ width: size, height: size }}>
      {status === "working" && (
        <>
          <span className="nb-ring" aria-hidden="true" />
          {SPARKS.map((s, i) => (
            <span
              key={i}
              className="nb-orbiter"
              aria-hidden="true"
              style={
                {
                  "--orbit": `${size * 0.62}px`,
                  "--speed": s.speed,
                  "--delay": s.delay,
                  "--spark": s.spark,
                } as CSSProperties
              }
            />
          ))}
        </>
      )}
      {(status === "working" || status === "waiting") && (
        <span className="nb-bubble" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      <img
        src={failedSource === portrait.src ? avatarDataUrl(avatar, expr, size) : portrait.src}
        style={failedSource === portrait.src ? undefined : { filter: portrait.filter }}
        onError={() => setFailedSource(portrait.src)}
        alt={alt}
        width={size}
        height={size}
        decoding="async"
      />
      {MOOD_MARKS[expr] && (
        <span
          className={`portrait-mood mood-${expr}`}
          title={t(`moods.${expr}`, { defaultValue: expr })}
          aria-hidden="true"
        >
          {MOOD_MARKS[expr]}
        </span>
      )}
    </span>
  );
}
