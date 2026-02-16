import { createError, ErrorCode } from "../../lib/errors";

const SYMBOL_PREFIX = "POLY:";

export interface PolymarketSymbolMap {
  bySymbol: Map<string, string>;
  byTokenId: Map<string, string>;
}

export function createPolymarketSymbolMap(rawJson: string | undefined): PolymarketSymbolMap {
  if (!rawJson || rawJson.trim().length === 0) {
    return {
      bySymbol: new Map(),
      byTokenId: new Map(),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw createError(
      ErrorCode.INVALID_INPUT,
      'POLYMARKET_SYMBOL_MAP_JSON must be valid JSON (example: {"AAPL":"123456789"})'
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw createError(ErrorCode.INVALID_INPUT, "POLYMARKET_SYMBOL_MAP_JSON must be a JSON object");
  }

  const bySymbol = new Map<string, string>();
  const byTokenId = new Map<string, string>();

  for (const [rawSymbol, rawToken] of Object.entries(parsed as Record<string, unknown>)) {
    const symbol = rawSymbol.trim().toUpperCase();
    const tokenId = String(rawToken ?? "").trim();
    if (!symbol || !tokenId) continue;
    bySymbol.set(symbol, tokenId);
    byTokenId.set(tokenId, symbol);
  }

  return { bySymbol, byTokenId };
}

function normalizeRawTokenId(symbolOrToken: string): string {
  const trimmed = symbolOrToken.trim();
  if (trimmed.toUpperCase().startsWith(SYMBOL_PREFIX)) {
    return trimmed.slice(SYMBOL_PREFIX.length).trim();
  }
  return trimmed;
}

export function resolvePolymarketTokenId(symbol: string, map: PolymarketSymbolMap): string {
  const trimmed = symbol.trim();
  if (!trimmed) {
    throw createError(ErrorCode.INVALID_INPUT, "symbol is required");
  }

  const tokenCandidate = normalizeRawTokenId(trimmed);
  if (/^\d+$/.test(tokenCandidate)) {
    return tokenCandidate;
  }

  const mapped = map.bySymbol.get(trimmed.toUpperCase());
  if (mapped) {
    return mapped;
  }

  throw createError(
    ErrorCode.INVALID_INPUT,
    `Unable to resolve Polymarket token id for symbol '${symbol}'. Provide POLYMARKET_SYMBOL_MAP_JSON or use POLY:<token_id>.`
  );
}

export function formatPolymarketSymbol(tokenId: string, map: PolymarketSymbolMap, fallback?: string): string {
  const normalizedToken = tokenId.trim();
  if (!normalizedToken) {
    return fallback?.trim() || tokenId;
  }
  const mapped = map.byTokenId.get(normalizedToken);
  if (mapped) return mapped;
  const fallbackSymbol = fallback?.trim();
  if (fallbackSymbol) return fallbackSymbol;
  return `${SYMBOL_PREFIX}${normalizedToken}`;
}
