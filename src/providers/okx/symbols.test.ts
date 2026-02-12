import { describe, expect, it } from "vitest";
import { normalizeOkxSymbol } from "./symbols";

describe("OKX symbol normalization", () => {
  it("maps USD quote symbols to configured default quote", () => {
    const info = normalizeOkxSymbol("BTC/USD", "USDT");
    expect(info.instId).toBe("BTC-USDT");
    expect(info.normalizedSymbol).toBe("BTC/USDT");
  });

  it("keeps non-USD quote symbols unchanged", () => {
    const info = normalizeOkxSymbol("ETH/USDC", "USDT");
    expect(info.instId).toBe("ETH-USDC");
    expect(info.normalizedSymbol).toBe("ETH/USDC");
  });
});

