import { describe, expect, it } from "vitest";
import { scrubSecrets } from "./scrub.js";
import { startOfDayIn, tzOffsetMs } from "./time.js";

describe("time zones", () => {
  it("finds local midnight in Sao Paulo (UTC-3, no DST)", () => {
    const at = new Date("2026-10-18T02:30:00Z"); // still Oct 17, 23:30 local
    expect(startOfDayIn(at, "America/Sao_Paulo").toISOString()).toBe("2026-10-17T03:00:00.000Z");
  });

  it("handles Lisbon on both sides of the October DST change", () => {
    expect(tzOffsetMs(new Date("2026-07-01T12:00:00Z"), "Europe/Lisbon")).toBe(3600_000);
    expect(tzOffsetMs(new Date("2026-11-01T12:00:00Z"), "Europe/Lisbon")).toBe(0);
    // DST ends 2026-10-25 at 02:00 local; midnight that day was still summer time.
    expect(startOfDayIn(new Date("2026-10-25T12:00:00Z"), "Europe/Lisbon").toISOString()).toBe(
      "2026-10-24T23:00:00.000Z",
    );
  });
});

describe("scrubSecrets", () => {
  it("masks key-shaped strings and known values", () => {
    const out = scrubSecrets("bad key sk-proj-abcdefgh12345678 and Bearer abcdefghijklmnopqrstu and hunter22", ["hunter22"]);
    expect(out).toBe("bad key [REDACTED] and [REDACTED] and [REDACTED]");
  });
});
