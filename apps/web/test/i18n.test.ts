import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en.js";
import { es } from "../src/i18n/es.js";
import { ptBR } from "../src/i18n/pt-BR.js";

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("i18n locales", () => {
  it.each([
    ["pt-BR", ptBR],
    ["es", es],
  ])("%s has exactly the same keys as en", (_name, messages) => {
    expect(keys(messages).sort()).toEqual(keys(en).sort());
  });

  it("has no empty strings", () => {
    for (const m of [en, ptBR, es]) {
      const values = JSON.stringify(m).match(/:""/g);
      expect(values).toBeNull();
    }
  });
});
