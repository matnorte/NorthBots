import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { OfficeView, Zone } from "@northbot/shared";
import { deskTile, FLOOR, iso, LAYOUT, standTile, zoneAtWorld } from "./layout.js";

/**
 * The cozy office's art, drawn in code: isometric boxes with pixel-art outlines, patterned
 * floors per room, tall back walls with windows, low cream partitions with doorways, and
 * furniture. Nothing here knows about agents; the scene places them among these pieces.
 */

type Pt = { x: number; y: number };
type Tri = [number, number, number];

export const WALL_H = 92;
const SLAB = 20;
const PART_H = 22;
/** Text drawn on the back-right wall (plane j = const) or the back-left wall (plane i = const). */
export const SKEW_J = Math.atan(0.5);
export const SKEW_I = -Math.atan(0.5);

export function shade(c: number, f: number): number {
  const m = (v: number) => Math.max(0, Math.min(255, Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f))));
  return (m((c >> 16) & 255) << 16) | (m((c >> 8) & 255) << 8) | m(c & 255);
}
const tri = (c: number): Tri => [shade(c, 0.16), c, shade(c, -0.26)];
const flat = (pts: Pt[]) => pts.flatMap((p) => [p.x, p.y]);
const up = (p: Pt, h: number): Pt => ({ x: p.x, y: p.y - h });
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const LINE = { color: 0x140c10, width: 1, alpha: 0.5 };

/** Draw order between a piece and an agent: an agent is in front once it is past the near edge. */
export const depth = (i: number, j: number, w: number, d: number) => (i + j + Math.min(w, d)) * 16;

/** An isometric box: footprint (i, j, w, d) in tiles, `h` pixels tall, standing `z` pixels up. */
export function box(g: Graphics, i: number, j: number, w: number, d: number, h: number, color: number | Tri, z = 0): void {
  const [top, left, right] = typeof color === "number" ? tri(color) : color;
  const A = up(iso(i, j), z);
  const B = up(iso(i + w, j), z);
  const C = up(iso(i + w, j + d), z);
  const D = up(iso(i, j + d), z);
  if (h > 0) {
    g.poly(flat([D, C, up(C, h), up(D, h)])).fill({ color: left });
    g.poly(flat([B, C, up(C, h), up(B, h)])).fill({ color: right });
  }
  g.poly(flat([up(A, h), up(B, h), up(C, h), up(D, h)])).fill({ color: top });
  g.poly(flat([up(A, h), up(B, h), B, C, D, up(D, h)])).stroke(LINE);
  if (h > 1) g.moveTo(up(D, h).x, up(D, h).y).lineTo(up(C, h).x, up(C, h).y).lineTo(up(B, h).x, up(B, h).y).moveTo(up(C, h).x, up(C, h).y).lineTo(C.x, C.y).stroke({ ...LINE, alpha: 0.3 });
}

/** A flat panel on the plane j = const, from i0 to i1, between heights h0 and h1. */
export function faceJ(g: Graphics, i0: number, i1: number, j: number, h0: number, h1: number, color: number, alpha = 1): void {
  const a = iso(i0, j);
  const b = iso(i1, j);
  g.poly(flat([up(a, h0), up(b, h0), up(b, h1), up(a, h1)])).fill({ color, alpha });
}

/** A flat panel on the plane i = const, from j0 to j1, between heights h0 and h1. */
export function faceI(g: Graphics, j0: number, j1: number, i: number, h0: number, h1: number, color: number, alpha = 1): void {
  const a = iso(i, j0);
  const b = iso(i, j1);
  g.poly(flat([up(a, h0), up(b, h0), up(b, h1), up(a, h1)])).fill({ color, alpha });
}

/** An upright cylinder (bins, pots, round tables). */
function cyl(g: Graphics, ci: number, cj: number, r: number, h: number, side: number, top: number, z = 0): void {
  const p = up(iso(ci, cj), z);
  const rx = r * 45.25;
  const ry = r * 22.63;
  g.ellipse(p.x, p.y, rx, ry).fill({ color: shade(side, -0.2) });
  g.rect(p.x - rx, p.y - h, rx, h).fill({ color: side });
  g.rect(p.x, p.y - h, rx, h).fill({ color: shade(side, -0.2) });
  g.ellipse(p.x, p.y - h, rx, ry).fill({ color: top }).stroke(LINE);
}

/** A soft light: concentric discs that add up toward the middle (drawn with additive blending). */
export interface Glow {
  x: number;
  y: number;
  r: number;
  color: number;
  /** How strongly it shows by day (0..1); at night every light is at full strength. */
  day: number;
}
let glowTex: Texture | null = null;
/** A smooth white-to-clear radial gradient, tinted per light. */
function glowTexture(): Texture {
  if (glowTex) return glowTex;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.45)");
  grad.addColorStop(0.7, "rgba(255,255,255,0.12)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  glowTex = Texture.from(canvas);
  return glowTex;
}
export function glowSprite(l: Glow, strength: number): Sprite {
  const s = new Sprite(glowTexture());
  s.anchor.set(0.5);
  s.position.set(l.x, l.y);
  // Lights are a little wider than tall, like light pooling on an isometric floor.
  s.width = l.r * 2.2;
  s.height = l.r * 1.7;
  s.tint = l.color;
  s.alpha = Math.min(1, strength) * 0.5;
  s.blendMode = "add";
  return s;
}

// ---------- palette ----------

const WOOD: Tri = [0xa8754b, 0x8c5f3b, 0x6d482c];
const DARK_WOOD: Tri = [0x6e4a33, 0x5a3b28, 0x452d1f];
const METAL: Tri = [0x8e96a6, 0x6e7686, 0x535a69];
const SCREEN_CASE = 0x1d1f27;
const CREAM: Tri = [0xf1e6d4, 0xd9cab4, 0xb7a790];
const POST: Tri = [0x8f6a48, 0x775739, 0x5c432b];
const LEAF = [0x3f7a43, 0x569450, 0x6db35f, 0x2f5f35];
const BOOKS = [0xc9573e, 0xe0a14a, 0x5f8f6a, 0x4e74a8, 0x9b5fa8, 0xd9c27a, 0x3f8f8f];

