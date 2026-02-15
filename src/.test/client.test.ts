import { describe, expect, it } from "vitest";
import {
  createOkxSignaturePayload,
  generateOkxSignature,
  handleOkxError,
  OkxClientError,
} from "../providers/okx/client";

describe("OKX client helpers", () => {
  it("builds signature payload in the expected order", () => {
    const payload = createOkxSignaturePayload("2024-01-01T00:00:00.000Z", "get", "/api/v5/account/balance", "");

    expect(payload).toBe("2024-01-01T00:00:00.000ZGET/api/v5/account/balance");
  });

  it("generates deterministic HMAC SHA256 base64 signatures", async () => {
    const payload = "2024-01-01T00:00:00.000ZGET/api/v5/account/balance";
    const signature = await generateOkxSignature(payload, "secret123");

    expect(signature).toBe("QsrHz0PZ/poJAjMKAyZKrIEMyk27SPJzOJUUe8oHa1g=");
  });

  it("maps known OKX errors to typed client errors", () => {
    try {
      handleOkxError({ code: "51008", msg: "Insufficient balance" });
      throw new Error("Expected handleOkxError to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OkxClientError);
      const okxError = error as OkxClientError;
      expect(okxError.okxCode).toBe("51008");
      expect(okxError.code).toBe("INSUFFICIENT_BUYING_POWER");
      expect(okxError.message.toLowerCase()).toContain("insufficient balance");
    }
  });
});
