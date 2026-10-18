import { z } from "zod";
import type { Mood } from "./mood.js";

/**
 * NorthBot's original avatar set: layered SVG (base shape, colour, face, accessory), with one
 * expression per mood. Pure string output so the web app, the office and exports share it.
 */
export const AVATAR_BASES = ["blob", "cat", "robot", "plant", "ghost"] as const;
export const AVATAR_COLORS = ["peach", "mint", "sky", "lilac", "butter", "rose"] as const;
export const AVATAR_ACCESSORIES = ["none", "bow", "hat", "glasses", "scarf", "headphones", "flower"] as const;

export const Avatar = z.object({
  base: z.enum(AVATAR_BASES).default("blob"),
  color: z.enum(AVATAR_COLORS).default("peach"),
  accessory: z.enum(AVATAR_ACCESSORIES).default("none"),
});
export type Avatar = z.infer<typeof Avatar>;

export type Expression = Mood | "dizzy" | "hearts";

const FILL: Record<Avatar["color"], [string, string]> = {
  peach: ["#ffcfb3", "#f3a987"],
  mint: ["#bfead6", "#86cdb0"],
  sky: ["#c4defb", "#8fb9ea"],
  lilac: ["#ddd0fb", "#b5a2ea"],
  butter: ["#fde9a6", "#ecc969"],
  rose: ["#fbc8d8", "#eb98b3"],
};
const INK = "#3b3550";

/** Body silhouettes, all in a 120x120 box with the face centred near (60, 66). */
function body(base: Avatar["base"], fill: string, edge: string): string {
  const s = `fill="${fill}" stroke="${edge}" stroke-width="3" stroke-linejoin="round"`;
  switch (base) {
    case "blob":
      return `<path ${s} d="M60 22c26 0 44 18 44 44 0 24-18 40-44 40S16 90 16 66c0-26 18-44 44-44z"/>`;
    case "cat":
      return `<path ${s} d="M26 44 22 14l26 16q12-3 24 0l26-16-4 30q10 10 10 24c0 22-18 38-44 38S16 90 16 68q0-14 10-24z"/>`;
    case "robot":
      return `<line x1="60" y1="24" x2="60" y2="12" stroke="${edge}" stroke-width="3"/><circle cx="60" cy="10" r="5" fill="#ff7a59"/><rect ${s} x="18" y="26" width="84" height="78" rx="22"/><rect x="10" y="56" width="8" height="20" rx="4" fill="${edge}"/><rect x="102" y="56" width="8" height="20" rx="4" fill="${edge}"/>`;
    case "plant":
      return `<path d="M60 30C48 14 30 14 26 22c10 0 22 4 34 12zM60 30c12-16 30-16 34-8-10 0-22 4-34 12z" fill="#86cdb0" stroke="#5aa587" stroke-width="2"/><path ${s} d="M60 30c24 0 40 16 40 36 0 22-16 38-40 38S20 88 20 66c0-20 16-36 40-36z"/><path d="M34 98h52l-6 16H40z" fill="#e8a27c" stroke="#c97f5b" stroke-width="3" stroke-linejoin="round"/>`;
    case "ghost":
      return `<path ${s} d="M60 18c24 0 40 18 40 42v46l-10-8-10 8-10-8-10 8-10-8-10 8-10-8-10 8V60c0-24 16-42 40-42z"/>`;
  }
}

