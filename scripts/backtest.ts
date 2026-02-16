#!/usr/bin/env npx tsx

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BacktestBrokerProvider,
  BacktestMarketDataProvider,
  computeMaxDrawdownPct,
  createSeededRng,
  normalizeDeterministicSeed,
} from "../src/providers/backtest";
import { createOpenAIProvider } from "../src/providers/llm/openai";
import type { Bar, Position } from "../src/providers/types";

function parseArgValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

type BacktestDataFile = {
  bars: Record<string, Bar[]>;
};

type AnalystOutput = {
  recommendations?: Array<{
    action: "BUY" | "SELL" | "HOLD";
    symbol: string;
    confidence: number;
    reasoning: string;
    suggested_size_pct?: number;
  }>;
  market_summary?: string;
  high_conviction_plays?: string[];
};

function buildDeterministicRecommendations(params: {
  momentumSignals: Array<{ symbol: string; ret: number }>;
  positions: Position[];
  minConfidence: number;
  maxPositions: number;
  rng: () => number;
}): AnalystOutput["recommendations"] {
  const held = new Set(params.positions.map((p) => p.symbol.toUpperCase()));
  const buySlots = Math.max(0, params.maxPositions - params.positions.length);

  const ranked = [...params.momentumSignals].sort((a, b) => {
    const delta = b.ret - a.ret;
    if (Math.abs(delta) > 1e-8) return delta;
    return a.symbol.localeCompare(b.symbol);
  });

  const recs: NonNullable<AnalystOutput["recommendations"]> = [];

  for (const candidate of ranked) {
    const confidence = Math.min(0.99, Math.max(0.01, 0.5 + candidate.ret * 5 + (params.rng() - 0.5) * 0.02));

    if (candidate.ret < -0.02 && held.has(candidate.symbol)) {
      recs.push({
        action: "SELL",
        symbol: candidate.symbol,
        confidence,
        reasoning: `Momentum deterioration (${(candidate.ret * 100).toFixed(2)}%)`,
      });
      continue;
    }

    if (candidate.ret > 0.01 && !held.has(candidate.symbol) && buySlots > 0 && confidence >= params.minConfidence) {
      recs.push({
        action: "BUY",
        symbol: candidate.symbol,
        confidence,
        reasoning: `Deterministic momentum breakout (${(candidate.ret * 100).toFixed(2)}%)`,
        suggested_size_pct: Math.round(Math.min(30, Math.max(5, 12 + confidence * 10))),
      });
    }
  }

  return recs.slice(0, 12);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dataPath = parseArgValue(args, "--data");
  if (!dataPath) {
    throw new Error(
      "Usage: scripts/backtest.ts --data path/to/bars.json [--model gpt-4o] [--cash 10000] [--seed 42] [--deterministic]"
    );
  }

  const model = parseArgValue(args, "--model") ?? "gpt-4o";
  const initialCash = Number(parseArgValue(args, "--cash") ?? "10000");
  if (!Number.isFinite(initialCash) || initialCash <= 0) throw new Error("--cash must be a positive number");

  const deterministicMode = hasFlag(args, "--deterministic");
  const seed = normalizeDeterministicSeed(Number(parseArgValue(args, "--seed") ?? "42"));
  const rng = createSeededRng(seed);

  const strategy = parseArgValue(args, "--strategy") ?? (deterministicMode ? "momentum_deterministic" : "llm_momentum");
  const variant = parseArgValue(args, "--variant") ?? (deterministicMode ? "seeded" : model);
  const artifactDir = parseArgValue(args, "--artifact-dir") ?? "artifacts/backtests";

  const raw = await readFile(dataPath, "utf-8");
  const data = JSON.parse(raw) as BacktestDataFile;
  const symbols = Object.keys(data.bars ?? {}).map((s) => s.toUpperCase());
  if (symbols.length === 0) throw new Error("No bars found in data file");

  const firstTimes = symbols.map((s) => Date.parse(data.bars[s]![0]!.t));
  const startMs = Math.min(...firstTimes.filter((t) => Number.isFinite(t)));
  if (!Number.isFinite(startMs)) throw new Error("Invalid bar timestamps");

  const marketData = new BacktestMarketDataProvider(data.bars, { now_ms: startMs, spread_bps: 10 });
  const broker = new BacktestBrokerProvider({ now_ms: startMs, initial_cash: initialCash, marketData });

  const llm = deterministicMode
    ? null
    : createOpenAIProvider({ apiKey: requiredEnv("OPENAI_API_KEY"), model });

  const maxPositions = Number(parseArgValue(args, "--max-positions") ?? "5");
  const minConfidence = Number(parseArgValue(args, "--min-confidence") ?? "0.6");
  const maxNotionalPerTrade = Number(parseArgValue(args, "--max-notional") ?? "5000");
  const positionSizePctOfCash = Number(parseArgValue(args, "--position-pct") ?? "20");

  let orders = 0;
  let steps = 0;

  const maxLen = Math.max(...symbols.map((s) => (data.bars[s]?.length ?? 0)));
  for (let i = 0; i < maxLen; i++) {
    const timeCandidates: number[] = [];
    for (const s of symbols) {
      const bar = data.bars[s]?.[i];
      if (!bar) continue;
      const t = Date.parse(bar.t);
      if (Number.isFinite(t)) timeCandidates.push(t);
    }
    if (timeCandidates.length === 0) continue;
    const nowMs = Math.min(...timeCandidates);
    broker.setNow(nowMs);
    steps++;

    const account = await broker.getAccount();
    const positions = await broker.getPositions();

    const momentumSignals = symbols
      .map((s) => {
        const bars = data.bars[s] ?? [];
        const curr = bars[i];
        const prev = bars[i - 1];
        if (!curr || !prev) return null;
        const ret = (curr.c - prev.c) / prev.c;
        return { symbol: s, ret };
      })
      .filter((x): x is { symbol: string; ret: number } => !!x && Number.isFinite(x.ret))
      .sort((a, b) => b.ret - a.ret)
      .slice(0, 10);

    if (momentumSignals.length === 0) continue;

    let recs: AnalystOutput["recommendations"] = [];

    if (deterministicMode) {
      recs = buildDeterministicRecommendations({
        momentumSignals,
        positions,
        minConfidence,
        maxPositions,
        rng,
      });
    } else {
      const held = new Set(positions.map((p) => p.symbol));
      const prompt = `Current Time: ${new Date(nowMs).toISOString()}

ACCOUNT STATUS:
- Equity: $${account.equity.toFixed(2)}
- Cash: $${account.cash.toFixed(2)}
- Current Positions: ${positions.length}/${maxPositions}

CURRENT POSITIONS:
${positions.length === 0 ? "None" : positions.map((p) => `- ${p.symbol}: qty ${p.qty}, unrealized P&L $${p.unrealized_pl.toFixed(2)}`).join("\n")}

TOP MOMENTUM CANDIDATES (1-step return):
${momentumSignals.map((c) => `- ${c.symbol}: ${(c.ret * 100).toFixed(2)}% ${held.has(c.symbol) ? "[CURRENTLY HELD]" : "[NOT HELD]"}`).join("\n")}

Rules:
- Max positions: ${maxPositions}
- Min confidence to trade: ${minConfidence}
- Output valid JSON only`;

      const response = await llm!.complete({
        model,
        messages: [
          {
            role: "system",
            content: `You are a senior trading analyst AI. Provide BUY/SELL/HOLD recommendations based on the candidates.
Response format:
{
  "recommendations": [
    { "action": "BUY"|"SELL"|"HOLD", "symbol": "TICKER", "confidence": 0.0-1.0, "reasoning": "reason", "suggested_size_pct": 10-30 }
  ],
  "market_summary": "brief",
  "high_conviction_plays": ["symbols"]
}`,
          },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 700,
        response_format: { type: "json_object" },
      });

      let parsed: AnalystOutput | null = null;
      try {
        parsed = JSON.parse(String(response.content ?? "{}").replace(/```json\n?|```/g, "").trim()) as AnalystOutput;
      } catch {
        parsed = null;
      }
      recs = parsed?.recommendations ?? [];
    }

    for (const rec of recs) {
      const symbol = rec.symbol?.toUpperCase?.() ?? "";
      if (!symbol) continue;
      if (!Number.isFinite(rec.confidence) || rec.confidence < minConfidence) continue;

      const currentPositions = await broker.getPositions();
      const heldNow = new Set(currentPositions.map((p) => p.symbol));

      if (rec.action === "BUY") {
        if (heldNow.has(symbol)) continue;
        if (currentPositions.length >= maxPositions) continue;
        const sizePct = Math.min(30, Math.max(1, rec.suggested_size_pct ?? positionSizePctOfCash));
        const notional = Math.min(account.cash * (sizePct / 100) * rec.confidence, maxNotionalPerTrade);
        if (notional < 50) continue;
        await broker.createOrder({ symbol, notional, side: "buy", type: "market", time_in_force: "day" });
        orders++;
      }

      if (rec.action === "SELL") {
        if (!heldNow.has(symbol)) continue;
        const pos = await broker.getPosition(symbol);
        if (!pos) continue;
        await broker.createOrder({ symbol, qty: pos.qty, side: "sell", type: "market", time_in_force: "day" });
        orders++;
      }
    }
  }

  const finalAccount = await broker.getAccount();
  const finalPositions = await broker.getPositions();
  const history = await broker.getPortfolioHistory({ timeframe: "1D" });
  const startEquity = history.equity[0] ?? finalAccount.last_equity;
  const endEquity = finalAccount.equity;
  const pnl = endEquity - startEquity;
  const pnlPct = startEquity > 0 ? (pnl / startEquity) * 100 : 0;
  const equityPoints = history.timestamp.map((timestamp, idx) => ({
    t_ms: timestamp * 1000,
    equity: history.equity[idx] ?? 0,
    cash: undefined,
  }));

  const summary = {
    model: deterministicMode ? "deterministic-momentum" : model,
    strategy,
    variant,
    seed,
    deterministic: deterministicMode,
    steps,
    orders,
    start_equity: startEquity,
    end_equity: endEquity,
    pnl,
    pnl_pct: pnlPct,
    max_drawdown_pct: computeMaxDrawdownPct(equityPoints),
    open_positions: finalPositions.map((p) => ({ symbol: p.symbol, qty: p.qty, market_value: p.market_value })),
    created_at: new Date().toISOString(),
  };

  const runId = `${Date.now()}-${seed}`;
  const outDir = path.join(artifactDir, strategy, runId);
  const summaryPath = path.join(outDir, "summary.json");
  const equityPath = path.join(outDir, "equity.json");

  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8"),
    writeFile(
      equityPath,
      `${JSON.stringify(
        {
          run_id: runId,
          strategy,
          seed,
          points: equityPoints,
        },
        null,
        2
      )}\n`,
      "utf-8"
    ),
  ]);

  process.stdout.write(
    JSON.stringify(
      {
        ...summary,
        artifacts: {
          summary: summaryPath,
          equity: equityPath,
        },
      },
      null,
      2
    ) + "\n"
  );
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exitCode = 1;
});