type FloorKind = "wood" | "tile" | "steel" | "carpet" | "marble";
const FLOORS: Record<Zone, [FloorKind, number, number]> = {
  desk: ["wood", 0x6e4a32, 0x4e3322],
  browser_lab: ["tile", 0x4d5260, 0x3a3e48],
  vault: ["steel", 0x404553, 0x2f333d],
  idea_bin: ["carpet", 0x5c4a6e, 0x4a3b5a],
  post_box: ["carpet", 0x5c4a6e, 0x4a3b5a],
  mail_desk: ["carpet", 0x5c4a6e, 0x4a3b5a],
  whiteboard: ["wood", 0x8a6644, 0x6a4b30],
  meeting_room: ["wood", 0x6a452f, 0x4b3021],
  stage: ["carpet", 0x4a2a36, 0x3a1f29],
  break_room: ["wood", 0x87603f, 0x664527],
};
const HALL: [FloorKind, number, number] = ["marble", 0x4a4c55, 0x3b3d46];

const quad = (g: Graphics, i0: number, j0: number, i1: number, j1: number, color: number, alpha = 1) =>
  g.poly(flat([iso(i0, j0), iso(i1, j0), iso(i1, j1), iso(i0, j1)])).fill({ color, alpha });

function floorTile(g: Graphics, i: number, j: number): void {
  const z = zoneAtWorld(iso(i + 0.5, j + 0.5).x, iso(i + 0.5, j + 0.5).y);
  const [kind, a, b] = z ? FLOORS[z] : HALL;
  const line = (p: Pt, q: Pt, color: number, alpha: number, width = 1) => g.moveTo(p.x, p.y).lineTo(q.x, q.y).stroke({ color, alpha, width });
  switch (kind) {
    case "wood":
      // Planks run along i, four to a tile, each with its own tone and a staggered end joint.
      for (let k = 0; k < 4; k++) {
        const v = hash(i * 7 + k, j * 13 + k * 3);
        quad(g, i, j + k / 4, i + 1, j + (k + 1) / 4, v < 0.33 ? a : v < 0.66 ? shade(a, -0.07) : shade(a, 0.06));
        line(iso(i, j + k / 4), iso(i + 1, j + k / 4), b, 0.75);
        const o = 0.15 + hash(j * 5 + k, i * 3) * 0.7;
        line(iso(i + o, j + k / 4), iso(i + o, j + (k + 1) / 4), b, 0.6);
      }
      break;
    case "tile":
      quad(g, i, j, i + 1, j + 1, hash(i, j) < 0.5 ? a : shade(a, -0.05));
      g.poly(flat([iso(i, j), iso(i + 1, j), iso(i + 1, j + 1), iso(i, j + 1)])).stroke({ color: b, width: 1.5 });
      break;
    case "steel": {
      quad(g, i, j, i + 1, j + 1, (i + j) % 2 ? a : shade(a, -0.1));
      for (const [di, dj] of [[0.12, 0.12], [0.88, 0.12], [0.88, 0.88], [0.12, 0.88]] as const) {
        const p = iso(i + di, j + dj);
        g.circle(p.x, p.y, 1.3).fill({ color: shade(a, 0.25) });
      }
      break;
    }
    case "carpet":
      quad(g, i, j, i + 1, j + 1, a);
      for (let k = 0; k < 5; k++) {
        const di = hash(i * 3 + k, j) * 0.85;
        const dj = hash(i, j * 3 + k) * 0.85;
        quad(g, i + di, j + dj, i + di + 0.08, j + dj + 0.08, b);
      }
      break;
    case "marble": {
      quad(g, i, j, i + 1, j + 1, (i + j) % 2 ? a : b);
      if (hash(i, j) > 0.45) {
        const p = iso(i + hash(i + 1, j) * 0.8 + 0.1, j + 0.1);
        const q = iso(i + hash(i, j + 1) * 0.8 + 0.1, j + 0.9);
        line(p, q, shade(a, 0.3), 0.35);
      }
      line(iso(i, j), iso(i + 1, j), 0x2b2c33, 0.5);
      line(iso(i, j), iso(i, j + 1), 0x2b2c33, 0.5);
      break;
    }
  }
}

/** Rugs and the stage platform: flat things agents walk over. */
function floorItems(g: Graphics): void {
  // Open office: a big green rug.
  quad(g, 0.55, 0.65, 7.6, 5.6, 0x3c5442);
  g.poly(flat([iso(0.75, 0.85), iso(7.4, 0.85), iso(7.4, 5.4), iso(0.75, 5.4)])).stroke({ color: 0x7c9a63, width: 2, alpha: 0.8 });
  // Meeting room: a round navy rug.
  const m = iso(2.5, 10.1);
  g.ellipse(m.x, m.y, 2.0 * 45.25, 2.0 * 22.63).fill({ color: 0x2e3b5c });
  g.ellipse(m.x, m.y, 1.75 * 45.25, 1.75 * 22.63).stroke({ color: 0x9aa8cf, width: 2, alpha: 0.7 });
  // Break room: a rust rug with a gold border.
  quad(g, 11.6, 8.8, 15.4, 11.9, 0x7a4434);
  g.poly(flat([iso(11.8, 9.0), iso(15.2, 9.0), iso(15.2, 11.7), iso(11.8, 11.7)])).stroke({ color: 0xd6a35c, width: 2, alpha: 0.85 });
  // Stage: a raised red platform with a step.
  box(g, 5.8, 8.6, 4.4, 2.7, 10, [0x9c3445, 0x6e2632, 0x55202a]);
  box(g, 7.5, 11.3, 1.0, 0.35, 5, [0x9c3445, 0x6e2632, 0x55202a]);
  // A welcome mat at the hallway's front door.
  quad(g, 8.05, 6.1, 8.95, 6.9, 0x6b3f33);
}

