import { describe, expect, it } from "vitest";
import { isRequestAuthorized, isSessionTokenMutationAllowed, isTokenAuthorized } from "../lib/auth";

const env = {
  OWOKX_API_TOKEN: "legacy-token",
  OWOKX_API_TOKEN_ADMIN: "admin-token",
  OWOKX_API_TOKEN_TRADE: "trade-token",
  OWOKX_API_TOKEN_READONLY: "read-token",
} as any;

describe("auth", () => {
  it("authorizes bearer tokens by scope", () => {
    expect(isTokenAuthorized("read-token", env, "read")).toBe(true);
    expect(isTokenAuthorized("read-token", env, "trade")).toBe(false);
    expect(isTokenAuthorized("trade-token", env, "trade")).toBe(true);
    expect(isTokenAuthorized("admin-token", env, "admin")).toBe(true);
  });

  it("authorizes session cookie tokens", () => {
    const request = new Request("https://api.example.com/agent/status", {
      headers: {
        Cookie: "OWOKX_SESSION=trade-token",
      },
    });
    expect(isRequestAuthorized(request, env, "trade")).toBe(true);
  });

  it("blocks cross-origin trade mutations for session-cookie auth", () => {
    const request = new Request("https://api.example.com/agent/enable", {
      method: "POST",
      headers: {
        Cookie: "OWOKX_SESSION=trade-token",
      },
    });
    expect(isSessionTokenMutationAllowed(request, "trade")).toBe(false);
  });

  it("allows same-origin trade mutations for session-cookie auth", () => {
    const request = new Request("https://api.example.com/agent/enable", {
      method: "POST",
      headers: {
        Cookie: "OWOKX_SESSION=trade-token",
        Origin: "https://api.example.com",
      },
    });
    expect(isSessionTokenMutationAllowed(request, "trade")).toBe(true);
  });

  it("allows bearer-auth trade mutations without origin header", () => {
    const request = new Request("https://api.example.com/agent/enable", {
      method: "POST",
      headers: {
        Authorization: "Bearer trade-token",
      },
    });
    expect(isSessionTokenMutationAllowed(request, "trade")).toBe(true);
  });
});
