import { COLOR_HEX, type Avatar, type AvatarShape } from "@northbot/shared";

/**
 * Pixel-art office sprites, generated from an agent's look: one of the 10 geometric shapes in
 * one of the 15 colours, with two dot eyes, little feet and a few effect pixels. Pure functions:
 * a frame is a grid of colours (or null for transparent), drawn later at any scale.
 */

export const W = 24;
export const H = 30;
const BODY = 16;
const BODY_X = 4;
const BODY_Y = 9;

export const ANIMS = ["idle", "walk", "typing", "browsing", "carry", "sleep", "bounce", "dizzy", "wait", "talk", "present", "held", "blocked"] as const;
export type Anim = (typeof ANIMS)[number];
export type Eyes = "dots" | "happy" | "closed" | "x" | "wide" | "angry" | "sad";

export interface Frame {
  w: number;
  h: number;
  px: (string | null)[];
}

const INK = "#2e2a40";
const WHITE = "#fff7ec";
const PAPER_EDGE = "#c9b79c";
const HEART = "#ff6b8b";
const STAR = "#f9e46b";
const KEY = "#8d8aa0";
const GLOW = "#7fdbff";

/** Mood → eye style. */
export function eyesFor(mood: string): Eyes {
  if (["proud", "hearts", "content"].includes(mood)) return mood === "content" ? "dots" : "happy";
  if (mood === "sleepy") return "closed";
  if (mood === "dizzy") return "x";
  if (["worried", "overwhelmed", "impatient", "confused"].includes(mood)) return "wide";
  if (["grumpy", "annoyed"].includes(mood)) return "angry";
  if (["sad", "embarrassed"].includes(mood)) return "sad";
  return "dots";
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount))));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

type Pt = [number, number];
const regular = (n: number, r: number, rotate = -90): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const a = ((rotate + (360 / n) * i) * Math.PI) / 180;
    return [0.5 + r * Math.cos(a), 0.54 + r * Math.sin(a)];
  });
const starPts = (outer: number, inner: number): Pt[] =>
  Array.from({ length: 10 }, (_, i) => {
    const a = ((-90 + 36 * i) * Math.PI) / 180;
    const r = i % 2 === 0 ? outer : inner;
    return [0.5 + r * Math.cos(a), 0.56 + r * Math.sin(a)];
  });

function inPolygon(x: number, y: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is the unit point (0..1) inside the shape? Matches the shapes of the SVG avatars. */
export function insideShape(shape: AvatarShape, x: number, y: number): boolean {
  const dx = x - 0.5;
  const dy = y - 0.5;
  switch (shape) {
    case "circle":
      return dx * dx + dy * dy <= 0.235;
    case "square": {
      const c = Math.abs(dx) <= 0.44 && Math.abs(dy) <= 0.44;
      return c && !(Math.abs(dx) > 0.38 && Math.abs(dy) > 0.38);
    }
    case "triangle":
      return inPolygon(x, y, [
        [0.5, 0.04],
        [0.98, 0.94],
        [0.02, 0.94],
      ]);
    case "diamond":
      return Math.abs(dx) + Math.abs(dy) <= 0.5;
    case "pentagon":
      return inPolygon(x, y, regular(5, 0.5));
    case "hexagon":
      return inPolygon(x, y, regular(6, 0.5, 0));
    case "octagon":
      return inPolygon(x, y, regular(8, 0.5, 22.5));
    case "star":
      return inPolygon(x, y, starPts(0.54, 0.27));
    case "capsule": {
      if (Math.abs(dy) > 0.32) return false;
      const ex = Math.max(0, Math.abs(dx) - 0.18);
      return ex * ex + dy * dy <= 0.32 * 0.32;
    }
    case "semicircle":
      return y >= 0.18 && y <= 0.88 && dx * dx + (y - 0.88) * (y - 0.88) <= 0.49;
  }
}

/** Where the eyes sit on each shape (unit coordinates) and how far apart. */
const EYES: Record<AvatarShape, { y: number; dx: number }> = {
  circle: { y: 0.45, dx: 0.16 },
  square: { y: 0.42, dx: 0.17 },
  triangle: { y: 0.6, dx: 0.13 },
  diamond: { y: 0.47, dx: 0.13 },
  pentagon: { y: 0.5, dx: 0.15 },
  hexagon: { y: 0.48, dx: 0.16 },
  octagon: { y: 0.47, dx: 0.17 },
  star: { y: 0.55, dx: 0.1 },
  capsule: { y: 0.47, dx: 0.17 },
  semicircle: { y: 0.66, dx: 0.17 },
};

class Grid {
  px: (string | null)[] = new Array(W * H).fill(null);
  set(x: number, y: number, c: string): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi >= 0 && xi < W && yi >= 0 && yi < H) this.px[yi * W + xi] = c;
  }
  get(x: number, y: number): string | null {
    return x >= 0 && x < W && y >= 0 && y < H ? (this.px[y * W + x] ?? null) : null;
  }
  /** Draws a tiny glyph given as rows of "#" (colour) and "." (skip). */
  glyph(x: number, y: number, rows: string[], c: string): void {
    rows.forEach((row, j) => [...row].forEach((ch, i) => ch === "#" && this.set(x + i, y + j, c)));
  }
}