function outerWalls(g: Graphics): void {
  const W = FLOOR.cols;
  const H = FLOOR.rows;
  const T = 0.2;
  // Back-right wall (plane j = 0) and back-left wall (plane i = 0): wallpaper, wainscot, trims.
  faceJ(g, 0, W, 0, 0, WALL_H, 0x6a4248);
  faceI(g, 0, H, 0, 0, WALL_H, 0x5a383e);
  for (let k = 0.5; k < W; k += 0.5) faceJ(g, k - 0.015, k + 0.015, 0, 30, WALL_H - 8, 0x5e3a40, 0.6);
  for (let k = 0.5; k < H; k += 0.5) faceI(g, k - 0.015, k + 0.015, 0, 30, WALL_H - 8, 0x4f3137, 0.6);
  faceJ(g, 0, W, 0, 0, 28, 0x4c2d34);
  faceI(g, 0, H, 0, 0, 28, 0x412630);
  faceJ(g, 0, W, 0, 28, 31, 0x9a6a64);
  faceI(g, 0, H, 0, 28, 31, 0x86595a);
  faceJ(g, 0, W, 0, 0, 4, 0x2c1a1f);
  faceI(g, 0, H, 0, 0, 4, 0x26161b);
  faceJ(g, 0, W, 0, WALL_H - 7, WALL_H, 0x7d5052);
  faceI(g, 0, H, 0, WALL_H - 7, WALL_H, 0x6c4446);
  // Wall caps and the open ends.
  const cap = 0x3a2328;
  g.poly(flat([up(iso(0, 0), WALL_H), up(iso(W, 0), WALL_H), up(iso(W, -T), WALL_H), up(iso(-T, -T), WALL_H)])).fill({ color: cap });
  g.poly(flat([up(iso(0, 0), WALL_H), up(iso(0, H), WALL_H), up(iso(-T, H), WALL_H), up(iso(-T, -T), WALL_H)])).fill({ color: cap });
  g.poly(flat([iso(W, 0), iso(W, -T), up(iso(W, -T), WALL_H), up(iso(W, 0), WALL_H)])).fill({ color: 0x2f1c21 });
  g.poly(flat([iso(0, H), iso(-T, H), up(iso(-T, H), WALL_H), up(iso(0, H), WALL_H)])).fill({ color: 0x3a2228 });
  // The floor slab's front edges, like a diorama.
  const down = (p: Pt): Pt => ({ x: p.x, y: p.y + SLAB });
  g.poly(flat([iso(-T, H), iso(W, H), down(iso(W, H)), down(iso(-T, H))])).fill({ color: 0x2b1b21 });
  g.poly(flat([iso(W, -T), iso(W, H), down(iso(W, H)), down(iso(W, -T))])).fill({ color: 0x211418 });
  g.moveTo(iso(-T, H).x, iso(-T, H).y).lineTo(iso(W, H).x, iso(W, H).y).lineTo(iso(W, -T).x, iso(W, -T).y).stroke({ color: 0x8a5d4d, width: 1.5, alpha: 0.6 });
}

/** Wall decorations that never change: deposit boxes, the dashboard wall, frames. */
function wallDecor(g: Graphics, glows: Glow[]): void {
  // Vault: rows of safe-deposit boxes on its back wall.
  for (let c = 0; c < 6; c++) {
    for (let r = 0; r < 5; r++) {
      const i0 = 13.15 + c * 0.46;
      faceJ(g, i0, i0 + 0.42, 0, 8 + r * 13, 19 + r * 13, r % 2 ? 0x7b8291 : 0x858c9b);
      faceJ(g, i0 + 0.18, i0 + 0.24, 0, 12 + r * 13, 15 + r * 13, 0xd9b45a);
    }
  }
  // Browser lab: a dark wall of dashboards above the desk.
  faceJ(g, 9.35, 12.7, 0, 56, 84, 0x14161c);
  const panels: [number, number, number][] = [
    [9.45, 10.5, 0x1f4d7a],
    [10.6, 11.6, 0x24604a],
    [11.7, 12.6, 0x5a2f6b],
  ];
  for (const [a, b, c] of panels) {
    faceJ(g, a, b, 0, 59, 81, c);
    for (let k = 0; k < 6; k++) {
      const x = a + 0.08 + (k * (b - a - 0.16)) / 6;
      const v = 62 + hash(a * 10 + k, b) * 14;
      faceJ(g, x, x + 0.1, 0, 61, v, shade(c, 0.45));
    }
    const mid = (a + b) / 2;
    glows.push({ ...up(iso(mid, 0.4), 70), r: 46, color: shade(c, 0.4), day: 0.3 });
  }
  // Open office: picture frames between the windows.
  faceJ(g, 6.2, 6.7, 0, 50, 70, 0x8a5a3a);
  faceJ(g, 6.25, 6.65, 0, 53, 67, 0xe0a86a);
  faceJ(g, 6.3, 6.6, 0, 55, 61, 0x4e74a8);
}

export interface WindowSpec {
  plane: "i" | "j";
  a: number;
  b: number;
}
export const WINDOWS: WindowSpec[] = [
  { plane: "j", a: 0.8, b: 2.4 },
  { plane: "j", a: 7.0, b: 7.9 },
  { plane: "i", a: 1.3, b: 2.9 },
  { plane: "i", a: 6.1, b: 6.9 },
];
const SKY: Record<OfficeView["dayPhase"], [number, number]> = {
  dawn: [0xf7a69a, 0xffd3a1],
  day: [0x8fcaf2, 0xc9e8ff],
  dusk: [0xe9774f, 0x6a3f7a],
  night: [0x101a3a, 0x1d2a55],
};