const eye = (x: number, y = 62) => `<circle cx="${x}" cy="${y}" r="4.5" fill="${INK}"/>`;
const happyEye = (x: number) => `<path d="M${x - 6} 64q6-8 12 0" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
const lineEye = (x: number) => `<path d="M${x - 6} 63h12" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`;
const blush = `<ellipse cx="38" cy="74" rx="7" ry="4" fill="#ff8fa3" opacity=".55"/><ellipse cx="82" cy="74" rx="7" ry="4" fill="#ff8fa3" opacity=".55"/>`;
const mouth = (d: string) => `<path d="${d}" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>`;

function face(expr: Expression): string {
  switch (expr) {
    case "content":
      return eye(46) + eye(74) + mouth("M52 78q8 6 16 0");
    case "proud":
      return happyEye(46) + happyEye(74) + blush + `<path d="M49 76q11 12 22 0z" fill="${INK}"/>`;
    case "impatient":
      return `<circle cx="49" cy="62" r="4.5" fill="${INK}"/><circle cx="77" cy="62" r="4.5" fill="${INK}"/>` + mouth("M52 80h16") + `<path d="M96 40l6-4M98 50h7" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>`;
    case "grumpy":
      return eye(46, 64) + eye(74, 64) + mouth("M40 54l12 4M80 54l-12 4") + mouth("M52 82q8-6 16 0");
    case "confused":
      return eye(46) + eye(74) + mouth("M40 52l10-3") + mouth("M52 80q4-4 8 0t8 0") + `<text x="92" y="44" font-size="20" font-family="sans-serif" font-weight="800" fill="${INK}">?</text>`;
    case "sad":
      return eye(46, 64) + eye(74, 64) + mouth("M52 84q8-8 16 0") + `<path d="M40 70q-3 6 0 9 3-3 0-9z" fill="#8fb9ea"/>`;
    case "worried":
      return eye(46, 64) + eye(74, 64) + mouth("M40 52l10 3M80 52l-10 3") + mouth("M50 82q5-4 10 0t10 0") + `<path d="M94 46q-4 7 0 10 4-3 0-10z" fill="#8fb9ea"/>`;
    case "overwhelmed":
      return mouth("M42 62a4 4 0 1 1 8 0 2 2 0 1 1-4 0M70 62a4 4 0 1 1 8 0 2 2 0 1 1-4 0") + `<ellipse cx="60" cy="82" rx="6" ry="7" fill="${INK}"/>`;
    case "embarrassed":
      return lineEye(46) + lineEye(74) + blush + blush + mouth("M53 80q3-3 7 0t7 0");
    case "sleepy":
      return lineEye(46) + lineEye(74) + mouth("M55 80h10") + `<text x="86" y="40" font-size="16" font-family="sans-serif" font-weight="800" fill="${INK}">z</text><text x="96" y="28" font-size="11" font-family="sans-serif" font-weight="800" fill="${INK}">z</text>`;
    case "annoyed":
      return mouth("M40 62h12M68 62h12") + eye(47, 65) + eye(75, 65) + mouth("M54 82h12l4-2");
    case "dizzy":
      return mouth("M42 58l8 8M50 58l-8 8M70 58l8 8M78 58l-8 8") + mouth("M52 80q4 4 8 0t8 0");
    case "hearts":
      return happyEye(46) + happyEye(74) + blush + mouth("M52 78q8 7 16 0") + `<path d="M94 30c-3-5-10-2-7 4l7 6 7-6c3-6-4-9-7-4z" fill="#ff7a8a"/>`;
  }
}

function accessory(a: Avatar["accessory"], base: Avatar["base"]): string {
  const top = base === "robot" ? 26 : base === "plant" ? 32 : base === "ghost" ? 22 : 24;
  switch (a) {
    case "none":
      return "";
    case "bow":
      return `<path d="M60 ${top + 4}l-14-8v16zM60 ${top + 4}l14-8v16z" fill="#ff7a8a" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><circle cx="60" cy="${top + 4}" r="4" fill="#ff5c74"/>`;
    case "hat":
      return `<path d="M38 ${top + 2}h44l-6-20H44z" fill="#6b5ca5" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M30 ${top + 2}h60" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`;
    case "glasses":
      return `<g fill="none" stroke="${INK}" stroke-width="2.5"><circle cx="46" cy="62" r="10"/><circle cx="74" cy="62" r="10"/><path d="M56 62h8"/></g>`;
    case "scarf":
      return `<path d="M30 94q30 12 60 0v8q-30 12-60 0z" fill="#ff7a59" stroke="${INK}" stroke-width="2"/><path d="M76 100l4 14h8l-4-16z" fill="#ff7a59" stroke="${INK}" stroke-width="2"/>`;
    case "headphones":
      return `<path d="M24 64q0-40 36-40t36 40" fill="none" stroke="${INK}" stroke-width="4"/><rect x="16" y="56" width="12" height="20" rx="5" fill="#8fb9ea" stroke="${INK}" stroke-width="2"/><rect x="92" y="56" width="12" height="20" rx="5" fill="#8fb9ea" stroke="${INK}" stroke-width="2"/>`;
    case "flower":
      return `<g transform="translate(84 ${top + 2})"><circle r="5" cx="0" cy="-6" fill="#fff8ef"/><circle r="5" cx="6" cy="0" fill="#fff8ef"/><circle r="5" cx="0" cy="6" fill="#fff8ef"/><circle r="5" cx="-6" cy="0" fill="#fff8ef"/><circle r="4" fill="#fde9a6" stroke="${INK}" stroke-width="1.5"/></g>`;
  }
}

/** Returns a standalone SVG document for an avatar wearing an expression. */
export function avatarSvg(avatar: Partial<Avatar>, expression: Expression = "content", size = 120): string {
  const a = Avatar.parse(avatar);
  const [fill, edge] = FILL[a.color];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">${body(a.base, fill, edge)}${face(expression)}${accessory(a.accessory, a.base)}</svg>`;
}

export function avatarDataUrl(avatar: Partial<Avatar>, expression: Expression = "content", size = 120): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg(avatar, expression, size))}`;
}
