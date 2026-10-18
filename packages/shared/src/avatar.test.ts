import { describe, expect, it } from "vitest";
import { allLooks, Avatar, AVATAR_COLORS, AVATAR_SHAPES, avatarSvg, COLOR_HEX, freeLook, lookKey } from "./avatar.js";
import { MOODS } from "./mood.js";

describe("geometric avatars", () => {
  it("has 10 shapes and 15 distinct colours", () => {
    expect(AVATAR_SHAPES).toHaveLength(10);
    expect(AVATAR_COLORS).toHaveLength(15);
    expect(new Set(Object.values(COLOR_HEX).map((c) => c.fill)).size).toBe(15);
  });

  it("draws every shape, colour and mood with exactly two dot eyes", () => {
    for (const shape of AVATAR_SHAPES)
      for (const color of AVATAR_COLORS)
        for (const mood of MOODS) {
          const svg = avatarSvg({ shape, color }, mood);
          expect(svg.startsWith("<svg")).toBe(true);
          expect(svg).not.toContain("undefined");
          expect(svg).not.toContain("NaN");
          expect(svg.match(/<ellipse cx="[\d.]+" cy="[\d.]+" rx="[\d.]+" ry="[\d.]+" fill="#2e2a40"\/>/g)).toHaveLength(2);
        }
  });

  it("gives each mood a different face and each shape a different body", () => {
    expect(new Set(MOODS.map((m) => avatarSvg({ shape: "hexagon" }, m))).size).toBe(MOODS.length);
    expect(new Set(AVATAR_SHAPES.map((shape) => avatarSvg({ shape, color: "teal" }))).size).toBe(10);
  });

  it("still reads avatars saved before the redesign", () => {
    expect(Avatar.parse({ base: "cat", color: "mint", accessory: "scarf" })).toEqual({ shape: "triangle", color: "mint" });
    expect(Avatar.parse({ base: "blob", color: "peach" })).toEqual({ shape: "circle", color: "coral" });
    expect(Avatar.parse({})).toEqual({ shape: "circle", color: "coral" });
  });
});

describe("looks are unique per workspace", () => {
  it("offers 150 different looks", () => {
    expect(new Set(allLooks().map(lookKey)).size).toBe(150);
  });

  it("keeps a wanted look when free, else the same shape in another colour, else the next free one", () => {
    const taken = [{ shape: "star" as const, color: "teal" as const }];
    expect(freeLook(taken, { shape: "star", color: "sky" })).toEqual({ shape: "star", color: "sky" });
    expect(freeLook(taken, { shape: "star", color: "teal" })).toEqual({ shape: "star", color: "coral" });
    expect(lookKey(freeLook(taken))).not.toBe("star/teal");
  });

  it("only repeats once all 150 are used", () => {
    const all = allLooks();
    expect(freeLook(all.slice(0, 149))).toEqual(all[149]);
    expect(freeLook(all, { shape: "square", color: "lime" })).toEqual({ shape: "square", color: "lime" });
  });
});
