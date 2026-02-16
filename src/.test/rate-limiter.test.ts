import { describe, expect, it } from "vitest";
import { OkxRateLimitedClient, RetryWithBackoff } from "../providers/okx/rate-limiter";

describe("OKX rate limiter", () => {
  it("retries retryable failures and eventually resolves", async () => {
    const retry = new RetryWithBackoff(2, 1, 5);
    let attempts = 0;

    const result = await retry.execute(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("429 too many requests");
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry non-retryable failures", async () => {
    const retry = new RetryWithBackoff(3, 1, 5);
    let attempts = 0;

    await expect(
      retry.execute(async () => {
        attempts += 1;
        throw new Error("51000 parameter error");
      })
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });

  it("exposes remaining capacity", async () => {
    const limiter = new OkxRateLimitedClient(5, 0);

    await limiter.execute(async () => undefined);
    await limiter.execute(async () => undefined);

    const remaining = limiter.getRemainingCapacity();
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThanOrEqual(5);
  });
});
