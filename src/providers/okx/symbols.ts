export interface OkxSymbolInfo {
  instId: string;
  normalizedSymbol: string;
  base: string;
  quote: string;
}

export function normalizeOkxSymbol(symbol: string, defaultQuote: string): OkxSymbolInfo {
  const upper = symbol.trim().toUpperCase();

  if (upper.includes("-")) {
    const [base, quote] = upper.split("-", 2) as [string, string];
    return {
      instId: upper,
      normalizedSymbol: `${base}/${quote}`,
      base,
      quote,
    };
  }

  if (upper.includes("/")) {
    const [base, rawQuote] = upper.split("/", 2) as [string, string];
    const quote = rawQuote; // Keep the specified quote currency instead of converting USD
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
    const quote = match[2]!; // Keep the matched quote currency instead of converting USD
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
      instId: `${upper}-${defaultQuote}`,
      normalizedSymbol: `${upper}/${defaultQuote}`,
      base: upper,
      quote: defaultQuote,
    };
  }

  return {
    instId: upper,
    normalizedSymbol: upper,
    base: upper,
    quote: defaultQuote,
  };
}
