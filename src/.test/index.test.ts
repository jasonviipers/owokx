import { describe, expect, it } from "vitest";
import { validateAgentMethod } from "./lib/http-guards";

describe("validateAgentMethod", () => {
  it("rejects GET on post-only mutation endpoints", () => {
    const result = validateAgentMethod("/enable", "GET");
    expect(result.ok).toBe(false);
    expect(result.allowed).toEqual(["POST"]);
  });

  it("accepts POST on mutation endpoints", () => {
    const result = validateAgentMethod("/trigger", "POST");
    expect(result.ok).toBe(true);
    expect(result.isMutation).toBe(true);
  });

  it("allows GET on read endpoints", () => {
    const result = validateAgentMethod("/status", "GET");
    expect(result.ok).toBe(true);
    expect(result.isMutation).toBe(false);
  });
});
