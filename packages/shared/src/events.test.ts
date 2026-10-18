import { describe, expect, it } from "vitest";
import { CLIENT_WRITABLE_EVENTS, isEventType, parseEventPayload } from "./events.js";

describe("typed events", () => {
  it("validates payloads against their type", () => {
    expect(parseEventPayload("user.note", { text: "hi" })).toEqual({ text: "hi" });
    expect(() => parseEventPayload("user.note", { text: "" })).toThrow();
    expect(() => parseEventPayload("auth.login", { userId: "x", method: "password" })).toThrow();
  });

  it("knows which types exist", () => {
    expect(isEventType("user.note")).toBe(true);
    expect(isEventType("made.up")).toBe(false);
  });

  it("only lets clients write notes", () => {
    expect(CLIENT_WRITABLE_EVENTS).toEqual(["user.note"]);
  });
});
