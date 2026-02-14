import { describe, expect, it } from "vitest";
import { hasExplicitOkxQuote, normalizeOkxSymbol } from "../providers/okx/symbols";

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

  it("validates explicit OKX quote symbols", () => {
    expect(hasExplicitOkxQuote("BTC/USDT")).toBe(true);
    expect(hasExplicitOkxQuote("ETH-USDC")).toBe(true);
    expect(hasExplicitOkxQuote("SOLUSDT")).toBe(true);

    expect(hasExplicitOkxQuote("TLT")).toBe(false);
    expect(hasExplicitOkxQuote("MON.X")).toBe(false);
  });
});
