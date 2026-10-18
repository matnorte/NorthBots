import type { Zone } from "@northbot/shared";

/** Isometric tiles: one tile is 64 × 32 screen pixels before zoom. */
export const TILE_W = 64;
export const TILE_H = 32;

/** Tile coordinates (i to the lower right, j to the lower left) to world pixels. */
export const iso = (i: number, j: number) => ({ x: (i - j) * (TILE_W / 2), y: (i + j) * (TILE_H / 2) });

/** Back to tile coordinates (the inverse of `iso`). */
export function tileAt(x: number, y: number): { i: number; j: number } {
  const a = x / (TILE_W / 2);
  const b = y / (TILE_H / 2);
  return { i: (a + b) / 2, j: (b - a) / 2 };
}

export interface ZoneLayout {
  /** Tile rectangle [i0, j0, i1, j1] (end exclusive). */
  rect: [number, number, number, number];
  /** Where the room's main piece sits (letters fly to the post box and mail desk), in tiles. */
  at: [number, number];
}

/**
 * The office floor plan. Rooms tile the floor around a marble hallway (column i = 8..9 at the
 * back, row j = 6..7 across the middle). The top half is the open office, the browser lab, the
 * vault and a mail nook; the bottom half is the meeting room, the stage and the break room.
 */
export const LAYOUT: Record<Zone, ZoneLayout> = {
  desk: { rect: [0, 0, 8, 6], at: [4, 3] },
  browser_lab: { rect: [9, 0, 13, 4], at: [11, 1] },
  vault: { rect: [13, 0, 16, 4], at: [14.4, 1.4] },
  idea_bin: { rect: [9, 4, 10, 6], at: [9.5, 5] },
  post_box: { rect: [10, 4, 11, 6], at: [10.5, 4.55] },
  mail_desk: { rect: [11, 4, 13, 6], at: [12, 4.6] },
  whiteboard: { rect: [13, 4, 16, 6], at: [14.5, 4.25] },
  meeting_room: { rect: [0, 7, 5, 13], at: [2.5, 10.1] },
  stage: { rect: [5, 7, 11, 13], at: [8, 9.9] },
  break_room: { rect: [11, 7, 16, 13], at: [13.3, 7.8] },
};

export const FLOOR = { cols: 16, rows: 13 };

const center = (z: Zone): [number, number] => {
  const [i0, j0, i1, j1] = LAYOUT[z].rect;
  return [(i0 + i1) / 2, (j0 + j1) / 2];
};

/** Spots around a room's middle, in the order agents take them (tiles). */
const SPOTS: [number, number][] = [
  [-0.9, 0.7],
  [0.8, 0.8],
  [-0.2, 1.4],
  [1.3, 0.1],
  [-1.5, 0],
  [0.5, 1.7],
  [-1.2, 1.5],
  [1.6, 1.2],
];

/** Each agent's own desk (the monitor's left edge), by creation order: four per row. */
export function deskTile(order: number): [number, number] {
  const col = order % 4;
  const row = Math.floor(order / 4);
  return [0.9 + col * 1.75, 1.0 + row * 2.0];
}

/** Where the k-th agent in a zone stands (desks: in its chair, in front of its own desk). */
export function standTile(zone: Zone, order: number, k: number): [number, number] {
  if (zone === "desk") {
    const [i, j] = deskTile(order);
    return [i + 0.55, j + 0.62];
  }
  const [ci, cj] = center(zone);
  const [di, dj] = SPOTS[k % SPOTS.length]!;
  // After the first ring of spots, the next ring sits a little further out.
  const ring = 1 + 0.35 * Math.floor(k / SPOTS.length);
  const [i0, j0, i1, j1] = LAYOUT[zone].rect;
  // Small rooms (the mail nook) keep everyone inside their walls.
  const clamp = (v: number, a: number, b: number) => Math.min(b - 0.25, Math.max(a + 0.25, v));
  return [clamp(ci + di * ring, i0, i1), clamp(cj + 0.4 + dj * ring, j0, j1)];
}

/** Which room a world point is over (null outside the floor or in the hallway). */
export function zoneAtWorld(x: number, y: number): Zone | null {
  const { i, j } = tileAt(x, y);
  for (const [z, l] of Object.entries(LAYOUT) as [Zone, ZoneLayout][]) {
    const [i0, j0, i1, j1] = l.rect;
    if (i >= i0 && i < i1 && j >= j0 && j < j1) return z;
  }
  return null;
}

export const zoneCenterTile = center;
