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
  rug: number;
  furniture: string | null;
  /** Where the furniture sits, in tiles. */
  at: [number, number];
}

/** The office floor plan: ten rooms. Desks get one slot per agent inside the desk area. */
export const LAYOUT: Record<Zone, ZoneLayout> = {
  desk: { rect: [1, 1, 8, 6], rug: 0x2a2433, furniture: null, at: [4.5, 3.5] },
  browser_lab: { rect: [9, 1, 12, 4], rug: 0x1f2a36, furniture: "browser_lab", at: [10.5, 2] },
  vault: { rect: [13, 1, 15, 3], rug: 0x2a2a30, furniture: "vault", at: [14, 1.6] },
  whiteboard: { rect: [13, 4, 15, 7], rug: 0x2c2a26, furniture: "whiteboard", at: [14, 5] },
  idea_bin: { rect: [9, 5, 10, 7], rug: 0x2d2a22, furniture: "bin", at: [9.5, 5.8] },
  post_box: { rect: [10, 5, 11, 7], rug: 0x332424, furniture: "post_box", at: [10.5, 5.6] },
  mail_desk: { rect: [11, 5, 13, 7], rug: 0x2b2538, furniture: "mail_desk", at: [12, 5.8] },
  meeting_room: { rect: [1, 8, 6, 12], rug: 0x22302a, furniture: "meeting_table", at: [3.5, 10] },
  stage: { rect: [6, 8, 11, 12], rug: 0x33242c, furniture: "stage", at: [8.5, 9.6] },
  break_room: { rect: [11, 8, 15, 12], rug: 0x22283a, furniture: "sofa", at: [13, 9.6] },
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

/** Each agent's own desk, by creation order. */
export function deskTile(order: number): [number, number] {
  const col = order % 4;
  const row = Math.floor(order / 4);
  return [1.6 + col * 1.6, 1.6 + row * 1.5];
}

/** Where the k-th agent in a zone stands (desks: in front of its own desk). */
export function standTile(zone: Zone, order: number, k: number): [number, number] {
  if (zone === "desk") {
    const [i, j] = deskTile(order);
    return [i + 0.55, j + 0.55];
  }
  const [ci, cj] = center(zone);
  const [di, dj] = SPOTS[k % SPOTS.length]!;
  // After the first ring of spots, the next ring sits a little further out.
  const ring = 1 + 0.35 * Math.floor(k / SPOTS.length);
  return [ci + di * ring, cj + 0.4 + dj * ring];
}

/** Which room a world point is over (null outside the floor). */
export function zoneAtWorld(x: number, y: number): Zone | null {
  const { i, j } = tileAt(x, y);
  for (const [z, l] of Object.entries(LAYOUT) as [Zone, ZoneLayout][]) {
    const [i0, j0, i1, j1] = l.rect;
    if (i >= i0 && i < i1 && j >= j0 && j < j1) return z;
  }
  return null;
}

export const zoneCenterTile = center;
