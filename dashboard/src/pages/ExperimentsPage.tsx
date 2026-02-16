import { useCallback, useEffect, useMemo, useState } from "react";
import { LineChart } from "../components/LineChart";
import { Panel } from "../components/Panel";
import {
  fetchExperimentRunDetails,
  fetchExperimentRuns,
  fetchExperimentVariants,
  promoteExperimentRun,
} from "../lib/api";
import type { ExperimentMetric, ExperimentRun, ExperimentRunDetails, ExperimentVariant } from "../types";

const SERIES_VARIANTS = ["cyan", "yellow"] as const;

function readNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPercent(value: number | null): string {
  if (value === null) return "n/a";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function formatCurrency(value: number | null): string {
  if (value === null) return "n/a";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function getRunVariantName(run: ExperimentRun): string {
  const fromConfig = run.config?.variant;
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) {
    return fromConfig.trim();
  }
  return `run-${run.id.slice(0, 8)}`;
}

function getSummaryNumber(run: ExperimentRun, detail: ExperimentRunDetails | undefined, keys: string[]): number | null {
  const primary = (detail?.summary_artifact ?? run.summary ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    const value = readNumber(primary[key]);
    if (value !== null) return value;
  }
  return null;
}

function getMetricValue(metrics: ExperimentMetric[], metricName: string): number | null {
  const row = metrics.find((metric) => metric.metric_name === metricName);
  return row ? readNumber(row.metric_value) : null;
}

function getEquityPoints(detail: ExperimentRunDetails | undefined): Array<{ t_ms: number; equity: number }> {
  const rawPoints = detail?.equity_artifact?.points;
  if (!Array.isArray(rawPoints)) return [];
  return rawPoints
    .map((point) => ({
      t_ms: readNumber(point?.t_ms) ?? 0,
      equity: readNumber(point?.equity) ?? NaN,
    }))
    .filter((point) => point.t_ms > 0 && Number.isFinite(point.equity));
}

interface ExperimentsPageProps {
  enabled?: boolean;
  compact?: boolean;
}

export function ExperimentsPage({ enabled = true, compact = false }: ExperimentsPageProps) {
  const [runs, setRuns] = useState<ExperimentRun[]>([]);
  const [variants, setVariants] = useState<ExperimentVariant[]>([]);
  const [detailsByRunId, setDetailsByRunId] = useState<Record<string, ExperimentRunDetails>>({});
  const [loadingDetails, setLoadingDetails] = useState<Record<string, boolean>>({});
  const [selectedStrategy, setSelectedStrategy] = useState<string>("all");
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [promotionMessage, setPromotionMessage] = useState<string | null>(null);
  const [promotingRunId, setPromotingRunId] = useState<string | null>(null);

  const loadExperiments = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const strategyFilter = selectedStrategy === "all" ? undefined : selectedStrategy;
      const [nextRuns, nextVariants] = await Promise.all([
        fetchExperimentRuns({ strategy_name: strategyFilter, limit: 100 }),
        fetchExperimentVariants(strategyFilter),
      ]);
      setRuns(nextRuns);
      setVariants(nextVariants);
      setSelectedRunIds((previous) => {
        const valid = previous.filter((runId) => nextRuns.some((run) => run.id === runId)).slice(0, 2);
        if (valid.length > 0) return valid;
        return nextRuns.slice(0, 2).map((run) => run.id);
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [enabled, selectedStrategy]);

  const loadRunDetails = useCallback(async (runId: string) => {
    if (!runId) return;
    setLoadingDetails((previous) => {
      if (previous[runId]) return previous;
      return { ...previous, [runId]: true };
    });

    try {
      const details = await fetchExperimentRunDetails(runId);
      setDetailsByRunId((previous) => ({ ...previous, [runId]: details }));
    } catch {
      // Keep the compare UI responsive even when one run artifact is unavailable.
    } finally {
      setLoadingDetails((previous) => {
        const next = { ...previous };
        delete next[runId];
        return next;
      });
    }
  }, []);

  useEffect(() => {
    void loadExperiments();
  }, [loadExperiments]);

  useEffect(() => {
    for (const runId of selectedRunIds) {
      if (!detailsByRunId[runId] && !loadingDetails[runId]) {
        void loadRunDetails(runId);
      }
    }
  }, [selectedRunIds, detailsByRunId, loadingDetails, loadRunDetails]);

  useEffect(() => {
    if (!promotionMessage) return;
    const timeout = setTimeout(() => setPromotionMessage(null), 4000);
    return () => clearTimeout(timeout);
  }, [promotionMessage]);

  const strategyOptions = useMemo(() => {
    return Array.from(new Set(runs.map((run) => run.strategy_name))).sort();
  }, [runs]);

  const selectedRuns = useMemo(() => {
    return selectedRunIds
      .map((runId) => runs.find((run) => run.id === runId))
      .filter((run): run is ExperimentRun => Boolean(run));
  }, [selectedRunIds, runs]);

  const championByStrategy = useMemo(() => {
    const map = new Map<string, string>();
    for (const variant of variants) {
      if (variant.is_champion) {
        map.set(variant.strategy_name, variant.variant_name);
      }
    }
    return map;
  }, [variants]);

  const chartSeries = useMemo(() => {
    return selectedRuns
      .map((run, index) => {
        const points = getEquityPoints(detailsByRunId[run.id]);
        return {
          label: `${run.strategy_name}:${getRunVariantName(run)}`,
          data: points.map((point) => point.equity),
          labels: points.map((point) => new Date(point.t_ms).toLocaleString()),
          variant: SERIES_VARIANTS[index % SERIES_VARIANTS.length],
        };
      })
      .filter((series) => series.data.length > 0);
  }, [selectedRuns, detailsByRunId]);

  const chartLabels = chartSeries[0]?.labels ?? [];

  const toggleRunSelection = useCallback((runId: string) => {
    setSelectedRunIds((previous) => {
      if (previous.includes(runId)) {
        return previous.filter((id) => id !== runId);
      }
      if (previous.length < 2) {
        return [...previous, runId];
      }
      return [previous[1] ?? previous[0] ?? runId, runId].filter(Boolean);
    });
  }, []);

  const handlePromoteRun = useCallback(
    async (run: ExperimentRun) => {
      if (promotingRunId) return;
      setPromotingRunId(run.id);
      setPromotionMessage(null);
      try {
        const variantName = getRunVariantName(run);
        const response = await promoteExperimentRun(run.id, variantName);
        setPromotionMessage(
          `Promoted ${response.strategy_name}:${response.promoted_variant?.variant_name ?? variantName} as champion`
        );
        await loadExperiments();
      } catch (promotionError) {
        setPromotionMessage(
          promotionError instanceof Error ? `Promotion failed: ${promotionError.message}` : "Promotion failed"
        );
      } finally {
        setPromotingRunId(null);
      }
    },
    [promotingRunId, loadExperiments]
  );

  const wrapperClass = compact ? "" : "col-span-4 md:col-span-8 lg:col-span-12";

  return (
    <div className={wrapperClass}>
      <Panel title="STRATEGY LAB" titleRight={`${runs.length} runs`} className={compact ? "h-auto" : "h-[520px]"}>
        <div className="h-full flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="hud-input h-auto min-w-[180px]"
              value={selectedStrategy}
              onChange={(event) => setSelectedStrategy(event.target.value)}
            >
              <option value="all">All Strategies</option>
              {strategyOptions.map((strategy) => (
                <option key={strategy} value={strategy}>
                  {strategy}
                </option>
              ))}
            </select>
            <button className="hud-button" onClick={() => void loadExperiments()} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            {promotionMessage && <span className="text-xs text-hud-cyan">{promotionMessage}</span>}
            {error && <span className="text-xs text-hud-error">{error}</span>}
          </div>

          <div className={compact ? "space-y-3" : "grid grid-cols-1 xl:grid-cols-3 gap-3 flex-1 min-h-0"}>
            <div className={compact ? "space-y-3" : "xl:col-span-2 flex flex-col gap-3 min-h-0"}>
              <div className="border border-hud-line/30 rounded p-2 h-[220px]">
                {chartSeries.length > 0 ? (
                  <LineChart
                    series={chartSeries.map((series) => ({
                      label: series.label,
                      data: series.data,
                      variant: series.variant,
                    }))}
                    labels={chartLabels}
                    showArea={false}
                    showDots={false}
                    animated={false}
                    formatValue={(value) => formatCurrency(readNumber(value))}
                  />
                ) : (
                  <div className="h-full flex items-center justify-center text-hud-text-dim text-sm">
                    Select one or two runs to compare equity curves.
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {selectedRuns.map((run) => {
                  const details = detailsByRunId[run.id];
                  const pnlPct = getSummaryNumber(run, details, ["pnl_pct"]);
                  const maxDrawdown = getSummaryNumber(run, details, ["max_drawdown_pct"]);
                  const pnlUsd = getSummaryNumber(run, details, ["pnl"]);
                  const winRate = details ? getMetricValue(details.metrics, "win_rate") : null;

                  return (
                    <div key={run.id} className="border border-hud-line/30 rounded p-2">
                      <div className="hud-label text-hud-primary mb-1">{run.strategy_name}</div>
                      <div className="hud-value-sm mb-2">{getRunVariantName(run)}</div>
                      <div className="grid grid-cols-2 gap-1 text-xs">
                        <span className="text-hud-text-dim">P&L</span>
                        <span className="text-right">{formatCurrency(pnlUsd)}</span>
                        <span className="text-hud-text-dim">P&L %</span>
                        <span className="text-right">{formatPercent(pnlPct)}</span>
                        <span className="text-hud-text-dim">Max DD</span>
                        <span className="text-right">{formatPercent(maxDrawdown)}</span>
                        <span className="text-hud-text-dim">Win Rate</span>
                        <span className="text-right">{formatPercent(winRate)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={compact ? "" : "min-h-0 flex flex-col"}>
              <div className="border border-hud-line/30 rounded h-full overflow-hidden">
                <div className="grid grid-cols-12 gap-1 px-2 py-2 border-b border-hud-line/30 text-[10px] text-hud-text-dim uppercase tracking-wide">
                  <span className="col-span-4">Strategy / Variant</span>
                  <span className="col-span-2 text-right">P&L%</span>
                  <span className="col-span-2 text-right">Max DD</span>
                  <span className="col-span-4 text-right">Actions</span>
                </div>
                <div className={compact ? "max-h-[280px] overflow-y-auto" : "flex-1 overflow-y-auto"}>
                  {runs.length === 0 ? (
                    <div className="text-sm text-hud-text-dim text-center py-6">No experiment runs available yet.</div>
                  ) : (
                    runs.map((run) => {
                      const details = detailsByRunId[run.id];
                      const variantName = getRunVariantName(run);
                      const championVariant = championByStrategy.get(run.strategy_name);
                      const isChampion = championVariant === variantName;
                      const pnlPct = getSummaryNumber(run, details, ["pnl_pct"]);
                      const maxDrawdown = getSummaryNumber(run, details, ["max_drawdown_pct"]);
                      const selected = selectedRunIds.includes(run.id);

                      return (
                        <div key={run.id} className="grid grid-cols-12 gap-1 px-2 py-2 border-b border-hud-line/10 text-xs">
                          <div className="col-span-4 min-w-0">
                            <div className="truncate text-hud-text">{run.strategy_name}</div>
                            <div className="truncate text-hud-text-dim">
                              {variantName}
                              {isChampion ? " [CHAMP]" : ""}
                            </div>
                          </div>
                          <div className="col-span-2 text-right">{formatPercent(pnlPct)}</div>
                          <div className="col-span-2 text-right">{formatPercent(maxDrawdown)}</div>
                          <div className="col-span-4 flex justify-end gap-1">
                            <button className="hud-button" onClick={() => toggleRunSelection(run.id)}>
                              {selected ? "Selected" : "Compare"}
                            </button>
                            <button
                              className="hud-button"
                              disabled={promotingRunId !== null}
                              onClick={() => void handlePromoteRun(run)}
                            >
                              {promotingRunId === run.id ? "Promoting..." : "Promote"}
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
