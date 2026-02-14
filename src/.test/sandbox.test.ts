import { describe, expect, it } from "vitest";
import { createOkxClient } from "../providers/okx/client";

const hasCreds = !!process.env.OKX_API_KEY && !!process.env.OKX_SECRET && !!process.env.OKX_PASSPHRASE;
const simulated = (process.env.OKX_SIMULATED_TRADING ?? "").toLowerCase() === "true";

describe.skipIf(!hasCreds || !simulated)("OKX sandbox integration", () => {
  it("fetches account balance with simulated trading header", async () => {
    const client = createOkxClient({
      apiKey: process.env.OKX_API_KEY!,
      secret: process.env.OKX_SECRET!,
      passphrase: process.env.OKX_PASSPHRASE!,
      simulatedTrading: true,
      maxRetries: 0,
    });

    const res = await client.request("GET", "/api/v5/account/balance");
    expect(res.code).toBe("0");
  });
});
