import { describe, it, expect } from "vitest";
import { isAllowedDomain, extractFinancialData } from "../providers/scraper";

describe("scraper", () => {
  describe("isAllowedDomain", () => {
    it("should allow whitelisted domains", () => {
      expect(isAllowedDomain("https://finance.yahoo.com/quote/AAPL")).toBe(true);
      expect(isAllowedDomain("https://www.sec.gov/edgar/search")).toBe(true);
      expect(isAllowedDomain("https://stockanalysis.com/stocks/tsla")).toBe(true);
    });

    it("should allow subdomains of whitelisted domains", () => {
      expect(isAllowedDomain("https://api.finance.yahoo.com/data")).toBe(true);
    });

    it("should reject non-whitelisted domains", () => {
      expect(isAllowedDomain("https://evil.com")).toBe(false);
      expect(isAllowedDomain("https://google.com")).toBe(false);
    });

    it("should handle invalid URLs", () => {
      expect(isAllowedDomain("not-a-url")).toBe(false);
    });
  });

  describe("extractFinancialData", () => {
    it("should extract mentions of stock symbol", () => {
      const text = "AAPL closed at $150. AAPL is up today.";
      const result = extractFinancialData(text, "AAPL");
      
      expect(result.mentions).toBe(2);
    });

    it("should extract price references", () => {
      const text = "Stock traded at $150.50 and $149.75 today";
      const result = extractFinancialData(text, "TEST");
      
      expect(result.priceReferences).toContain("$150.50");
      expect(result.priceReferences).toContain("$149.75");
    });

    it("should extract percentage changes", () => {
      const text = "Stock up +5.2% and down -3.1% during session";
      const result = extractFinancialData(text, "TEST");
      
      expect(result.percentChanges).toContain("+5.2%");
      expect(result.percentChanges).toContain("-3.1%");
    });

    it("should extract key financial phrases", () => {
      const text = "Company earnings beat expectations with revenue growth";
      const result = extractFinancialData(text, "TEST");
      
      expect(result.keyPhrases.length).toBeGreaterThan(0);
      expect(result.keyPhrases.some(p => p.toLowerCase().includes("earnings beat"))).toBe(true);
    });

    it("should limit results to prevent overflow", () => {
      const text = "$1 $2 $3 $4 $5 $6 $7 $8 $9 $10 $11 $12 $13";
      const result = extractFinancialData(text, "TEST");
      
      expect(result.priceReferences.length).toBeLessThanOrEqual(10);
    });
  });
});