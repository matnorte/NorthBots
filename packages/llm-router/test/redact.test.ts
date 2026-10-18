import { describe, expect, it } from "vitest";
import { Redactor, StreamRestorer } from "../src/redact.js";

describe("Redactor", () => {
  it("replaces emails, CPF, CNPJ, valid cards and phones, then restores them", () => {
    const r = new Redactor();
    const input =
      "Mail ana@loja.com.br, CPF 123.456.789-09, CNPJ 12.345.678/0001-95, card 4111 1111 1111 1111, call +55 11 91234-5678";
    const out = r.redactText(input);
    expect(out).not.toMatch(/ana@loja|123\.456|12\.345\.678|4111|91234/);
    expect(out).toContain("[EMAIL_1]");
    expect(out).toContain("[CPF_1]");
    expect(out).toContain("[CNPJ_1]");
    expect(out).toContain("[CARD_1]");
    expect(out).toContain("[PHONE_1]");
    expect(r.restore(out)).toBe(input);
  });

  it("leaves numbers that fail the Luhn check alone", () => {
    expect(new Redactor().redactText("order 1234 5678 9012 3456")).toBe("order 1234 5678 9012 3456");
  });

  it("uses one placeholder per distinct value across messages", () => {
    const r = new Redactor();
    const msgs = r.redactMessages([
      { role: "user", content: "a@b.co and c@d.co" },
      { role: "user", content: "again a@b.co" },
    ]);
    expect(msgs.map((m) => m.content)).toEqual(["[EMAIL_1] and [EMAIL_2]", "again [EMAIL_1]"]);
  });

  it("drops raw provider turns, which hold unredacted text", () => {
    const [m] = new Redactor().redactMessages([
      { role: "assistant", content: "x@y.io", raw: { provider: "p", model: "m", content: "x@y.io" } },
    ]);
    expect(m).toEqual({ role: "assistant", content: "[EMAIL_1]", toolCalls: undefined });
  });
});

describe("StreamRestorer", () => {
  it("restores a placeholder split across chunks", () => {
    const r = new Redactor();
    r.redactText("me@x.io");
    const s = new StreamRestorer(r);
    const out = [s.push("Write to [EMA"), s.push("IL_1] today"), s.flush()].join("");
    expect(out).toBe("Write to me@x.io today");
  });
});