/** Windows show the sky for the time of day (redrawn when the phase changes). */
export function drawWindows(g: Graphics, phase: OfficeView["dayPhase"]): void {
  g.clear();
  const [top, low] = SKY[phase];
  for (const w of WINDOWS) {
    const face = w.plane === "j" ? (a: number, b: number, h0: number, h1: number, c: number, al = 1) => faceJ(g, a, b, 0, h0, h1, c, al) : (a: number, b: number, h0: number, h1: number, c: number, al = 1) => faceI(g, a, b, 0, h0, h1, c, al);
    face(w.a - 0.05, w.b + 0.05, 34, 80, 0x7a4e33);
    face(w.a, w.b, 38, 76, top);
    face(w.a, w.b, 38, 52, low);
    if (phase === "night") {
      for (let k = 0; k < 6; k++) {
        const x = w.a + 0.1 + hash(w.a * 9 + k, w.b) * (w.b - w.a - 0.2);
        const h = 50 + hash(w.b + k, w.a * 3) * 22;
        face(x, x + 0.03, h, h + 2, 0xfdf6c8);
      }
    }
    const mid = (w.a + w.b) / 2;
    face(mid - 0.025, mid + 0.025, 38, 76, 0x7a4e33);
    face(w.a, w.b, 56, 58, 0x7a4e33);
    face(w.a - 0.1, w.b + 0.1, 32, 35, 0x9b6a45);
    // Curtains and their rod.
    face(w.a - 0.32, w.a + 0.02, 26, 84, 0xa4553c);
    face(w.b - 0.02, w.b + 0.32, 26, 84, 0x8f4733);
    face(w.a - 0.36, w.b + 0.36, 84, 86, 0x3a2a24);
  }
}
export function windowGlows(phase: OfficeView["dayPhase"]): Glow[] {
  const color = phase === "night" ? 0x6f8cff : phase === "day" ? 0xfff0c4 : 0xffb07a;
  return WINDOWS.map((w) => {
    const mid = (w.a + w.b) / 2;
    const p = w.plane === "j" ? iso(mid, 0.9) : iso(0.9, mid);
    return { x: p.x, y: p.y - 20, r: 70 + (w.b - w.a) * 20, color, day: phase === "night" ? 0.4 : 0.8 };
  });
}

// ---------- furniture ----------

function piece(z: number, draw: (g: Graphics) => void): Container {
  const c = new Container();
  const g = new Graphics();
  draw(g);
  c.addChild(g);
  c.zIndex = z;
  return c;
}

function plant(i: number, j: number, size = 1): Container {
  return piece(depth(i - 0.2, j - 0.2, 0.4, 0.4), (g) => {
    cyl(g, i, j, 0.17 * size, 15 * size, 0xb5653f, 0x5a3a2a);
    const p = up(iso(i, j), 15 * size);
    const blobs: [number, number, number, number][] = [
      [0, -14, 11, 3],
      [-9, -8, 9, 0],
      [9, -9, 9, 1],
      [-4, -22, 9, 2],
      [6, -20, 8, 1],
      [0, -4, 8, 0],
    ];
    for (const [dx, dy, r, c] of blobs) g.circle(p.x + dx * size, p.y + dy * size, r * size).fill({ color: LEAF[c]! }).stroke({ ...LINE, alpha: 0.25 });
  });
}

function floorLamp(i: number, j: number, glows: Glow[]): Container {
  const p = iso(i, j);
  glows.push({ x: p.x, y: p.y - 62, r: 110, color: 0xffc46b, day: 0.35 });
  return piece(depth(i - 0.15, j - 0.15, 0.3, 0.3), (g) => {
    cyl(g, i, j, 0.14, 3, 0x3a2a24, 0x4a3830);
    g.rect(p.x - 1.5, p.y - 62, 3, 60).fill({ color: 0x3a2a24 });
    g.poly([p.x - 14, p.y - 58, p.x + 14, p.y - 58, p.x + 9, p.y - 76, p.x - 9, p.y - 76]).fill({ color: 0xf3d48c }).stroke(LINE);
    g.rect(p.x - 14, p.y - 59, 28, 2).fill({ color: 0xd9a35a });
  });
}

function chair(ci: number, cj: number, color: number, back: "front" | "back", z?: number): Container {
  return piece(z ?? depth(ci - 0.2, cj - 0.2, 0.4, 0.4), (g) => {
    box(g, ci - 0.03, cj - 0.03, 0.06, 0.06, 12, 0x2a2a30);
    box(g, ci - 0.18, cj - 0.18, 0.36, 0.36, 2, 0x2a2a30);
    box(g, ci - 0.2, cj - 0.2, 0.4, 0.4, 4, color, 12);
    if (back === "front") box(g, ci - 0.2, cj + 0.13, 0.4, 0.07, 9, shade(color, -0.1), 16);
    else box(g, ci - 0.2, cj - 0.2, 0.4, 0.07, 16, shade(color, -0.1), 16);
  });
}

