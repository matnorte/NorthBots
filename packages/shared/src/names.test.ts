import { describe, expect, it } from "vitest";
import { AVATAR_ACCESSORIES, AVATAR_BASES, AVATAR_COLORS, avatarSvg } from "./avatar.js";
import { checkAgentName } from "./names.js";
import { MOODS } from "./mood.js";

describe("checkAgentName", () => {
  it.each(["Biscuit", "Pip", "Mochi-2", "Tía Lu", "Nimbus"])("accepts %s", (n) => {
    expect(checkAgentName(n).ok).toBe(true);
  });

  it.each([
    ["A", "length"],
    ["Thirteenchars", "length"],
    ["Bad!Name", "characters"],
    ["-dash", "characters"],
  ] as const)("rejects %s (%s)", (n, problem) => {
    expect(checkAgentName(n)).toMatchObject({ ok: false, problem });
  });

  it.each(["Claude", "ChatGPT Jr", "Elon", "Pikachu", "Gandalf 2", "Siri", "B4tman", "Shopify Bot"])("blocks %s", (n) => {
    expect(checkAgentName(n)).toMatchObject({ ok: false, problem: "blocked" });
  });

  it("matches short blocked words only as whole words", () => {
    expect(checkAgentName("Metal").ok).toBe(true); // contains "meta"
    expect(checkAgentName("Meta").ok).toBe(false);
  });
});

describe("avatarSvg", () => {
  it("draws every base, colour, accessory and mood as valid-looking SVG", () => {
    for (const base of AVATAR_BASES)
      for (const color of AVATAR_COLORS)
        for (const accessory of AVATAR_ACCESSORIES)
          for (const mood of MOODS) {
            const svg = avatarSvg({ base, color, accessory }, mood);
            expect(svg.startsWith("<svg")).toBe(true);
            expect(svg.endsWith("</svg>")).toBe(true);
            expect(svg).not.toContain("undefined");
          }
  });

  it("gives each mood a different face", () => {
    const faces = new Set(MOODS.map((m) => avatarSvg({}, m)));
    expect(faces.size).toBe(MOODS.length);
  });
});
