export interface OkxSymbolInfo {
  instId: string;
  normalizedSymbol: string;
  base: string;
  quote: string;
}

const SYMBOL_PART_RE = /^[A-Z0-9]{2,15}$/;

function isValidSymbolPart(value: string): boolean {
  return SYMBOL_PART_RE.test(value);
}

export function hasExplicitOkxQuote(symbol: string): boolean {
  const upper = symbol.trim().toUpperCase();

  if (upper.includes("/")) {
    const parts = upper.split("/");
    if (parts.length !== 2) return false;
    const [base, quote] = parts as [string, string];
    return isValidSymbolPart(base) && isValidSymbolPart(quote);
  }

  if (upper.includes("-")) {
    const parts = upper.split("-");
    if (parts.length !== 2) return false;
    const [base, quote] = parts as [string, string];
    return isValidSymbolPart(base) && isValidSymbolPart(quote);
  }

  return /^([A-Z0-9]{2,15})(USD|USDT|USDC)$/.test(upper);
}

export function normalizeOkxSymbol(symbol: string, defaultQuote: string): OkxSymbolInfo {
  const upper = symbol.trim().toUpperCase();
  const normalizedDefaultQuote = defaultQuote.trim().toUpperCase();
  const resolveQuote = (quote: string): string => (quote === "USD" ? normalizedDefaultQuote : quote);

  if (upper.includes("-")) {
    const [base, rawQuote] = upper.split("-", 2) as [string, string];
    const quote = resolveQuote(rawQuote);
    return {
      instId: `${base}-${quote}`,
      normalizedSymbol: `${base}/${quote}`,
      base,
      quote,
    };
  }

  if (upper.includes("/")) {
    const [base, rawQuote] = upper.split("/", 2) as [string, string];
    const quote = resolveQuote(rawQuote);
    return {
      instId: `${base}-${quote}`,
      normalizedSymbol: `${base}/${quote}`,
      base,
      quote,
    };
  }

  const match = upper.match(/^([A-Z0-9]{2,10})(USD|USDT|USDC)$/);
  if (match) {
    const base = match[1]!;
    const quote = resolveQuote(match[2]!);
    return {
      instId: `${base}-${quote}`,
      normalizedSymbol: `${base}/${quote}`,
      base,
      quote,
    };
  }

  // Fallback: If it looks like a single currency (e.g. BTC, ETH), append default quote
  if (/^[A-Z0-9]{2,10}$/.test(upper)) {
    return {
      instId: `${upper}-${normalizedDefaultQuote}`,
      normalizedSymbol: `${upper}/${normalizedDefaultQuote}`,
      base: upper,
      quote: normalizedDefaultQuote,
    };
  }

  return {
    instId: upper,
    normalizedSymbol: upper,
    base: upper,
    quote: defaultQuote,
  };
}
