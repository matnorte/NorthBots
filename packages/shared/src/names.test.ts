import { describe, expect, it } from "vitest";
import { checkAgentName } from "./names.js";

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