interface Pose {
  /** Squash/stretch around the feet. */
  sx: number;
  sy: number;
  /** Offsets in pixels. */
  ox: number;
  oy: number;
  feet: "stand" | "left" | "right" | "dangle" | "none";
  mouth: boolean;
}

function drawBody(g: Grid, look: Avatar, pose: Pose, eyes: Eyes): { top: number; cx: number } {
  const { fill, edge } = COLOR_HEX[look.color];
  const light = shade(fill, 0.35);
  const dark = shade(fill, -0.18);
  const w = Math.round(BODY * pose.sx);
  const h = Math.round(BODY * pose.sy);
  const left = BODY_X + Math.round((BODY - w) / 2) + pose.ox;
  const bottom = BODY_Y + BODY + pose.oy;
  const top = bottom - h;
  const mask: boolean[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask.push(insideShape(look.shape, (x + 0.5) / w, (y + 0.5) / h));
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      const rim = !at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1);
      // Light from the top left: a highlight there, a soft shadow at the bottom right.
      const c = rim ? edge : !at(x - 1, y - 1) || !at(x - 2, y - 2) ? light : !at(x + 2, y + 2) || !at(x + 1, y + 2) ? dark : fill;
      g.set(left + x, top + y, c);
    }
  }
  const e = EYES[look.shape];
  const ey = top + Math.round(e.y * h) - 1;
  const lx = left + Math.round((0.5 - e.dx) * w) - 1;
  const rx = left + Math.round((0.5 + e.dx) * w);
  for (const x of [lx, rx]) {
    switch (eyes) {
      case "dots":
        g.set(x, ey, INK);
        g.set(x, ey + 1, INK);
        break;
      case "wide":
        g.glyph(x, ey - 1, ["#", "#", "#"], INK);
        g.set(x + (x === lx ? 1 : -1), ey - 1, WHITE);
        break;
      case "happy":
        g.glyph(x - 1, ey, [".#.", "#.#"], INK);
        break;
      case "closed":
        g.glyph(x - 1, ey + 1, ["###"], INK);
        break;
      case "x":
        g.glyph(x - 1, ey - 1, ["#.#", ".#.", "#.#"], INK);
        break;
      case "angry":
        g.set(x, ey, INK);
        g.set(x, ey + 1, INK);
        g.glyph(x - 1, ey - 2, x === lx ? ["#.."] : ["..#"], INK);
        g.set(x, ey - 2, INK);
        break;
      case "sad":
        g.set(x, ey + 1, INK);
        g.glyph(x - 1, ey - 1, x === lx ? ["..#"] : ["#.."], INK);
        break;
    }
  }
  if (pose.mouth) g.glyph(Math.round((lx + rx) / 2), ey + 3, ["#"], INK);
  const feetY = bottom;
  const cx = left + Math.floor(w / 2);
  const foot = (x: number, y: number) => g.glyph(x, y, ["##"], shade(edge, -0.2));
  const FEET: Record<Pose["feet"], [number, number][]> = {
    stand: [
      [-4, 0],
      [2, 0],
    ],
    left: [
      [-5, 0],
      [2, -1],
    ],
    right: [
      [-4, -1],
      [3, 0],
    ],
    dangle: [
      [-3, 1],
      [1, 2],
    ],
    none: [],
  };
  for (const [dx, dy] of FEET[pose.feet]) foot(cx + dx, feetY + dy);
  return { top, cx };
}

