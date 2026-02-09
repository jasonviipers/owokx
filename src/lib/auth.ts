import type { Env } from "../env.d";

export type AuthScope = "read" | "trade" | "admin";

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
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  return token.length > 0 ? token : null;
}

export function isRequestAuthorized(request: Request, env: Env, scope: AuthScope): boolean {
  const bearer = getBearerToken(request);
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