/** One agent's desk (monitor, keyboard, mug) and its chair, which the agent sits in. */
export function makeDesk(order: number): { desk: Container; chair: Container; glow: Glow } {
  const [di, dj] = deskTile(order);
  const [si, sj] = standTile("desk", order, 0);
  const screen = [0x58c4ff, 0x6ee7a8, 0xf5a3c7, 0xf9e46b][order % 4]!;
  const desk = piece(depth(di - 0.1, dj - 0.2, 1.3, 0.6), (g) => {
    for (const [li, lj] of [
      [di - 0.06, dj - 0.16],
      [di + 1.1, dj - 0.16],
      [di - 0.06, dj + 0.3],
      [di + 1.1, dj + 0.3],
    ] as const)
      box(g, li, lj, 0.07, 0.07, 18, DARK_WOOD);
    box(g, di - 0.1, dj - 0.2, 1.3, 0.6, 4, WOOD, 18);
    box(g, di + 0.5, dj - 0.11, 0.1, 0.07, 8, 0x2a2a33, 22);
    box(g, di + 0.2, dj - 0.17, 0.72, 0.07, 24, SCREEN_CASE, 28);
    faceJ(g, di + 0.24, di + 0.88, dj - 0.1, 31, 49, shade(screen, -0.55));
    for (let k = 0; k < 4; k++) {
      const w = 0.15 + hash(order, k) * 0.35;
      faceJ(g, di + 0.3, di + 0.3 + w, dj - 0.1, 45 - k * 4, 46.5 - k * 4, screen);
    }
    box(g, di + 0.3, dj + 0.1, 0.52, 0.15, 1.5, [0xe2e5ec, 0xb9bdc8, 0x9a9eaa], 22);
    cyl(g, di + 1.0, dj + 0.05, 0.05, 6, 0xe8e2d6, 0x6b4a2f, 22);
    if (order % 3 === 0) box(g, di - 0.02, dj + 0.05, 0.25, 0.18, 2, [0xfaf6ee, 0xd8d2c6, 0xc0b9ad], 22);
  });
  // The chair sits just in front of the agent so it reads as sitting at its desk.
  const chairBox = chair(si, sj, 0x7a5ba8, "front", iso(si, sj).y + 2);
  const p = iso(di + 0.56, dj - 0.1);
  return { desk, chair: chairBox, glow: { x: p.x, y: p.y - 40, r: 48, color: screen, day: 0.35 } };
}

export interface Decor {
  floor: Graphics;
  items: Container[];
  glows: Glow[];
  /** Server-rack lights that blink. */
  leds: Graphics[];
  clock: Text;
  calendar: Text;
  tv: Text;
  board: Text;
}

const mono = (size: number, fill: number) => ({ fontFamily: "'Press Start 2P', 'Courier New', monospace", fontSize: size, fill, lineHeight: size + 3 });

