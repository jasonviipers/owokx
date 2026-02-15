import { describe, expect, it } from "vitest";
import { resolveShardKey } from "./sharding";

describe("resolveShardKey", () => {
  it("uses fallback when unset", () => {
    expect(resolveShardKey(undefined, "default")).toBe("default");
  });

  it("uses fallback when blank", () => {
    expect(resolveShardKey("   ", "default")).toBe("default");
  });

  it("trims value", () => {
    expect(resolveShardKey("  tenant-a  ", "default")).toBe("tenant-a");
  });

  it("caps length to 128 characters", () => {
    const long = "x".repeat(256);
    expect(resolveShardKey(long, "default").length).toBe(128);
  });
});
