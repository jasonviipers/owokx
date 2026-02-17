import { describe, expect, it } from "vitest";
import {
  buildPolymarketL2Message,
  createPolymarketL2Headers,
  signPolymarketL2Message,
} from "../providers/polymarket/auth";
import { createPolymarketSymbolMap, resolvePolymarketTokenId } from "../providers/polymarket/symbols";

describe("Polymarket auth helpers", () => {
  it("builds L2 auth message in timestamp+method+path format", () => {
    const message = buildPolymarketL2Message(
      1700000000,
      "get",
      "/balance-allowance?asset_type=COLLATERAL&signature_type=2"
    );
    expect(message).toBe("1700000000GET/balance-allowance?asset_type=COLLATERAL&signature_type=2");
  });

  it("creates deterministic HMAC base64 signatures", async () => {
    const signature = await signPolymarketL2Message(
      "1700000000GET/balance-allowance?asset_type=COLLATERAL&signature_type=2",
      "c2VjcmV0MTIz"
    );
    expect(signature).toBe("ajDq0v3oKg84JsgUT4x5ap8Pqx9+oI5cbgIafzzQpbE=");
  });

  it("creates POLY_* headers with a provided timestamp", async () => {
    const headers = await createPolymarketL2Headers({
      method: "GET",
      requestPath: "/balance-allowance?asset_type=COLLATERAL&signature_type=2",
      apiKey: "key-1",
      apiSecret: "c2VjcmV0MTIz",
      apiPassphrase: "pass-1",
      address: "0xabc",
      timestamp: 1700000000,
    });

    expect(headers.POLY_API_KEY).toBe("key-1");
    expect(headers.POLY_PASSPHRASE).toBe("pass-1");
    expect(headers.POLY_TIMESTAMP).toBe("1700000000");
    expect(headers.POLY_ADDRESS).toBe("0xabc");
    expect(headers.POLY_SIGNATURE).toBe("ajDq0v3oKg84JsgUT4x5ap8Pqx9+oI5cbgIafzzQpbE=");
  });
});

describe("Polymarket symbol mapping", () => {
  it("resolves token ids from mapping json", () => {
    const map = createPolymarketSymbolMap('{"AAPL":"111","NVDA":"222"}');
    expect(resolvePolymarketTokenId("AAPL", map)).toBe("111");
    expect(resolvePolymarketTokenId("POLY:333", map)).toBe("333");
    expect(resolvePolymarketTokenId("444", map)).toBe("444");
  });

  it("throws for unmapped non-numeric symbols", () => {
    const map = createPolymarketSymbolMap('{"AAPL":"111","NVDA":"222"}');
    expect(() => resolvePolymarketTokenId("UNKNOWN", map)).toThrow();
  });
});
