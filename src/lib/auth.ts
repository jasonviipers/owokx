import type { Env } from "../env.d";

export type AuthScope = "read" | "trade" | "admin";
const SESSION_COOKIE_NAME = "OWOKX_SESSION";

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token.length > 0) return token;
  }

  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...valueParts] = part.trim().split("=");
    if (rawName !== SESSION_COOKIE_NAME) continue;
    const rawValue = valueParts.join("=");
    if (!rawValue) return null;
    try {
      const decoded = decodeURIComponent(rawValue);
      return decoded.length > 0 ? decoded : null;
    } catch {
      return rawValue.length > 0 ? rawValue : null;
    }
  }
  return null;
}

export function isTokenAuthorized(token: string, env: Env, scope: AuthScope): boolean {
  const bearer = token.trim();
  if (!bearer) return false;

  const legacy = env.OWOKX_API_TOKEN;
  const admin = env.OWOKX_API_TOKEN_ADMIN;
  const trade = env.OWOKX_API_TOKEN_TRADE;
  const read = env.OWOKX_API_TOKEN_READONLY;

  const candidates: Array<string | undefined> = [];

  if (scope === "admin") {
    candidates.push(admin, legacy);
  } else if (scope === "trade") {
    candidates.push(trade, admin, legacy);
  } else {
    candidates.push(read, trade, admin, legacy);
  }

  for (const c of candidates) {
    if (!c) continue;
    if (constantTimeCompare(bearer, c)) return true;
  }

  return false;
}

export function isRequestAuthorized(request: Request, env: Env, scope: AuthScope): boolean {
  const bearer = getBearerToken(request);
  if (!bearer) return false;
  return isTokenAuthorized(bearer, env, scope);
}