/** Everything that does not move: floor, walls, rugs and furniture. */
export function buildDecor(): Decor {
  const floor = new Graphics();
  const glows: Glow[] = [];
  const items: Container[] = [];
  const leds: Graphics[] = [];
  for (let i = 0; i < FLOOR.cols; i++) for (let j = 0; j < FLOOR.rows; j++) floorTile(floor, i, j);
  floorItems(floor);
  outerWalls(floor);
  wallDecor(floor, glows);

  // Wall clock (back wall), calendar (left wall), meeting TV (left wall).
  faceJ(floor, 3.0, 3.95, 0, 46, 66, 0x1b1416);
  faceJ(floor, 3.04, 3.91, 0, 48, 64, 0x2a1a1c);
  const clock = new Text({ text: "", style: { ...mono(11, 0xff8c42), fontWeight: "700" } });
  clock.position.copyFrom(up(iso(3.12, 0), 63));
  clock.skew.set(0, SKEW_J);
  faceI(floor, 3.4, 5.5, 0, 32, 78, 0x8e749e);
  faceI(floor, 3.45, 5.45, 0, 34, 76, 0x302639);
  const calendar = new Text({ text: "", style: { fontFamily: "Inter, sans-serif", fontSize: 8, fill: 0xe9e0f3, lineHeight: 10 } });
  calendar.position.copyFrom(up(iso(0, 5.35), 74));
  calendar.skew.set(0, SKEW_I);
  faceI(floor, 8.8, 11.4, 0, 28, 70, 0x0d0f14);
  faceI(floor, 8.9, 11.3, 0, 31, 67, 0x14304d);
  const tvP = iso(0, 10.1);
  glows.push({ x: tvP.x + 20, y: tvP.y - 48, r: 70, color: 0x4f8dff, day: 0.4 });
  const tv = new Text({ text: "", style: mono(7, 0x9cc9ff) });
  tv.position.copyFrom(up(iso(0, 11.2), 64));
  tv.skew.set(0, SKEW_I);

  // ---------- open office ----------
  items.push(
    piece(depth(4.2, 0.04, 1.45, 0.4), (g) => {
      box(g, 4.2, 0.04, 1.45, 0.4, 70, DARK_WOOD);
      for (const [h0, h1] of [[6, 22], [26, 42], [46, 62]] as const) {
        let i = 4.26;
        let k = 0;
        while (i < 5.56) {
          const w = 0.06 + hash(i * 31, h0) * 0.05;
          const bh = (h1 - h0) * (0.7 + hash(h0, i * 17) * 0.3);
          faceJ(g, i, Math.min(5.6, i + w), 0.44, h0, h0 + bh, BOOKS[(k + h0) % BOOKS.length]!);
          i += w + 0.012;
          k++;
        }
        faceJ(g, 4.2, 5.65, 0.44, h0 - 2, h0, 0x3b2619);
      }
    }),
    plant(0.45, 5.45, 1.2),
    plant(7.55, 0.5, 1.25),
    plant(3.0, 0.4, 0.9),
    floorLamp(7.45, 5.35, glows),
    piece(depth(0.1, 3.05, 0.45, 0.25), (g) => {
      // A low cabinet with a printer under the calendar.
      box(g, 0.08, 3.6, 0.45, 1.4, 24, WOOD);
      box(g, 0.12, 4.0, 0.35, 0.5, 9, [0xe4e6ea, 0xbfc3cc, 0x9ea3ad], 24);
    }),
  );

  // ---------- browser lab ----------
  items.push(
    piece(depth(9.3, 0.3, 3.1, 0.62), (g) => {
      for (const li of [9.34, 12.3]) box(g, li, 0.34, 0.07, 0.55, 18, METAL);
      box(g, 9.3, 0.3, 3.1, 0.62, 4, [0xd8dce4, 0xb3b8c3, 0x939aa6], 18);
      for (let k = 0; k < 3; k++) {
        const mi = 9.45 + k * 0.98;
        const c = [0x3fa9f5, 0x6ee7a8, 0xf5a3c7][k]!;
        box(g, mi + 0.33, 0.42, 0.1, 0.07, 8, 0x2a2a33, 22);
        box(g, mi, 0.36, 0.76, 0.07, 26, SCREEN_CASE, 28);
        faceJ(g, mi + 0.04, mi + 0.72, 0.43, 31, 51, shade(c, -0.5));
        for (let r = 0; r < 4; r++) faceJ(g, mi + 0.1, mi + 0.1 + 0.2 + hash(k, r) * 0.35, 0.43, 47 - r * 4, 48.5 - r * 4, c);
        const p = iso(mi + 0.38, 0.43);
        glows.push({ x: p.x, y: p.y - 41, r: 46, color: c, day: 0.35 });
      }
    }),
    ...[0, 1, 2].map((k) => chair(9.83 + k * 0.98, 1.25, 0x3b4a8a, "back")),
    piece(depth(12.05, 1.55, 0.8, 0.45), (g) => {
      box(g, 12.05, 1.55, 0.8, 0.45, 70, [0x3a3d47, 0x2c2f37, 0x22242b]);
      for (let r = 0; r < 8; r++) faceJ(g, 12.1, 12.8, 2.0, 6 + r * 8, 12 + r * 8, 0x1b1d23);
    }),
    plant(9.35, 3.6, 0.9),
  );
  for (let k = 0; k < 2; k++) {
    const g = new Graphics();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 4; c++) {
        if (hash(r * 4 + c, k) < 0.5) continue;
        const i0 = 12.15 + c * 0.08 + k * 0.32;
        faceJ(g, i0, i0 + 0.04, 2.0, 8 + r * 8, 10 + r * 8, [0x6ee7a8, 0x58c4ff, 0xffb36b][(r + c) % 3]!);
      }
    }
    const c = new Container();
    c.addChild(g);
    c.zIndex = depth(12.05, 1.55, 0.8, 0.45) + 1;
    leds.push(g);
    items.push(c);
  }
  const rack = iso(12.45, 2.0);
  glows.push({ x: rack.x, y: rack.y - 40, r: 40, color: 0x6ee7a8, day: 0.2 });

  // ---------- vault ----------
  items.push(
    piece(depth(13.7, 1.0, 1.5, 0.8), (g) => {
      box(g, 13.7, 1.0, 1.5, 0.8, 58, METAL);
      faceJ(g, 13.82, 15.08, 1.8, 6, 52, 0x5a6272);
      faceJ(g, 13.86, 15.04, 1.8, 9, 49, 0x67707f);
      const p = up(iso(14.45, 1.8), 30);
      g.circle(p.x, p.y, 8).fill({ color: 0xd9b45a }).stroke({ color: 0x8a6d2a, width: 1.5 });
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3;
        g.moveTo(p.x, p.y).lineTo(p.x + Math.cos(a) * 11, p.y + Math.sin(a) * 11).stroke({ color: 0xb8923f, width: 2 });
      }
      g.circle(p.x, p.y, 3).fill({ color: 0x8a6d2a });
      faceJ(g, 14.85, 14.95, 1.8, 24, 36, 0xd9b45a);
    }),
    piece(depth(15.0, 2.6, 0.5, 0.25), (g) => {
      for (let k = 0; k < 3; k++) box(g, 15.0, 2.6 + (k % 2) * 0.05, 0.5, 0.22, 5, [0xf2cf6a, 0xd9ad3f, 0xb08628], k * 5);
    }),
  );
  const safe = up(iso(14.45, 1.8), 56);
  glows.push({ x: safe.x, y: safe.y, r: 30, color: 0x6ee7a8, day: 0.4 });

  // ---------- mail nook ----------
  items.push(
    piece(depth(9.25, 4.75, 0.5, 0.5), (g) => {
      cyl(g, 9.5, 5.0, 0.26, 20, 0x8a6a45, 0x4a3828);
      for (let k = 0; k < 4; k++) {
        const p = up(iso(9.42 + (k % 2) * 0.16, 4.94 + Math.floor(k / 2) * 0.12), 22);
        g.circle(p.x, p.y, 4).fill({ color: 0xf3e3c3 }).stroke({ color: 0xa5844f, width: 1 });
      }
    }),
    piece(depth(10.25, 4.3, 0.5, 0.42), (g) => {
      box(g, 10.25, 4.3, 0.5, 0.42, 36, [0xe0574a, 0xc2463b, 0x9a352d]);
      box(g, 10.22, 4.27, 0.56, 0.48, 3, [0xf06a5c, 0xd05042, 0xa83b31], 36);
      faceJ(g, 10.35, 10.65, 4.72, 26, 28.5, 0x2a1414);
      faceJ(g, 10.38, 10.62, 4.72, 12, 20, 0xfff7ec);
    }),
    piece(depth(11.15, 4.25, 1.7, 0.55), (g) => {
      for (const li of [11.18, 12.76]) box(g, li, 4.6, 0.06, 0.06, 18, DARK_WOOD);
      box(g, 11.15, 4.25, 1.7, 0.55, 4, WOOD, 18);
      box(g, 11.2, 4.27, 1.6, 0.18, 24, DARK_WOOD, 22);
      for (let c = 0; c < 6; c++) {
        for (let r = 0; r < 3; r++) {
          const i0 = 11.25 + c * 0.255;
          faceJ(g, i0, i0 + 0.22, 4.45, 24 + r * 7.5, 30 + r * 7.5, 0x2e1d14);
          if (hash(c, r) > 0.55) faceJ(g, i0 + 0.03, i0 + 0.19, 4.45, 25 + r * 7.5, 28 + r * 7.5, 0xfff7ec);
        }
      }
    }),
    piece(depth(12.45, 5.3, 0.35, 0.35), (g) => {
      const p = iso(12.6, 5.45);
      g.ellipse(p.x, p.y - 9, 15, 12).fill({ color: 0xc9a46a }).stroke(LINE);
      g.ellipse(p.x, p.y - 20, 8, 4).fill({ color: 0xa8844e });
    }),
  );

  // ---------- whiteboard nook ----------
  items.push(
    piece(depth(13.2, 4.15, 2.6, 0.12), (g) => {
      for (const li of [13.32, 15.62]) box(g, li, 4.18, 0.06, 0.08, 28, METAL);
      faceJ(g, 13.18, 15.82, 4.26, 26, 84, 0xa9afb8);
      faceJ(g, 13.24, 15.76, 4.26, 29, 81, 0xf4f3ee);
      faceJ(g, 13.3, 15.7, 4.26, 26, 28, 0x7a808a);
      faceJ(g, 13.5, 13.7, 4.27, 27, 29, 0xe0574a);
      faceJ(g, 13.75, 13.95, 4.27, 27, 29, 0x4e74a8);
    }),
    plant(15.6, 5.6, 1),
  );
  const board = new Text({ text: "", style: { fontFamily: "Nunito, sans-serif", fontSize: 7, fill: 0x2e2a40, lineHeight: 9, fontWeight: "700" } });
  board.position.copyFrom(up(iso(13.32, 4.26), 79));
  board.skew.set(0, SKEW_J);
  const boardHolder = new Container();
  boardHolder.addChild(board);
  boardHolder.zIndex = depth(13.2, 4.15, 2.6, 0.12) + 1;
  items.push(boardHolder);

  // ---------- hallway ----------
  items.push(
    plant(8.5, 0.45, 1.1),
    plant(8.5, 5.55, 0.9),
    plant(0.4, 6.5, 1),
    piece(depth(15.35, 6.2, 0.4, 0.4), (g) => {
      box(g, 15.35, 6.2, 0.4, 0.4, 30, [0xe9edf2, 0xc5cbd4, 0xa4abb6]);
      cyl(g, 15.55, 6.4, 0.15, 18, 0x7fc4f0, 0xb8e2fb, 30);
    }),
  );

  // ---------- meeting room ----------
  items.push(
    ...Array.from({ length: 6 }, (_, k) => {
      const a = (k * Math.PI) / 3 + Math.PI / 6;
      const ci = 2.5 + Math.cos(a) * 1.15;
      const cj = 10.1 + Math.sin(a) * 1.15;
      // Backs face away from the table.
      return chair(ci, cj, 0x2f3c66, Math.sin(a) + Math.cos(a) > 0 ? "front" : "back");
    }),
    piece(iso(2.5, 10.1).y, (g) => {
      cyl(g, 2.5, 10.1, 0.14, 16, 0x3a2a20, 0x3a2a20);
      cyl(g, 2.5, 10.1, 0.82, 4, 0x5b3a26, 0x7d5537, 16);
      const p = up(iso(2.5, 10.1), 20);
      g.ellipse(p.x, p.y, 0.55 * 45.25, 0.55 * 22.63).stroke({ color: 0xa3784f, width: 1, alpha: 0.6 });
      for (let k = 0; k < 4; k++) {
        const q = up(iso(2.5 + Math.cos(k * 1.6) * 0.45, 10.1 + Math.sin(k * 1.6) * 0.45), 20);
        g.rect(q.x - 4, q.y - 2, 8, 4).fill({ color: 0xfaf6ee });
      }
    }),
    plant(4.55, 7.45, 1),
    plant(0.45, 12.5, 1.1),
  );

  // ---------- stage ----------
  items.push(
    piece(depth(6.1, 7.4, 3.8, 0.12), (g) => {
      for (const li of [6.25, 9.7]) box(g, li, 7.42, 0.06, 0.06, 26, 0x2a2a30);
      faceJ(g, 6.1, 9.9, 7.5, 24, 88, 0x0f1420);
      faceJ(g, 6.2, 9.8, 7.5, 28, 84, 0x1c3a66);
      faceJ(g, 6.2, 9.8, 7.5, 28, 40, 0x24508a);
    }),
    piece(depth(5.75, 7.4, 0.35, 0.35), (g) => box(g, 5.75, 7.4, 0.35, 0.35, 34, [0x2f2f37, 0x24242b, 0x1b1b21])),
    piece(depth(9.95, 7.4, 0.35, 0.35), (g) => box(g, 9.95, 7.4, 0.35, 0.35, 34, [0x2f2f37, 0x24242b, 0x1b1b21])),
  );
  const talks = new Text({ text: "NORTHBOT TALKS", style: { ...mono(10, 0xe9e0f3), fontWeight: "700", letterSpacing: 1 } });
  talks.position.copyFrom(up(iso(6.55, 7.5), 66));
  talks.skew.set(0, SKEW_J);
  const talksHolder = new Container();
  talksHolder.addChild(talks);
  talksHolder.zIndex = depth(6.1, 7.4, 3.8, 0.12) + 1;
  items.push(talksHolder);
  const scr = iso(8, 7.5);
  glows.push({ x: scr.x, y: scr.y - 56, r: 110, color: 0x4f8dff, day: 0.35 });
  for (const [i, j, c] of [
    [6.6, 9.6, 0xff6bd5],
    [9.3, 9.6, 0xffd36b],
  ] as const) {
    const p = iso(i, j);
    glows.push({ x: p.x, y: p.y - 6, r: 64, color: c, day: 0.25 });
  }

  // ---------- break room ----------
  const SOFA = 0x5e4f8f;
  items.push(
    piece(depth(12.0, 7.35, 2.6, 0.8), (g) => {
      box(g, 12.0, 7.35, 2.6, 0.8, 10, shade(SOFA, -0.15));
      box(g, 12.0, 7.35, 2.6, 0.24, 34, SOFA);
      box(g, 12.22, 7.59, 1.06, 0.52, 6, 0x7a68b0, 10);
      box(g, 13.32, 7.59, 1.06, 0.52, 6, 0x7a68b0, 10);
      box(g, 12.0, 7.35, 0.22, 0.8, 20, SOFA);
      box(g, 14.38, 7.35, 0.22, 0.8, 20, SOFA);
      box(g, 12.35, 7.55, 0.35, 0.12, 14, [0xf9e46b, 0xd9c24a, 0xb8a238], 14);
      box(g, 13.95, 7.55, 0.35, 0.12, 14, [0x6ee7a8, 0x4fc489, 0x3ea06e], 14);
    }),
    piece(depth(12.6, 8.65, 1.4, 0.6), (g) => {
      for (const [li, lj] of [[12.65, 8.7], [13.9, 8.7], [12.65, 9.15], [13.9, 9.15]] as const) box(g, li, lj, 0.06, 0.06, 10, DARK_WOOD);
      box(g, 12.6, 8.65, 1.4, 0.6, 3, WOOD, 10);
      cyl(g, 13.0, 8.9, 0.06, 6, 0xe0574a, 0x6b2a20, 13);
      box(g, 13.4, 8.8, 0.35, 0.25, 1.5, [0xfaf6ee, 0xd8d2c6, 0xc0b9ad], 13);
    }),
    piece(depth(14.75, 7.25, 0.62, 0.55), (g) => {
      box(g, 14.75, 7.25, 0.62, 0.55, 26, WOOD);
      box(g, 14.85, 7.3, 0.3, 0.28, 18, [0x3a3a42, 0x2a2a30, 0x1f1f25], 26);
      faceJ(g, 14.9, 14.96, 7.58, 34, 37, 0xff6b6b);
      cyl(g, 15.25, 7.45, 0.05, 6, 0xf2f0ea, 0x6b4a2f, 26);
    }),
    piece(depth(15.38, 7.22, 0.55, 0.6), (g) => {
      box(g, 15.38, 7.22, 0.55, 0.6, 66, [0xf2f4f7, 0xd8dce3, 0xb3b9c3]);
      faceJ(g, 15.38, 15.93, 7.82, 40, 41, 0x9aa1ac);
      faceJ(g, 15.44, 15.48, 7.82, 46, 58, 0x9aa1ac);
      faceJ(g, 15.44, 15.48, 7.82, 22, 34, 0x9aa1ac);
      faceJ(g, 15.6, 15.75, 7.82, 50, 56, 0xf9e46b);
    }),
    piece(depth(15.15, 9.05, 0.5, 0.5), (g) => {
      const p = iso(15.4, 9.3);
      g.ellipse(p.x, p.y - 8, 21, 13).fill({ color: 0xe08a4a }).stroke(LINE);
      g.ellipse(p.x - 3, p.y - 12, 12, 6).fill({ color: 0xf0a566 });
    }),
    floorLamp(11.35, 7.45, glows),
    plant(15.6, 12.5, 1.2),
    plant(11.4, 12.45, 0.9),
  );

  return { floor, items, glows, leds, clock, calendar, tv, board };
}

