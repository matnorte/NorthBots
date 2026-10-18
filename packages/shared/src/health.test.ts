import { describe, expect, it } from "vitest";
import { HealthResponse } from "./health.js";

describe("HealthResponse", () => {
  it("accepts an ok payload", () => {
    expect(HealthResponse.parse({ status: "ok", db: "ok", version: "0.0.0" }).status).toBe("ok");
  });

  it("rejects an unknown status", () => {
    expect(() => HealthResponse.parse({ status: "great", db: "ok", version: "1" })).toThrow();
  });
});
