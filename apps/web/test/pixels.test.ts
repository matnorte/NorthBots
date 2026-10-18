import { describe, expect, it } from "vitest";
import { AVATAR_COLORS, AVATAR_SHAPES, COLOR_HEX } from "@northbot/shared";
import { ANIMS, eyesFor, frames, H, W } from "../src/office/pixels.js";

const mask = (shape: (typeof AVATAR_SHAPES)[number]) =>
  frames({ shape, color: "teal" }, "idle")[0]!
    .px.map((c) => (c ? "#" : "."))
    .join("");

describe("pixel sprites", () => {
  it("draws every shape in every colour, with the colour's fill and edge", () => {
    for (const shape of AVATAR_SHAPES) {
      for (const color of AVATAR_COLORS) {
        const [f] = frames({ shape, color }, "idle");
        expect(f!.px).toHaveLength(W * H);
        expect(f!.px).toContain(COLOR_HEX[color].fill);
        expect(f!.px).toContain(COLOR_HEX[color].edge);
      }
    }
  });

  it("gives each of the 10 shapes its own silhouette", () => {
    expect(new Set(AVATAR_SHAPES.map(mask)).size).toBe(AVATAR_SHAPES.length);
  });

  it("has two dot eyes on a content face", () => {
    const px = frames({ shape: "circle", color: "coral" }, "idle", "dots")[0]!.px;
    const ink = px.map((c, i) => (c === "#2e2a40" ? i : -1)).filter((i) => i >= 0 && Math.floor(i / W) < 24);
    const columns = new Set(ink.map((i) => i % W));
    expect(columns.size).toBe(2);
  });

  it("animates: every animation has frames, and they differ", () => {
    for (const anim of ANIMS) {
      const fs = frames({ shape: "star", color: "sunflower" }, anim);
      expect(fs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(fs.map((f) => f.px.join())).size).toBeGreaterThan(1);
    }
  });

  it("maps moods to faces", () => {
    expect(eyesFor("content")).toBe("dots");
    expect(eyesFor("proud")).toBe("happy");
    expect(eyesFor("annoyed")).toBe("angry");
    expect(eyesFor("sleepy")).toBe("closed");
    expect(eyesFor("dizzy")).toBe("x");
  });
});