// ---------- partitions ----------

interface Wall {
  /** "i": runs along i at j = at. "j": runs along j at i = at. */
  axis: "i" | "j";
  at: number;
  from: number;
  to: number;
  gaps: [number, number][];
}
const WALLS: Wall[] = [
  { axis: "j", at: 8, from: 0, to: 6, gaps: [[2.4, 3.6]] },
  { axis: "i", at: 6, from: 0, to: 8, gaps: [[3.4, 4.6]] },
  { axis: "j", at: 9, from: 0, to: 4, gaps: [[2.5, 3.5]] },
  { axis: "j", at: 13, from: 0, to: 4, gaps: [[2.6, 3.4]] },
  { axis: "i", at: 4, from: 9, to: 16, gaps: [] },
  { axis: "i", at: 7, from: 0, to: 5, gaps: [[2, 3]] },
  { axis: "i", at: 7, from: 5, to: 11, gaps: [[5.9, 10.1]] },
  { axis: "i", at: 7, from: 11, to: 16, gaps: [[14.6, 15.3]] },
  { axis: "j", at: 5, from: 7, to: 13, gaps: [[9.5, 10.5]] },
  { axis: "j", at: 11, from: 7, to: 13, gaps: [[9.5, 10.5]] },
];

/** Low cream half-walls between rooms, cut into short segments so they sort with the agents. */
export function buildPartitions(): Container[] {
  const out: Container[] = [];
  const t = 0.12;
  const seg = (a: number, b: number, w: Wall, h: number, color: Tri) => {
    const [i, j, wi, dj] = w.axis === "i" ? [a, w.at - t / 2, b - a, t] : [w.at - t / 2, a, t, b - a];
    out.push(piece(depth(i, j, wi, dj), (g) => box(g, i, j, wi, dj, h, color)));
  };
  for (const w of WALLS) {
    // Pieces between gaps, in steps of half a tile.
    const solid: [number, number][] = [];
    let start = w.from;
    for (const [g0, g1] of [...w.gaps].sort((x, y) => x[0] - y[0])) {
      if (g0 > start) solid.push([start, g0]);
      start = g1;
    }
    if (w.to > start) solid.push([start, w.to]);
    for (const [s0, s1] of solid) {
      for (let a = s0; a < s1 - 1e-6; a += 0.5) seg(a, Math.min(s1, a + 0.5), w, PART_H, CREAM);
    }
    // Wooden posts at each doorway.
    for (const [g0, g1] of w.gaps) {
      for (const p of [g0, g1]) if (p > w.from && p < w.to) seg(p - 0.07, p + 0.07, w, PART_H + 8, POST);
    }
  }
  return out;
}
