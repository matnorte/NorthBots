import { z } from "zod";
import type { Mood } from "./mood.js";

/**
 * NorthBot avatars: one of 10 geometric shapes, one of 15 colours, and two little dot eyes.
 * Each shape + colour pair belongs to one agent per workspace, so agents are easy to tell
 * apart. Moods show through the eyes and a small mark (sparkle, sweat drop, "z"s, ...).
 * Pure string output so the web app, the office and exports share it.
 */
export const AVATAR_SHAPES = ["circle", "square", "triangle", "diamond", "pentagon", "hexagon", "octagon", "star", "capsule", "semicircle"] as const;
export const AVATAR_COLORS = [
  "coral",
  "tangerine",
  "sunflower",
  "lime",
  "mint",
  "teal",
  "sky",
  "cobalt",
  "periwinkle",
  "lilac",
  "grape",
  "pink",
  "rose",
  "sand",
  "slate",
] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export type AvatarColor = (typeof AVATAR_COLORS)[number];

/** Fill and outline for each colour; picked to stay distinguishable from each other. */
export const COLOR_HEX: Record<AvatarColor, { fill: string; edge: string }> = {
  coral: { fill: "#ff8a7a", edge: "#d65f4f" },
  tangerine: { fill: "#ffb066", edge: "#d6883a" },
  sunflower: { fill: "#ffd95c", edge: "#cfa827" },
  lime: { fill: "#b8e06a", edge: "#86ae38" },
  mint: { fill: "#7fdcb0", edge: "#4dab80" },
  teal: { fill: "#5cc6c6", edge: "#2e9696" },
  sky: { fill: "#7cc8f2", edge: "#4898c8" },
  cobalt: { fill: "#5b8def", edge: "#3560c0" },
  periwinkle: { fill: "#a3a8f5", edge: "#7176d4" },
  lilac: { fill: "#c9a6f2", edge: "#9a72cd" },
  grape: { fill: "#9b6bd6", edge: "#6d43a6" },
  pink: { fill: "#ff9ccf", edge: "#d469a3" },
  rose: { fill: "#f2798f", edge: "#c64c64" },
  sand: { fill: "#e3c9a2", edge: "#b19770" },
  slate: { fill: "#9aa7b8", edge: "#6b798b" },
};

// Avatars saved before the geometric redesign still render: old bodies map to the closest shape.
const LEGACY_SHAPE: Record<string, AvatarShape> = { blob: "circle", cat: "triangle", robot: "square", plant: "pentagon", ghost: "capsule" };
const LEGACY_COLOR: Record<string, AvatarColor> = { peach: "coral", butter: "sunflower" };

export const Avatar = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const r = raw as Record<string, unknown>;
    const shape = r.shape ?? (typeof r.base === "string" ? LEGACY_SHAPE[r.base] : undefined);
    const color = typeof r.color === "string" ? (LEGACY_COLOR[r.color] ?? r.color) : r.color;
    return { shape, color };
  },
  z.object({ shape: z.enum(AVATAR_SHAPES).default("circle"), color: z.enum(AVATAR_COLORS).default("coral") }),
);
export type Avatar = z.infer<typeof Avatar>;

/** All 150 looks, in the order new agents receive them (colours first, so neighbours differ). */
export function allLooks(): Avatar[] {
  return AVATAR_SHAPES.flatMap((_, s) => AVATAR_COLORS.map((color, c) => ({ shape: AVATAR_SHAPES[(s + c) % AVATAR_SHAPES.length]!, color })));
}

export const lookKey = (a: Avatar): string => `${a.shape}/${a.color}`;

/** The first look nobody in `taken` has (preferring `wanted`); duplicates only once all 150 are used. */
export function freeLook(taken: Avatar[], wanted?: Partial<Avatar>): Avatar {
  const used = new Set(taken.map(lookKey));
  const pref = wanted?.shape || wanted?.color ? Avatar.parse(wanted) : null;
  if (pref && !used.has(lookKey(pref))) return pref;
  const sameShape = pref ? AVATAR_COLORS.map((color) => ({ shape: pref.shape, color })).find((a) => !used.has(lookKey(a))) : undefined;
  return sameShape ?? allLooks().find((a) => !used.has(lookKey(a))) ?? pref ?? { shape: "circle", color: "coral" };
}

export type Expression = Mood | "dizzy" | "hearts";

