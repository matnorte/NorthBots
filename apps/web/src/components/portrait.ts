import { Avatar, COLOR_HEX } from "@northbot/shared";

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  if (!d) return 0;
  const h = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Generated coral masters retain their lighting while the saved colour identifies each agent. */
export function agentPortrait(raw: Partial<Avatar>) {
  const a = Avatar.parse(raw);
  const angle = hue(COLOR_HEX[a.color].fill) - hue("#ff887d");
  const finish =
    a.color === "slate"
      ? " saturate(0.2) brightness(0.91)"
      : a.color === "sand"
        ? " saturate(0.48) brightness(1.12)"
        : a.color === "grape"
          ? " saturate(1.15) brightness(0.78)"
          : "";
  return {
    src: `/avatars/${a.shape}.webp`,
    filter: `hue-rotate(${Math.round(angle)}deg)${finish}`,
  };
}
