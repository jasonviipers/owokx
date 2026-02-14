import { describe, expect, it } from "vitest";
import { parseBoolean } from "../lib/utils";

describe("utils.parseBoolean", () => {
  it("returns default for undefined", () => {
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean(undefined, false)).toBe(false);
  });

  it("parses true values (case-insensitive)", () => {
    expect(parseBoolean("true", false)).toBe(true);
    expect(parseBoolean("TRUE", false)).toBe(true);
    expect(parseBoolean("1", false)).toBe(true);
    expect(parseBoolean("yes", false)).toBe(true);
    expect(parseBoolean("on", false)).toBe(true);
  });

  it("parses false values (case-insensitive)", () => {
    expect(parseBoolean("false", true)).toBe(false);
    expect(parseBoolean("FALSE", true)).toBe(false);
    expect(parseBoolean("0", true)).toBe(false);
    expect(parseBoolean("no", true)).toBe(false);
    expect(parseBoolean("off", true)).toBe(false);
  });

  it("trims and strips surrounding quotes", () => {
    expect(parseBoolean(' "true" ', false)).toBe(true);
    expect(parseBoolean(" 'false' ", true)).toBe(false);
  });

  it("falls back to default on unknown values", () => {
    expect(parseBoolean("maybe", true)).toBe(true);
    expect(parseBoolean("maybe", false)).toBe(false);
  });
});