const regular = (n: number, r: number, cx: number, cy: number, rotate = -90) =>
  Array.from({ length: n }, (_, i) => {
    const a = ((rotate + (360 / n) * i) * Math.PI) / 180;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");

const star = (cx: number, cy: number, outer: number, inner: number) =>
  Array.from({ length: 10 }, (_, i) => {
    const a = ((-90 + 36 * i) * Math.PI) / 180;
    const r = i % 2 === 0 ? outer : inner;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");

/** Body outline, and where the eyes sit (y) and how far apart (dx) for each shape. */
function shapeOf(shape: AvatarShape): { svg: (attrs: string) => string; eyeY: number; eyeDx: number } {
  switch (shape) {
    case "circle":
      return { svg: (a) => `<circle ${a} cx="60" cy="62" r="44"/>`, eyeY: 60, eyeDx: 13 };
    case "square":
      return { svg: (a) => `<rect ${a} x="18" y="20" width="84" height="84" rx="16"/>`, eyeY: 60, eyeDx: 14 };
    case "triangle":
      return { svg: (a) => `<polygon ${a} points="60,16 108,102 12,102"/>`, eyeY: 78, eyeDx: 11 };
    case "diamond":
      return { svg: (a) => `<polygon ${a} points="60,12 108,62 60,112 12,62"/>`, eyeY: 62, eyeDx: 12 };
    case "pentagon":
      return { svg: (a) => `<polygon ${a} points="${regular(5, 50, 60, 66)}"/>`, eyeY: 64, eyeDx: 13 };
    case "hexagon":
      return { svg: (a) => `<polygon ${a} points="${regular(6, 48, 60, 62, 0)}"/>`, eyeY: 60, eyeDx: 13 };
    case "octagon":
      return { svg: (a) => `<polygon ${a} points="${regular(8, 48, 60, 62, 22.5)}"/>`, eyeY: 60, eyeDx: 13 };
    case "star":
      return { svg: (a) => `<polygon ${a} points="${star(60, 64, 54, 27)}"/>`, eyeY: 66, eyeDx: 9 };
    case "capsule":
      return { svg: (a) => `<rect ${a} x="28" y="12" width="64" height="98" rx="32"/>`, eyeY: 54, eyeDx: 12 };
    case "semicircle":
      return { svg: (a) => `<path ${a} d="M12 96A48 48 0 0 1 108 96Z"/>`, eyeY: 78, eyeDx: 13 };
  }
}

const INK = "#2e2a40";
const dot = (x: number, y: number, r = 5, ry = r) => `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${ry}" fill="${INK}"/>`;

/** The two dot eyes for an expression, plus a small mark that names the mood. */
function face(expr: Expression, y: number, dx: number): string {
  const l = 60 - dx;
  const r = 60 + dx;
  const mark = (svg: string) => `<g transform="translate(92 22)">${svg}</g>`;
  switch (expr) {
    case "content":
      return dot(l, y) + dot(r, y);
    case "proud":
      return dot(l, y - 2) + dot(r, y - 2) + mark(`<path d="M0-9 2.4-2.4 9 0 2.4 2.4 0 9-2.4 2.4-9 0-2.4-2.4Z" fill="#ffd95c" stroke="${INK}" stroke-width="1.5"/>`);
    case "impatient":
      return dot(l + 3, y) + dot(r + 3, y) + mark(`<g fill="${INK}"><circle cx="-6" r="2"/><circle r="2"/><circle cx="6" r="2"/></g>`);
    case "grumpy":
      return dot(l, y + 2) + dot(r, y + 2) + mark(`<path d="M-6-2h12M-2-6v12M2-6v12M-6 2h12" stroke="#e5484d" stroke-width="2.5" stroke-linecap="round"/>`);
    case "confused":
      return dot(l, y - 3) + dot(r, y + 1) + mark(`<text x="-5" y="8" font-size="22" font-family="sans-serif" font-weight="800" fill="${INK}">?</text>`);
    case "sad":
      return dot(l, y + 4) + dot(r, y + 4) + `<path d="M${l} ${y + 12}q-3 6 0 8 3-2 0-8z" fill="#5b8def"/>`;
    case "worried":
      return dot(l, y) + dot(r, y) + mark(`<path d="M0-8q-6 9 0 12 6-3 0-12z" fill="#7cc8f2" stroke="${INK}" stroke-width="1.2"/>`);
    case "overwhelmed":
      return dot(l - 2, y + 1, 3.5) + dot(r + 2, y - 1, 3.5) + mark(`<text x="-7" y="8" font-size="20" font-family="sans-serif" font-weight="800" fill="#e5484d">!!</text>`);
    case "embarrassed":
      return dot(l, y) + dot(r, y) + `<ellipse cx="${l - 4}" cy="${y + 10}" rx="7" ry="3.5" fill="#ff6f91" opacity=".6"/><ellipse cx="${r + 4}" cy="${y + 10}" rx="7" ry="3.5" fill="#ff6f91" opacity=".6"/>`;
    case "sleepy":
      return dot(l, y + 1, 5, 1.8) + dot(r, y + 1, 5, 1.8) + mark(`<text x="-6" y="6" font-size="15" font-family="sans-serif" font-weight="800" fill="${INK}">z</text><text x="4" y="-4" font-size="10" font-family="sans-serif" font-weight="800" fill="${INK}">z</text>`);
    case "annoyed":
      return dot(l, y + 1, 5, 3) + dot(r, y + 1, 5, 3) + mark(`<path d="M-6 4q2-8 6-4 4-6 6 2" fill="none" stroke="#9aa7b8" stroke-width="2.5" stroke-linecap="round"/>`);
    case "dizzy":
      return dot(l, y) + dot(r, y) + mark(`<path d="M0 0m-6 0a6 6 0 1 1 12 0a4 4 0 1 1-8 0a2 2 0 1 1 4 0" fill="none" stroke="${INK}" stroke-width="2"/>`);
    case "hearts":
      return dot(l, y - 1) + dot(r, y - 1) + mark(`<path d="M0 7-7 0c-4-4 0-10 4-7l3 3 3-3c4-3 8 3 4 7z" fill="#ff6f91"/>`);
  }
}

/** Returns a standalone SVG document for an avatar wearing an expression. */
export function avatarSvg(avatar: unknown, expression: Expression = "content", size = 120): string {
  const a = Avatar.parse(avatar ?? {});
  const { fill, edge } = COLOR_HEX[a.color];
  const s = shapeOf(a.shape);
  const body = s.svg(`fill="${fill}" stroke="${edge}" stroke-width="4" stroke-linejoin="round"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">${body}${face(expression, s.eyeY, s.eyeDx)}</svg>`;
}

export function avatarDataUrl(avatar: unknown, expression: Expression = "content", size = 120): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg(avatar, expression, size))}`;
}