const P = (over: Partial<Pose> = {}): Pose => ({ sx: 1, sy: 1, ox: 0, oy: 0, feet: "stand", mouth: false, ...over });

/** Body poses per animation frame. */
const POSES: Record<Anim, Pose[]> = {
  idle: [P(), P({ sy: 0.94, sx: 1.04 })],
  walk: [P({ feet: "left", oy: -1 }), P({ feet: "stand", sy: 0.94, sx: 1.05 }), P({ feet: "right", oy: -1 }), P({ feet: "stand", sy: 0.94, sx: 1.05 })],
  typing: [P({ sy: 0.96 }), P({ sy: 0.96, oy: -1 })],
  browsing: [P({ sy: 0.96 }), P({ sy: 0.96, ox: 1 })],
  carry: [P({ feet: "left", oy: -1 }), P({ sy: 0.94, sx: 1.05 }), P({ feet: "right", oy: -1 }), P({ sy: 0.94, sx: 1.05 })],
  sleep: [P({ sy: 0.82, sx: 1.12, feet: "none" }), P({ sy: 0.8, sx: 1.14, feet: "none" }), P({ sy: 0.82, sx: 1.12, feet: "none" })],
  bounce: [P({ sy: 0.82, sx: 1.16 }), P({ oy: -3, sy: 1.08, sx: 0.92, feet: "dangle" }), P({ oy: -5, feet: "dangle" }), P({ oy: -3, sy: 1.08, sx: 0.92, feet: "dangle" })],
  dizzy: [P({ ox: -1 }), P({ sy: 0.96 }), P({ ox: 1 }), P({ sy: 0.96 })],
  wait: [P({ ox: -1 }), P({ ox: 1 })],
  talk: [P({ mouth: true }), P({ mouth: false, sy: 0.97 })],
  present: [P({ mouth: true, oy: -1 }), P({ mouth: false })],
  held: [P({ sy: 1.12, sx: 0.88, feet: "dangle", ox: -1, oy: -2 }), P({ sy: 1.12, sx: 0.88, feet: "dangle", ox: 1, oy: -2 })],
  blocked: [P(), P({ ox: 1 })],
};

/** Effect pixels drawn around the body for each animation frame. */
function effects(g: Grid, anim: Anim, i: number, top: number, cx: number): void {
  switch (anim) {
    case "typing":
      g.glyph(cx - 4, BODY_Y + BODY + 1, ["#########"], KEY);
      g.set(cx - 3 + ((i * 5) % 8), BODY_Y + BODY, i % 2 ? WHITE : STAR);
      break;
    case "browsing":
      g.glyph(cx - 4, BODY_Y + BODY - 1, ["#########", "#########"], i % 2 ? GLOW : shade(GLOW, -0.2));
      break;
    case "carry":
      // An envelope above the head: paper, then its edge and the flap's V.
      g.glyph(cx - 3, top - 6, ["#######", "#######", "#######", "#######"], WHITE);
      g.glyph(cx - 3, top - 6, ["#######", "##...##", "#.#.#.#", "#######"], PAPER_EDGE);
      break;
    case "sleep": {
      const y = top - 3 - i * 2;
      g.glyph(cx + 4 + i, y, ["###", "..#", ".#.", "###"], WHITE);
      break;
    }
    case "dizzy": {
      const orbit: Pt[] = [
        [-6, -2],
        [0, -4],
        [6, -2],
        [0, -1],
      ];
      for (const k of [0, 2]) {
        const [x, y] = orbit[(i + k) % 4]!;
        g.glyph(cx + x - 1, top + y - 1, [".#.", "###", ".#."], STAR);
      }
      break;
    }
    case "bounce":
      if (i > 0) g.glyph(cx + 5, top - 2 - i, [".#.#.", "#####", ".###.", "..#.."], HEART);
      break;
    case "wait":
      for (let k = 0; k <= i + 1; k++) g.set(cx - 2 + k * 2, top - 3, WHITE);
      break;
    case "present":
      g.glyph(cx + 7, top + 2 - i, ["#", "#", "#"], STAR);
      break;
    case "blocked":
      g.glyph(cx - 1, top - 6, ["##", "##", "##", "..", "##"], HEART);
      break;
    default:
      break;
  }
}

