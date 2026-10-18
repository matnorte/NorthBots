import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { checkContradiction, cosine, exportMemory, HashEmbedder, importMemory, type PortableFact } from "../src/index.js";

describe("HashEmbedder", () => {
  const e = new HashEmbedder();

  it("is deterministic and unit length", () => {
    const [a, b] = [e.embedOne("Send the weekly invoice summary"), e.embedOne("Send the weekly invoice summary")];
    expect(a).toEqual(b);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
  });

  it("puts related texts closer than unrelated ones", () => {
    const q = e.embedOne("summarize this week's invoices");
    const near = e.embedOne("Summarise the invoices from this week");
    const far = e.embedOne("water the office plants");
    expect(cosine(q, near)).toBeGreaterThan(0.5);
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far) + 0.3);
  });
});

describe("checkContradiction", () => {
  it.each([
    ["The store closes at 18:00", "The store closes at 20:00", true],
    ["Ana prefers email", "Ana does not prefer email", true],
    ["Ana prefers email", "Ana prefers email for invoices", false],
    ["The store closes at 18:00", "Shipping costs 5 dollars", false],
  ] as const)("%s / %s -> %s", (a, b, expected) => {
    expect(checkContradiction(a, b).contradicts).toBe(expected);
  });
});

describe("export and import", () => {
  const facts: PortableFact[] = [
    { id: "f1", scope: "shared", agentName: null, text: "Shop closes at 18:00", createdAt: "2026-10-01T10:00:00.000Z", expiresAt: null, derivedFrom: [], source: "chat" },
    { id: "f2", scope: "private", agentName: "Pip", text: "Ana likes short replies", createdAt: "2026-10-02T10:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", derivedFrom: ["f1"], source: null },
  ];

  it("round-trips exactly through the zip", async () => {
    const zip = await exportMemory(facts);
    const back = await importMemory(zip);
    expect(back.format).toBe("northbot");
    expect(back.facts).toEqual(facts);
    const files = Object.keys((await JSZip.loadAsync(zip)).files).sort();
    expect(files).toEqual(["agent-Pip.md", "memory.json", "shared.md"]);
  });

  it("reads a ChatGPT conversations.json", async () => {
    const gpt = [
      {
        title: "Shop pricing",
        create_time: 1760000000,
        mapping: {
          a: { message: { author: { role: "system" }, content: { parts: [""] } } },
          b: { message: { author: { role: "user" }, content: { parts: ["How should I price mugs?"] } } },
        },
      },
    ];
    const r = await importMemory(Buffer.from(JSON.stringify(gpt)));
    expect(r.format).toBe("chatgpt");
    expect(r.facts[0]?.text).toBe('Past ChatGPT conversation "Shop pricing": How should I price mugs?');
  });

  it("reads a Claude conversations.json inside a zip", async () => {
    const zip = new JSZip();
    zip.file("conversations.json", JSON.stringify([{ name: "Launch plan", created_at: "2026-09-01T00:00:00Z", chat_messages: [{ sender: "human", text: "Plan my launch" }] }]));
    const r = await importMemory(await zip.generateAsync({ type: "nodebuffer" }));
    expect(r.format).toBe("claude");
    expect(r.facts[0]?.text).toContain("Plan my launch");
  });

  it("reads plain lists and rejects unknown files", async () => {
    expect((await importMemory(Buffer.from("- one\n- two\n"))).facts.map((f) => f.text)).toEqual(["one", "two"]);
    await expect(importMemory(Buffer.from(JSON.stringify({ hello: 1 })))).rejects.toThrow(/Unrecognised/);
  });
});