/** All frames of one animation for one look. */
export function frames(look: Avatar, anim: Anim, eyes: Eyes = "dots"): Frame[] {
  return POSES[anim].map((pose, i) => {
    const g = new Grid();
    const faceFor: Eyes = anim === "sleep" ? "closed" : anim === "dizzy" ? "x" : anim === "held" && eyes === "dots" ? "wide" : eyes;
    const { top, cx } = drawBody(g, look, pose, faceFor);
    effects(g, anim, i, top, cx);
    return { w: W, h: H, px: g.px };
  });
}

/** Frames per second for each animation. */
export const FPS: Record<Anim, number> = {
  idle: 2,
  walk: 8,
  typing: 6,
  browsing: 3,
  carry: 8,
  sleep: 1.5,
  bounce: 8,
  dizzy: 8,
  wait: 2,
  talk: 5,
  present: 3,
  held: 4,
  blocked: 3,
};

/** The office cat: sitting and looking around, or curled up napping. */
export function catFrames(mood: "curious" | "napping"): Frame[] {
  const ginger = "#f2a65a";
  const edge = "#a8642e";
  const sit = [
    "..#.....#....",
    "..##...##....",
    "..#######....",
    "..#.#.#.#....",
    "..#######..#.",
    "...#####...#.",
    "..#######.#..",
    "..########...",
    "..#######....",
    "...#...#.....",
  ];
  const nap = ["", "", "", "", "....#..#.....", "...######....", "..########...", ".##########..", ".###########.", "..##########."];
  const rows = mood === "napping" ? nap : sit;
  const make = (shift: number, blink: boolean, z: number): Frame => {
    const g = new Grid();
    rows.forEach((row, j) =>
      [...row].forEach((ch, i) => {
        if (ch !== "#") return;
        const isEye = mood === "curious" && j === 3 && (i === 3 || i === 7);
        const isRim = i === 0 || row[i - 1] !== "#" || row[i + 1] !== "#" || j === rows.length - 1;
        g.set(i + 5 + shift, j + 18, isEye ? (blink ? edge : INK) : isRim ? edge : ginger);
      }),
    );
    if (mood === "napping") g.glyph(15, 14 - z, ["##", ".#", "##"], WHITE);
    return { w: W, h: H, px: g.px };
  };
  return mood === "napping" ? [make(0, false, 0), make(0, false, 1), make(0, false, 2)] : [make(0, false, 0), make(0, true, 0), make(1, false, 0), make(0, false, 0)];
}

/** Draws a frame onto a canvas, `scale` screen pixels per art pixel. */
export function paint(frame: Frame, canvas: HTMLCanvasElement, scale = 1): void {
  canvas.width = frame.w * scale;
  canvas.height = frame.h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  frame.px.forEach((c, i) => {
    if (!c) return;
    ctx.fillStyle = c;
    ctx.fillRect((i % frame.w) * scale, Math.floor(i / frame.w) * scale, scale, scale);
  });
}
