import { useState, useEffect, useMemo, useCallback } from 'react'
import { motion } from 'motion/react'
import clsx from 'clsx'
import { Panel } from './components/Panel'
import { Metric, MetricInline } from './components/Metric'
import { StatusIndicator, StatusBar } from './components/StatusIndicator'
import { SetupWizard } from './components/SetupWizard'
import { LineChart, Sparkline } from './components/LineChart'
import { NotificationBell } from './components/NotificationBell'
import { Tooltip, TooltipContent } from './components/Tooltip'
import { AgentControls } from './components/AgentControls'
import type { AlertHistoryEvent, Config, LogEntry, Signal, Position, SignalResearch, PortfolioSnapshot } from './types'
import { MobileNav } from './components/Mobilenav'
import { ErrorBoundary } from './components/ErrorBoundary'
import { OverviewPage } from './pages/OverviewPage'
import { ExperimentsPage } from './pages/ExperimentsPage'
import { AlertsPage } from './pages/AlertsPage'
import { SettingsPage } from './pages/SettingsPage'
import { SwarmPage } from './pages/SwarmPage'
import { useAgentStatus } from './hooks/useAgentStatus'
import { useLogs } from './hooks/useLogs'
import { useSwarmMetrics } from './hooks/useSwarmMetrics'
import {
  acknowledgeAlertEvent,
  clearSessionToken,
  fetchAlertHistory,
  fetchPortfolioHistory,
  fetchSetupStatus,
  resetAgent,
  saveSessionToken,
  setAgentEnabled,
  type SetupStatusData,
  updateAgentConfig,
} from './lib/api'

declare const __OWOKX_API_URL__: string | undefined

function resolveConfiguredApiOrigin(): string | null {
  const candidate = typeof __OWOKX_API_URL__ === 'string' ? __OWOKX_API_URL__.trim() : ''
  if (!candidate) return null
  try {
    const parsed = new URL(candidate)
    if (typeof window !== 'undefined') {
      const candidateIsLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
      const pageIsLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      if (candidateIsLocal && !pageIsLocal) {
        return null
      }
    }
    return parsed.origin
  } catch {
    return null
  }
}

function resolveDashboardApiOrigin(): string {
  const configuredOrigin = resolveConfiguredApiOrigin()
  if (configuredOrigin) return configuredOrigin
  if (typeof window === 'undefined') return 'http://localhost:8787'
  const { protocol, hostname, host, port } = window.location
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1'
  if (isLocalHost && port !== '8787') {
    return 'http://localhost:8787'
  }
  return `${protocol}//${host}`
}

function normalizeTokenEnvVar(value: unknown): string {
  if (typeof value !== 'string') return 'OWOKX_TOKEN'
  const trimmed = value.trim()
  if (!trimmed) return 'OWOKX_TOKEN'
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? trimmed : 'OWOKX_TOKEN'
}

function buildEnableCurlCommand(apiOrigin: string, tokenEnvVar: string): string {
  return `curl -H "Authorization: Bearer $${tokenEnvVar}" ${apiOrigin}/agent/enable`
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatRatioPercent(value: unknown, digits: number = 0): string {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

function safePercent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  return (numerator / denominator) * 100
}

function getAgentColor(agent: string): string {
  const colors: Record<string, string> = {
    'Analyst': 'text-hud-purple',
    'Executor': 'text-hud-cyan',
    'StockTwits': 'text-hud-success',
    'Reddit': 'text-hud-primary',
    'X': 'text-hud-warning',
    'SEC': 'text-hud-primary',
    'SignalResearch': 'text-hud-cyan',
    'PositionResearch': 'text-hud-purple',
    'Options': 'text-hud-warning',
    'Discord': 'text-hud-text-dim',
    'Crypto': 'text-hud-warning',
    'System': 'text-hud-text-dim',
  }
  return colors[agent] || 'text-hud-text'
}

const NOISY_SYSTEM_ACTIONS = new Set(['alarm_skipped', 'agent_reset'])
const ACTIVITY_EVENT_TYPES = ['all', 'agent', 'trade', 'crypto', 'research', 'system', 'swarm', 'risk', 'data', 'api'] as const
const ACTIVITY_SEVERITIES = ['all', 'debug', 'info', 'warning', 'error', 'critical'] as const
const ACTIVITY_TIME_RANGES = ['15m', '1h', '6h', '24h', '7d', 'all'] as const

type ActivityEventTypeFilter = typeof ACTIVITY_EVENT_TYPES[number]
type ActivitySeverityFilter = typeof ACTIVITY_SEVERITIES[number]
type ActivityTimeRange = typeof ACTIVITY_TIME_RANGES[number]

function isNoisySystemLog(log: LogEntry): boolean {
  return log.agent === 'System' && NOISY_SYSTEM_ACTIONS.has(log.action)
}

function titleCaseAction(action: string): string {
  return action
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function getLogString(log: LogEntry, key: string): string | null {
  const value = log[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function getLogNumber(log: LogEntry, key: string): number | null {
  const value = log[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function truncate(value: string, maxChars: number = 120): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 3)}...`
}

function formatActivityDetails(log: LogEntry): string {
  const summary = (typeof log.description === 'string' && log.description.trim().length > 0 ? log.description.trim() : null)
    ?? getLogString(log, 'reason')
    ?? getLogString(log, 'message')
    ?? getLogString(log, 'error')
    ?? getLogString(log, 'contract')

  const meta: string[] = []
  const symbol = typeof log.symbol === 'string' ? log.symbol.trim() : ''
  if (symbol) meta.push(symbol)

  const confidence = getLogNumber(log, 'confidence')
  if (confidence !== null) meta.push(`conf ${Math.round(confidence * 100)}%`)

  const verdict = getLogString(log, 'verdict')
  if (verdict) meta.push(`verdict ${verdict}`)

  const recommendation = getLogString(log, 'recommendation')
  if (recommendation) meta.push(`reco ${recommendation}`)

  const count = getLogNumber(log, 'count')
  if (count !== null) meta.push(`count ${count}`)

  const source = getLogString(log, 'source')
  if (source) meta.push(`src ${source}`)

  const primary = summary ? truncate(summary) : ''
  const secondary = meta.join(' · ')

  if (primary && secondary) return `${primary} · ${secondary}`
  if (primary) return primary
  return secondary
}

function getActivityTimestampMs(log: LogEntry): number {
  if (typeof log.timestamp_ms === 'number' && Number.isFinite(log.timestamp_ms)) return log.timestamp_ms
  const parsed = Date.parse(log.timestamp)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function getActivityType(log: LogEntry): ActivityEventTypeFilter {
  const eventType = typeof log.event_type === 'string' ? log.event_type.toLowerCase() : ''
  return ACTIVITY_EVENT_TYPES.includes(eventType as ActivityEventTypeFilter)
    ? eventType as ActivityEventTypeFilter
    : 'agent'
}

function getActivitySeverity(log: LogEntry): ActivitySeverityFilter {
  const severity = typeof log.severity === 'string' ? log.severity.toLowerCase() : ''
  return ACTIVITY_SEVERITIES.includes(severity as ActivitySeverityFilter)
    ? severity as ActivitySeverityFilter
    : 'info'
}

function getActivityStatus(log: LogEntry): string {
  return typeof log.status === 'string' && log.status.trim().length > 0 ? log.status.trim().toUpperCase() : 'INFO'
}

function getActivityDescription(log: LogEntry): string {
  const details = formatActivityDetails(log)
  if (details.length > 0) return details
  return titleCaseAction(log.action)
}

function getActivityMetadata(log: LogEntry): Record<string, unknown> {
  if (log.metadata && typeof log.metadata === 'object' && !Array.isArray(log.metadata)) {
    return log.metadata
  }

  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(log)) {
    if (
      key === 'id' ||
      key === 'timestamp' ||
      key === 'timestamp_ms' ||
      key === 'agent' ||
      key === 'action' ||
      key === 'event_type' ||
      key === 'severity' ||
      key === 'status' ||
      key === 'description' ||
      key === 'metadata'
    ) {
      continue
    }
    metadata[key] = value
  }
  return metadata
}

function getActivityTypeBadge(eventType: ActivityEventTypeFilter): string {
  const labels: Record<ActivityEventTypeFilter, string> = {
    all: 'ALL',
    agent: 'AGENT',
    trade: 'TRADE',
    crypto: 'CRYPTO',
    research: 'RESEARCH',
    system: 'SYSTEM',
    swarm: 'SWARM',
    risk: 'RISK',
    data: 'DATA',
    api: 'API',
  }
  return labels[eventType]
}

function getActivityTypeIcon(eventType: ActivityEventTypeFilter): string {
  const icons: Record<ActivityEventTypeFilter, string> = {
    all: '[*]',
    agent: '[A]',
    trade: '[$]',
    crypto: '[C]',
    research: '[R]',
    system: '[S]',
    swarm: '[W]',
    risk: '[!]',
    data: '[D]',
    api: '[P]',
  }
  return icons[eventType]
}

function getActivityTypeClass(eventType: ActivityEventTypeFilter): string {
  const map: Record<ActivityEventTypeFilter, string> = {
    all: 'text-hud-text',
    agent: 'text-hud-primary',
    trade: 'text-hud-cyan',
    crypto: 'text-hud-warning',
    research: 'text-hud-purple',
    system: 'text-hud-text-dim',
    swarm: 'text-hud-success',
    risk: 'text-hud-error',
    data: 'text-hud-primary',
    api: 'text-hud-text',
  }
  return map[eventType]
}

function getSeverityClass(severity: ActivitySeverityFilter): string {
  const map: Record<ActivitySeverityFilter, string> = {
    all: 'text-hud-text',
    debug: 'text-hud-text-dim',
    info: 'text-hud-primary',
    warning: 'text-hud-warning',
    error: 'text-hud-error',
    critical: 'text-hud-error',
  }
  return map[severity]
}

function getStatusClass(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized === 'success') return 'text-hud-success'
  if (normalized === 'failed') return 'text-hud-error'
  if (normalized === 'warning' || normalized === 'skipped') return 'text-hud-warning'
  if (normalized === 'started' || normalized === 'in_progress') return 'text-hud-primary'
  return 'text-hud-text-dim'
}

function timeRangeToMs(range: ActivityTimeRange): number | null {
  if (range === '15m') return 15 * 60 * 1000
  if (range === '1h') return 60 * 60 * 1000
  if (range === '6h') return 6 * 60 * 60 * 1000
  if (range === '24h') return 24 * 60 * 60 * 1000
  if (range === '7d') return 7 * 24 * 60 * 60 * 1000
  return null
}

function isCryptoSymbol(symbol: string, cryptoSymbols: string[] = []): boolean {
  return cryptoSymbols.includes(symbol) || symbol.includes('/USD') || symbol.includes('BTC') || symbol.includes('ETH') || symbol.includes('SOL')
}

function getVerdictColor(verdict: string): string {
  if (verdict === 'BUY') return 'text-hud-success'
  if (verdict === 'SKIP') return 'text-hud-error'
  return 'text-hud-warning'
}

function getQualityColor(quality: string): string {
  if (quality === 'excellent') return 'text-hud-success'
  if (quality === 'good') return 'text-hud-primary'
  if (quality === 'fair') return 'text-hud-warning'
  return 'text-hud-error'
}

function getSentimentColor(score: unknown): string {
  const n = typeof score === 'number' ? score : Number(score)
  if (!Number.isFinite(n)) return 'text-hud-text-dim'
  if (n >= 0.3) return 'text-hud-success'
  if (n <= -0.2) return 'text-hud-error'
  return 'text-hud-warning'
}

function generateMockPriceHistory(currentPrice: number, unrealizedPl: number, points: number = 20): number[] {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return []
  const prices: number[] = []
  const isPositive = unrealizedPl >= 0
  const startPrice = currentPrice * (isPositive ? 0.95 : 1.05)

  for (let i = 0; i < points; i++) {
    const progress = i / (points - 1)
    const trend = startPrice + (currentPrice - startPrice) * progress
    const noise = trend * (Math.random() - 0.5) * 0.02
    prices.push(trend + noise)
  }
  prices[prices.length - 1] = currentPrice
  return prices
}

export default function App() {
  const [authTokenInput, setAuthTokenInput] = useState('')
  const [authSaving, setAuthSaving] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [enableCommandHint, setEnableCommandHint] = useState(() =>
    buildEnableCurlCommand(resolveDashboardApiOrigin(), 'OWOKX_TOKEN')
  )
  const [setupChecked, setSetupChecked] = useState(false)
  const [time, setTime] = useState(new Date())
  const [portfolioHistory, setPortfolioHistory] = useState<PortfolioSnapshot[]>([])
  const [portfolioPeriod, setPortfolioPeriod] = useState<'1D' | '1W' | '1M'>('1D')
  const [agentBusy, setAgentBusy] = useState(false)
  const [agentMessage, setAgentMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [activityEventTypeFilter, setActivityEventTypeFilter] = useState<ActivityEventTypeFilter>('all')
  const [activitySeverityFilter, setActivitySeverityFilter] = useState<ActivitySeverityFilter>('all')
  const [activityTimeRangeFilter, setActivityTimeRangeFilter] = useState<ActivityTimeRange>('24h')
  const [activityExpandedRows, setActivityExpandedRows] = useState<Record<string, boolean>>({})
  const [mobileView, setMobileView] = useState<'overview' | 'positions' | 'activity' | 'signals' | 'lab' | 'alerts'>('overview')
  const [activeAlerts, setActiveAlerts] = useState<AlertHistoryEvent[]>([])

  const statusPollingEnabled = setupChecked && !showSetup
  const { status, error, refresh: refreshStatus, setStatus } = useAgentStatus({
    enabled: statusPollingEnabled,
    pollMs: 5000,
  })
  const activityWindowMs = useMemo(() => timeRangeToMs(activityTimeRangeFilter), [activityTimeRangeFilter])
  const { logs: activityFeed, ready: activityFeedReady } = useLogs({
    enabled: statusPollingEnabled,
    eventType: activityEventTypeFilter,
    severity: activitySeverityFilter,
    timeRangeMs: activityWindowMs,
    pollMs: 10000,
  })
  const { metrics: swarmMetrics } = useSwarmMetrics({ enabled: statusPollingEnabled, pollMs: 10000 })
  
  const [wasConnected, setWasConnected] = useState(false)
  useEffect(() => {
    const isConnected = status?.swarm?.agents?.harness?.status === 'active'
    if (isConnected && !wasConnected) {
      setAgentMessage({ type: 'success', text: 'Orchestrator connected' })
    }
    setWasConnected(!!isConnected)
  }, [status?.swarm?.agents?.harness?.status])

  const checkSetup = useCallback(async () => {
    try {
      const data = await fetchSetupStatus()
      const setupData = (data?.data ?? {}) as SetupStatusData
      const backendEnableCommand = setupData.commands?.enable?.curl
      if (typeof backendEnableCommand === 'string' && backendEnableCommand.trim().length > 0) {
        setEnableCommandHint(backendEnableCommand.trim())
      } else {
        const apiOrigin = typeof setupData.api_origin === 'string' && setupData.api_origin.trim().length > 0
          ? setupData.api_origin.trim()
          : resolveDashboardApiOrigin()
        const tokenEnvVar = normalizeTokenEnvVar(setupData.auth?.token_env_var)
        setEnableCommandHint(buildEnableCurlCommand(apiOrigin, tokenEnvVar))
      }
      if (data.ok && setupData.configured === false) {
        setShowSetup(true)
      }
      setSetupChecked(true)
    } catch {
      setSetupChecked(true)
    }
  }, [])

  useEffect(() => {
    checkSetup()
  }, [checkSetup])

  useEffect(() => {
    if (!statusPollingEnabled) return
    const timeInterval = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timeInterval)
  }, [statusPollingEnabled])

  useEffect(() => {
    setActivityExpandedRows({})
  }, [activityEventTypeFilter, activitySeverityFilter, activityTimeRangeFilter])

  useEffect(() => {
    if (!agentMessage) return
    const timeout = setTimeout(() => setAgentMessage(null), 4000)
    return () => clearTimeout(timeout)
  }, [agentMessage])

  useEffect(() => {
    if (!statusPollingEnabled) return

    const loadPortfolioHistory = async () => {
      try {
        const history = await fetchPortfolioHistory(portfolioPeriod)
        if (history.length > 0) {
          setPortfolioHistory(history)
        }
      } catch {
        // Keep existing chart data when history endpoint is temporarily unavailable.
      }
    }

    void loadPortfolioHistory()
    const historyInterval = setInterval(loadPortfolioHistory, 60000)
    return () => clearInterval(historyInterval)
  }, [statusPollingEnabled, portfolioPeriod])

  useEffect(() => {
    if (!statusPollingEnabled) return
    let cancelled = false

    const loadActiveAlerts = async () => {
      try {
        const alerts = await fetchAlertHistory({ acknowledged: false, limit: 25 })
        if (!cancelled) {
          setActiveAlerts(alerts)
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('[alerts] load_active_failed', String(error))
        }
      }
    }

    void loadActiveAlerts()
    const interval = setInterval(() => {
      void loadActiveAlerts()
    }, 15000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [statusPollingEnabled])

  const handleAcknowledgeNotificationAlert = useCallback(async (eventId: string) => {
    try {
      const event = await acknowledgeAlertEvent(eventId, 'dashboard-notification')
      setActiveAlerts((previous) =>
        previous
          .map((item) => (item.id === event.id ? event : item))
          .filter((item) => !item.acknowledged_at)
      )
    } catch {
      // Bell acknowledge is best-effort; management panel handles retries.
    }
  }, [])

  const handleResetAgent = async () => {
    setAgentMessage(null)
    try {
      const data = await resetAgent()
      if (data.ok === false) {
        throw new Error(data.error || 'Reset failed')
      }
      
      await refreshStatus()
      setAgentMessage({ type: 'success', text: 'Agent reset successfully' })
      setPortfolioHistory([])
      setStatus(null)
      
    } catch (e) {
      setAgentMessage({ type: 'error', text: `Reset failed: ${String(e)}` })
      throw e
    }
  }

  const handleSaveConfig = async (config: Config) => {
    const data = await updateAgentConfig(config)
    if (data.ok && status) {
      setStatus({ ...status, config: data.data ?? config })
    }
  }

  const account = status?.account
  const positions = status?.positions || []
  const brokerError =
    typeof status?.broker_error === 'string' && status.broker_error.trim().length > 0
      ? status.broker_error.trim()
      : null
  const signals = status?.signals || []
  const portfolioRisk = status?.portfolioRisk ?? null
  const signalQuality = status?.signalQuality
  const signalPerformance = status?.signalPerformance
  const logsFromStatus = status?.logs || []
  const agentEnabled = status?.enabled ?? null

  const activityLogs = useMemo(() => {
    const source = activityFeedReady ? activityFeed : logsFromStatus
    const rangeWindowMs = timeRangeToMs(activityTimeRangeFilter)
    const rangeStart = rangeWindowMs !== null ? Date.now() - rangeWindowMs : null
    return source
      .filter((log) => !isNoisySystemLog(log))
      .filter((log) => activityEventTypeFilter === 'all' || getActivityType(log) === activityEventTypeFilter)
      .filter((log) => activitySeverityFilter === 'all' || getActivitySeverity(log) === activitySeverityFilter)
      .filter((log) => rangeStart === null || getActivityTimestampMs(log) >= rangeStart)
      .sort((a, b) => getActivityTimestampMs(b) - getActivityTimestampMs(a))
      .slice(0, 500)
  }, [activityFeedReady, activityFeed, logsFromStatus, activityEventTypeFilter, activitySeverityFilter, activityTimeRangeFilter])

  const activityEmptyText = useMemo(() => {
    if (agentEnabled === false) return 'Agent paused. Enable it to start research and execution activity.'
    if (status?.swarm?.healthy === false) return 'Swarm unhealthy. Activity will resume once quorum is restored.'
    if (activityFeedReady) return 'No activity events match your current filters.'
    if (logsFromStatus.length > 0) return 'No research or trade events yet. Waiting for the next agent cycle.'
    return 'Waiting for research and execution activity...'
  }, [agentEnabled, status?.swarm?.healthy, activityFeedReady, logsFromStatus.length])

  const signalResearchEmptyText = useMemo(() => {
    if (status?.enabled === false) return 'Agent paused.'
    if (status?.swarm?.healthy === false) return 'Swarm unhealthy.'

    const recentResearchLogs = activityLogs
      .filter((log) => getActivityType(log) === 'research' || log.agent === 'SignalResearch')
      .slice(0, 80)

    const authOrCircuit = recentResearchLogs.find((log) =>
      ['auth_error', 'research_skipped_circuit_breaker'].includes(log.action)
    )
    if (authOrCircuit) {
      return getActivityDescription(authOrCircuit)
    }

    const malformedOrFailed = recentResearchLogs.find((log) =>
      ['invalid_llm_json', 'research_failed', 'error'].includes(log.action)
    )
    if (malformedOrFailed) {
      return getActivityDescription(malformedOrFailed)
    }

    const noCandidates = recentResearchLogs.find((log) =>
      ['no_candidates', 'no_candidates_for_broker'].includes(log.action)
    )
    if (noCandidates) {
      return getActivityDescription(noCandidates)
    }

    const filteredForBroker = recentResearchLogs.find((log) => log.action === 'candidates_filtered_by_broker')
    if (filteredForBroker) {
      return getActivityDescription(filteredForBroker)
    }

    const staleCount = recentResearchLogs.filter((log) => log.action === 'stale_data').length
    if (staleCount > 0) {
      return `Candidates rejected by market-data checks (${staleCount}).`
    }

    return 'Researching candidates...'
  }, [status?.enabled, status?.swarm?.healthy, activityLogs])

  const toggleActivityRow = useCallback((rowId: string) => {
    setActivityExpandedRows((prev) => ({ ...prev, [rowId]: !prev[rowId] }))
  }, [])

  const costs = status?.costs || { total_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 }
  const config = status?.config
  const isMarketOpen = status?.clock?.is_open ?? false
  const isStrategyLabEnabled = config?.strategy_promotion_enabled === true

  useEffect(() => {
    if (!isStrategyLabEnabled && mobileView === 'lab') {
      setMobileView('overview')
    }
  }, [isStrategyLabEnabled, mobileView])

  const setAgentEnabledRemote = useCallback(async (nextEnabled: boolean) => {
    if (agentBusy) return
    setAgentBusy(true)
    setAgentMessage(null)
    try {
      const data = await setAgentEnabled(nextEnabled)
      if (data.ok === false) {
        const msg = typeof data.error === 'string' ? data.error : 'Request failed'
        throw new Error(msg)
      }

      await refreshStatus()
      setAgentMessage({ type: 'success', text: nextEnabled ? 'Agent enabled' : 'Agent disabled' })
    } catch (e) {
      setAgentMessage({ type: 'error', text: String(e) })
    } finally {
      setAgentBusy(false)
    }
  }, [agentBusy, refreshStatus])

  const configuredStartingEquity =
    Number.isFinite(config?.starting_equity) && (config?.starting_equity ?? 0) > 0
      ? config!.starting_equity
      : null
  const historyStartingEquity =
    portfolioHistory.length > 0 &&
    Number.isFinite(portfolioHistory[0]?.equity) &&
    (portfolioHistory[0]?.equity ?? 0) > 0
      ? portfolioHistory[0]!.equity
      : null
  const startingEquity =
    configuredStartingEquity ??
    historyStartingEquity ??
    (Number.isFinite(account?.equity) && (account?.equity ?? 0) > 0 ? account!.equity : 0)
  const unrealizedPl = positions.reduce((sum, p) => sum + p.unrealized_pl, 0)
  const totalPl = account && startingEquity > 0 ? account.equity - startingEquity : 0
  const realizedPl = totalPl - unrealizedPl
  const totalPlPct = account && startingEquity > 0 ? safePercent(totalPl, startingEquity) : null

  const positionColors = ['cyan', 'purple', 'yellow', 'blue', 'green'] as const

  const positionPriceHistories = useMemo(() => {
    const histories: Record<string, number[]> = {}
    positions.forEach(pos => {
      histories[pos.symbol] = generateMockPriceHistory(pos.current_price, pos.unrealized_pl)
    })
    return histories
  }, [positions.map(p => p.symbol).join(',')])

  const portfolioChartData = useMemo(() => {
    return portfolioHistory.map(s => s.equity)
  }, [portfolioHistory])

  const portfolioChartLabels = useMemo(() => {
    return portfolioHistory.map(s => {
      const date = new Date(s.timestamp)
      if (portfolioPeriod === '1D') {
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
      }
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    })
  }, [portfolioHistory, portfolioPeriod])

  const { marketMarkers, marketHoursZone } = useMemo(() => {
    if (portfolioPeriod !== '1D' || portfolioHistory.length === 0) {
      return { marketMarkers: undefined, marketHoursZone: undefined }
    }

    const markers: { index: number; label: string; color?: string }[] = []
    let openIndex = -1
    let closeIndex = -1

    portfolioHistory.forEach((s, i) => {
      const date = new Date(s.timestamp)
      const hours = date.getHours()
      const minutes = date.getMinutes()

      if (hours === 9 && minutes >= 30 && minutes < 45 && openIndex === -1) {
        openIndex = i
        markers.push({ index: i, label: 'OPEN', color: 'var(--color-hud-success)' })
      } else if (hours === 16 && minutes === 0 && closeIndex === -1) {
        closeIndex = i
        markers.push({ index: i, label: 'CLOSE', color: 'var(--color-hud-error)' })
      }
    })

    const zone = openIndex >= 0 && closeIndex >= 0
      ? { openIndex, closeIndex }
      : undefined

    return {
      marketMarkers: markers.length > 0 ? markers : undefined,
      marketHoursZone: zone
    }
  }, [portfolioHistory, portfolioPeriod])

  const normalizedPositionSeries = useMemo(() => {
    return positions.map((pos, idx) => {
      const priceHistory = positionPriceHistories[pos.symbol] || []
      if (priceHistory.length < 2) return null
      const startPrice = priceHistory[0]
      if (!Number.isFinite(startPrice) || startPrice === 0) return null
      const normalizedData = priceHistory.map(price => ((price - startPrice) / startPrice) * 100)
      return {
        label: pos.symbol,
        data: normalizedData,
        variant: positionColors[idx % positionColors.length],
      }
    }).filter(Boolean) as { label: string; data: number[]; variant: typeof positionColors[number] }[]
  }, [positions, positionPriceHistories])

  const handleAuthTokenSave = useCallback(async () => {
    const token = authTokenInput.trim()
    if (!token) {
      setAuthSaving(true)
      try {
        await clearSessionToken()
        setAuthError('Session cleared')
        await refreshStatus()
      } catch (e) {
        setAuthError(String(e))
      } finally {
        setAuthSaving(false)
      }
      return
    }
    setAuthSaving(true)
    try {
      await saveSessionToken(token)
      setAuthTokenInput('')
      setAuthError(null)
      await refreshStatus()
    } catch (e) {
      setAuthError(String(e))
    } finally {
      setAuthSaving(false)
    }
  }, [authTokenInput, refreshStatus])

  if (showSetup) {
    return (
      <ErrorBoundary title="SETUP PANEL ERROR">
        <SetupWizard onComplete={() => setShowSetup(false)} />
      </ErrorBoundary>
    )
  }

  const blockingError = authError ?? error
  if (blockingError && !status) {
    const isAuthError = /unauthorized|invalid token|401/i.test(blockingError)
    return (
      <div className="min-h-screen bg-hud-bg flex items-center justify-center p-4 md:p-6">
        <Panel title={isAuthError ? "AUTHENTICATION REQUIRED" : "CONNECTION ERROR"} className="max-w-md w-full">
          <div className="text-center py-8">
            <div className="text-hud-error text-2xl mb-4">{isAuthError ? "NO TOKEN" : "OFFLINE"}</div>
            <p className="text-hud-text-dim text-sm mb-6">{blockingError}</p>
            {isAuthError ? (
              <div className="space-y-4">
                <div className="text-left bg-hud-panel p-4 border border-hud-line">
                  <label className="hud-label block mb-2">API Token</label>
                  <input
                    type="password"
                    className="hud-input w-full mb-2"
                    placeholder="Enter OWOKX_API_TOKEN"
                    value={authTokenInput}
                    onChange={(e) => setAuthTokenInput(e.target.value)}
                  />
                  <button
                    onClick={handleAuthTokenSave}
                    className="hud-button w-full"
                    disabled={authSaving}
                  >
                    {authSaving ? 'Saving...' : 'Save Session'}
                  </button>
                </div>
                <p className="text-hud-text-dim text-xs">
                  Find your token in <code className="text-hud-primary">.dev.vars</code> (local) or Cloudflare secrets (deployed)
                </p>
              </div>
            ) : (
              <p className="text-hud-text-dim text-xs">
                Enable the agent: <code className="text-hud-primary break-all">{enableCommandHint}</code>
              </p>
            )}
          </div>
        </Panel>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-hud-bg flex flex-col">
      <div className="max-w-[1920px] mx-auto p-2 sm:p-4 flex-1 w-full">
        {/* Desktop Header */}
        <header className="hidden md:flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4 pb-3 border-b border-hud-line">
          <div className="flex items-center gap-4 md:gap-6 flex-wrap">
            <div className="flex items-baseline gap-2">
              <span className="text-xl md:text-2xl font-light tracking-tight text-hud-text-bright">
                owokx
              </span>
              <span className="hud-label">v2</span>
            </div>
            <StatusIndicator
              status={isMarketOpen ? 'active' : 'inactive'}
              label={isMarketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}
              pulse={isMarketOpen}
            />
            <div className="hidden lg:block">
              <StatusIndicator
                status={agentEnabled === true ? 'active' : 'inactive'}
                label={agentEnabled === true ? 'AGENT ENABLED' : agentEnabled === false ? 'AGENT DISABLED' : 'AGENT UNKNOWN'}
                pulse={agentEnabled === true && !agentBusy}
              />
            </div>
          </div>
          <div className="flex items-center gap-3 md:gap-6 flex-wrap">
            <StatusBar
              items={[
                { label: 'LLM COST', value: `$${costs.total_usd.toFixed(4)}`, status: costs.total_usd > 1 ? 'warning' : 'active' },
                { label: 'API CALLS', value: costs.calls.toString() },
              ]}
            />
            <NotificationBell
              overnightActivity={status?.overnightActivity}
              premarketPlan={status?.premarketPlan}
              alerts={activeAlerts}
              onAcknowledgeAlert={handleAcknowledgeNotificationAlert}
            />
            <AgentControls
              enabled={agentEnabled}
              busy={agentBusy}
              message={agentMessage}
              onEnable={() => setAgentEnabledRemote(true)}
              onDisable={() => setAgentEnabledRemote(false)}
            />
            <button
              className="hud-label hover:text-hud-primary transition-colors"
              onClick={() => setShowSettings(true)}
            >
              [CONFIG]
            </button>
            <span className="hud-value-sm font-mono hidden lg:inline">
              {time.toLocaleTimeString('en-US', { hour12: false })}
            </span>
          </div>
        </header>

        {/* Mobile Header */}
        <header className="md:hidden flex flex-col gap-3 mb-4 pb-3 border-b border-hud-line">
          <div className="flex justify-between items-center">
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-light tracking-tight text-hud-text-bright">owokx</span>
              <span className="hud-label text-xs">v2</span>
            </div>
            <div className="flex items-center gap-2">
              <NotificationBell
                overnightActivity={status?.overnightActivity}
                premarketPlan={status?.premarketPlan}
                alerts={activeAlerts}
                onAcknowledgeAlert={handleAcknowledgeNotificationAlert}
              />
              <button
                className="hud-label hover:text-hud-primary transition-colors text-xs"
                onClick={() => setShowSettings(true)}
              >
                [CONFIG]
              </button>
            </div>
          </div>
          <div className="flex justify-between items-center gap-2">
            <StatusIndicator
              status={isMarketOpen ? 'active' : 'inactive'}
              label={isMarketOpen ? 'OPEN' : 'CLOSED'}
              pulse={isMarketOpen}
            />
            <StatusIndicator
              status={agentEnabled === true ? 'active' : 'inactive'}
              label={agentEnabled === true ? 'ENABLED' : 'DISABLED'}
              pulse={agentEnabled === true && !agentBusy}
            />
            <span className="hud-value-sm text-xs">${costs.total_usd.toFixed(4)}</span>
          </div>
          <MobileNav view={mobileView} onViewChange={setMobileView} showStrategyLab={isStrategyLabEnabled} />
        </header>

        <OverviewPage>
        {/* Desktop Grid Layout */}
        <div className="hidden md:grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-4">
          {/* Row 1: Account, Positions, LLM Costs */}
          <div className="col-span-4 md:col-span-4 lg:col-span-3">
            <Panel title="ACCOUNT" className="h-full">
              {account ? (
                <div className="space-y-4">
                  <Metric label="EQUITY" value={formatCurrency(account.equity)} size="xl" />
                  <div className="grid grid-cols-2 gap-4">
                    <Metric label="CASH" value={formatCurrency(account.cash)} size="md" />
                    <Metric label="BUYING POWER" value={formatCurrency(account.buying_power)} size="md" />
                  </div>
                  <div className="pt-2 border-t border-hud-line space-y-2">
                    <Metric
                      label="TOTAL P&L"
                      value={`${formatCurrency(totalPl)} (${formatPercent(totalPlPct)})`}
                      size="md"
                      color={totalPl >= 0 ? 'success' : 'error'}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <MetricInline
                        label="REALIZED"
                        value={formatCurrency(realizedPl)}
                        color={realizedPl >= 0 ? 'success' : 'error'}
                      />
                      <MetricInline
                        label="UNREALIZED"
                        value={formatCurrency(unrealizedPl)}
                        color={unrealizedPl >= 0 ? 'success' : 'error'}
                      />
                    </div>
                  </div>
                </div>
              ) : brokerError ? (
                <div className="space-y-2">
                  <div className="text-hud-error text-sm">Broker unavailable</div>
                  <div className="text-hud-text-dim text-xs break-words">{brokerError}</div>
                </div>
              ) : (
                <div className="text-hud-text-dim text-sm">Loading...</div>
              )}
            </Panel>
          </div>

          <div className="col-span-4 md:col-span-4 lg:col-span-5">
            <Panel title="POSITIONS" titleRight={`${positions.length}/${config?.max_positions || 5}`} className="h-full">
              {positions.length === 0 ? (
                <div className="text-hud-text-dim text-sm py-8 text-center">No open positions</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-hud-line/50">
                        <th className="hud-label text-left py-2 px-2">Symbol</th>
                        <th className="hud-label text-right py-2 px-2 hidden sm:table-cell">Qty</th>
                        <th className="hud-label text-right py-2 px-2 hidden md:table-cell">Value</th>
                        <th className="hud-label text-right py-2 px-2">P&L</th>
                        <th className="hud-label text-center py-2 px-2">Trend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((pos: Position) => {
                        const plPct = safePercent(pos.unrealized_pl, pos.market_value - pos.unrealized_pl)
                        const priceHistory = positionPriceHistories[pos.symbol] || []
                        const posEntry = status?.positionEntries?.[pos.symbol]
                        const staleness = status?.stalenessAnalysis?.[pos.symbol]
                        const holdTime = posEntry ? Math.floor((Date.now() - posEntry.entry_time) / 3600000) : null

                        return (
                          <motion.tr
                            key={pos.symbol}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="border-b border-hud-line/20 hover:bg-hud-line/10"
                          >
                            <td className="hud-value-sm py-2 px-2">
                              <Tooltip
                                position="right"
                                content={
                                  <TooltipContent
                                    title={pos.symbol}
                                    items={[
                                      { label: 'Entry Price', value: posEntry ? formatCurrency(posEntry.entry_price) : 'N/A' },
                                      { label: 'Current Price', value: formatCurrency(pos.current_price) },
                                      { label: 'Hold Time', value: holdTime !== null ? `${holdTime}h` : 'N/A' },
                                      { label: 'Entry Sentiment', value: posEntry ? formatRatioPercent(posEntry.entry_sentiment, 0) : 'N/A' },
                                      ...(staleness ? [{
                                        label: 'Staleness',
                                        value: formatRatioPercent(staleness.score, 0),
                                        color: staleness.shouldExit ? 'text-hud-error' : 'text-hud-text'
                                      }] : []),
                                    ]}
                                    description={posEntry?.entry_reason}
                                  />
                                }
                              >
                                <span className="cursor-help border-b border-dotted border-hud-text-dim">
                                  {isCryptoSymbol(pos.symbol, config?.crypto_symbols) && (
                                    <span className="text-hud-warning mr-1">₿</span>
                                  )}
                                  {pos.symbol}
                                </span>
                              </Tooltip>
                            </td>
                            <td className="hud-value-sm text-right py-2 px-2 hidden sm:table-cell">{pos.qty}</td>
                            <td className="hud-value-sm text-right py-2 px-2 hidden md:table-cell">{formatCurrency(pos.market_value)}</td>
                            <td className={clsx(
                              'hud-value-sm text-right py-2 px-2',
                              pos.unrealized_pl >= 0 ? 'text-hud-success' : 'text-hud-error'
                            )}>
                              <div>{formatCurrency(pos.unrealized_pl)}</div>
                              <div className="text-xs opacity-70">{formatPercent(plPct)}</div>
                            </td>
                            <td className="py-2 px-2">
                              <div className="flex justify-center">
                                <Sparkline data={priceHistory} width={60} height={20} />
                              </div>
                            </td>
                          </motion.tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          <div className="col-span-4 md:col-span-8 lg:col-span-4">
            <Panel title="LLM COSTS" className="h-full">
              <div className="grid grid-cols-2 gap-4">
                <Metric label="TOTAL SPENT" value={`$${costs.total_usd.toFixed(4)}`} size="lg" />
                <Metric label="API CALLS" value={costs.calls.toString()} size="lg" />
                <MetricInline label="TOKENS IN" value={costs.tokens_in.toLocaleString()} />
                <MetricInline label="TOKENS OUT" value={costs.tokens_out.toLocaleString()} />
                <MetricInline
                  label="AVG COST/CALL"
                  value={costs.calls > 0 ? `$${(costs.total_usd / costs.calls).toFixed(6)}` : '$0'}
                />
                <MetricInline label="MODEL" value={config?.llm_model || 'gpt-4o-mini'} />
              </div>
            </Panel>
          </div>

          {/* Row 2: Portfolio Performance Chart */}
          <div className="col-span-4 md:col-span-8 lg:col-span-8">
            <Panel
              title="PORTFOLIO PERFORMANCE"
              titleRight={
                <div className="flex gap-2">
                  {(['1D', '1W', '1M'] as const).map(p => (
                    <button
                      key={p}
                      onClick={() => setPortfolioPeriod(p)}
                      className={clsx(
                        'hud-label transition-colors',
                        portfolioPeriod === p ? 'text-hud-primary' : 'text-hud-text-dim hover:text-hud-text'
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              }
              className="h-[320px]"
            >
              {portfolioChartData.length > 1 ? (
                <div className="h-full w-full">
                  <LineChart
                    series={[{ label: 'Equity', data: portfolioChartData, variant: totalPl >= 0 ? 'green' : 'red' }]}
                    labels={portfolioChartLabels}
                    showArea={true}
                    showGrid={true}
                    showDots={false}
                    formatValue={(v) => `$${(v / 1000).toFixed(1)}k`}
                    markers={marketMarkers}
                    marketHours={marketHoursZone}
                  />
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-hud-text-dim text-sm">
                  Collecting performance data...
                </div>
              )}
            </Panel>
          </div>

          <div className="col-span-4 md:col-span-8 lg:col-span-4">
            <Panel title="POSITION PERFORMANCE" titleRight="% CHANGE" className="h-[320px]">
              {positions.length === 0 ? (
                <div className="h-full flex items-center justify-center text-hud-text-dim text-sm">
                  No positions to display
                </div>
              ) : normalizedPositionSeries.length > 0 ? (
                <div className="h-full flex flex-col">
                  <div className="flex flex-wrap gap-3 mb-2 pb-2 border-b border-hud-line/30 shrink-0">
                    {positions.slice(0, 5).map((pos: Position, idx: number) => {
                      const isPositive = pos.unrealized_pl >= 0
                      const plPct = safePercent(pos.unrealized_pl, pos.market_value - pos.unrealized_pl)
                      const color = positionColors[idx % positionColors.length]
                      return (
                        <div key={pos.symbol} className="flex items-center gap-1.5">
                          <div
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: `var(--color-hud-${color})` }}
                          />
                          <span className="hud-value-sm">{pos.symbol}</span>
                          <span className={clsx('hud-label', isPositive ? 'text-hud-success' : 'text-hud-error')}>
                            {formatPercent(plPct)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex-1 min-h-0 w-full">
                    <LineChart
                      series={normalizedPositionSeries.slice(0, 5)}
                      showArea={false}
                      showGrid={true}
                      showDots={false}
                      animated={false}
                      formatValue={(v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—')}
                    />
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-hud-text-dim text-sm">
                  Loading position data...
                </div>
              )}
            </Panel>
          </div>

          <ErrorBoundary title="SWARM PANEL ERROR">
            <SwarmPage swarm={status?.swarm} metrics={swarmMetrics} />
          </ErrorBoundary>

          {isStrategyLabEnabled && (
            <ErrorBoundary title="EXPERIMENTS PANEL ERROR">
              <ExperimentsPage enabled={statusPollingEnabled} compact={false} />
            </ErrorBoundary>
          )}

          <ErrorBoundary title="ALERTS PANEL ERROR">
            <AlertsPage enabled={statusPollingEnabled} />
          </ErrorBoundary>

          <div className="col-span-4 md:col-span-8 lg:col-span-12">
            <Panel title="RISK & SIGNAL QUALITY" className="h-full">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <div className="hud-label text-hud-primary">PORTFOLIO RISK</div>
                  <div className="grid grid-cols-2 gap-2">
                    <MetricInline label="REGIME" value={portfolioRisk?.regime?.toUpperCase() || 'N/A'} />
                    <MetricInline label="LEVERAGE" value={portfolioRisk ? `${portfolioRisk.leverage.toFixed(2)}x` : 'N/A'} />
                    <MetricInline label="VOLATILITY" value={portfolioRisk ? formatRatioPercent(portfolioRisk.realizedVolatility, 2) : 'N/A'} />
                    <MetricInline label="MAX DD" value={portfolioRisk ? formatRatioPercent(portfolioRisk.maxDrawdownPct, 2) : 'N/A'} />
                    <MetricInline label="VaR 95" value={portfolioRisk ? formatRatioPercent(portfolioRisk.valueAtRisk95Pct, 2) : 'N/A'} />
                    <MetricInline label="ES 95" value={portfolioRisk ? formatRatioPercent(portfolioRisk.expectedShortfall95Pct, 2) : 'N/A'} />
                    <MetricInline label="TOP 3 CONC" value={portfolioRisk ? formatRatioPercent(portfolioRisk.concentrationTop3Pct, 1) : 'N/A'} />
                    <MetricInline label="SHARPE*" value={portfolioRisk?.sharpeLike !== undefined ? portfolioRisk.sharpeLike.toFixed(2) : 'N/A'} />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="hud-label text-hud-primary">SIGNAL QUALITY</div>
                  <div className="grid grid-cols-2 gap-2">
                    <MetricInline label="SIGNALS" value={(signalQuality?.totalSignals ?? 0).toString()} />
                    <MetricInline label="SYMBOLS" value={(signalQuality?.uniqueSymbols ?? 0).toString()} />
                    <MetricInline label="OUTLIERS" value={(signalQuality?.outlierCount ?? 0).toString()} color={(signalQuality?.outlierCount || 0) > 0 ? 'warning' : undefined} />
                    <MetricInline label="AVG CORR" value={signalQuality ? formatRatioPercent(signalQuality.averageCorrelation, 0) : 'N/A'} />
                    <MetricInline label="MAX CORR" value={signalQuality ? formatRatioPercent(signalQuality.maxCorrelation, 0) : 'N/A'} color={(signalQuality?.maxCorrelation || 0) >= 0.8 ? 'error' : undefined} />
                    <MetricInline label="FILTERED" value={(signalQuality?.filteredSymbols.length ?? 0).toString()} />
                  </div>
                  <div className="text-xs text-hud-text-dim">
                    {(signalQuality?.highCorrelationPairs || []).slice(0, 2).map((pair) => `${pair.left}/${pair.right} ${formatRatioPercent(pair.correlation, 0)}`).join(' | ') || 'No high-correlation clusters detected'}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="hud-label text-hud-primary">SIGNAL ATTRIBUTION</div>
                  <div className="grid grid-cols-2 gap-2">
                    <MetricInline label="SAMPLES" value={(signalPerformance?.totalSamples ?? 0).toString()} />
                    <MetricInline label="HIT RATE" value={signalPerformance ? formatRatioPercent(signalPerformance.hitRate, 1) : 'N/A'} />
                    <MetricInline label="AVG RETURN" value={signalPerformance ? formatPercent(signalPerformance.avgReturnPct) : 'N/A'} color={(signalPerformance?.avgReturnPct || 0) >= 0 ? 'success' : 'error'} />
                    <MetricInline label="TOP FACTOR" value={signalPerformance?.factorAttribution?.[0]?.factor || 'N/A'} />
                  </div>
                  <div className="text-xs text-hud-text-dim">
                    {(signalPerformance?.topSymbols || []).slice(0, 2).map((row) => `${row.symbol} ${formatPercent(row.avgReturnPct)}`).join(' | ') || 'Insufficient closed-trade samples for attribution'}
                  </div>
                </div>
              </div>
            </Panel>
          </div>

          {/* Row 3: Signals, Activity, Research */}
          <div className="col-span-4 lg:col-span-4">
            <Panel title="ACTIVE SIGNALS" titleRight={signals.length.toString()} className="h-100">
              <div className="overflow-y-auto h-full space-y-1">
                {signals.length === 0 ? (
                  <div className="text-hud-text-dim text-sm py-4 text-center">
                    {status?.enabled === false ? (
                      <span className="text-hud-warning">Agent paused. Enable to gather signals.</span>
                    ) : status?.swarm?.healthy === false ? (
                      <span className="text-hud-error">Swarm unhealthy - Waiting for peers...</span>
                    ) : (
                      "Gathering signals..."
                    )}
                  </div>
                ) : (
                  signals.slice(0, 20).map((sig: Signal, i: number) => (
                    <Tooltip
                      key={`${sig.symbol}-${sig.source}-${i}`}
                      position="right"
                      content={
                        <TooltipContent
                          title={`${sig.symbol} - ${sig.source.toUpperCase()}`}
                          items={[
                            { label: 'Sentiment', value: formatRatioPercent(sig.sentiment, 0), color: getSentimentColor(sig.sentiment) },
                            { label: 'Volume', value: sig.volume },
                            ...(sig.bullish !== undefined ? [{ label: 'Bullish', value: sig.bullish, color: 'text-hud-success' }] : []),
                            ...(sig.bearish !== undefined ? [{ label: 'Bearish', value: sig.bearish, color: 'text-hud-error' }] : []),
                            ...(sig.score !== undefined ? [{ label: 'Score', value: sig.score }] : []),
                            ...(sig.upvotes !== undefined ? [{ label: 'Upvotes', value: sig.upvotes }] : []),
                            ...(sig.momentum !== undefined ? [{ label: 'Momentum', value: `${sig.momentum >= 0 ? '+' : ''}${sig.momentum.toFixed(2)}%` }] : []),
                            ...(sig.price !== undefined ? [{ label: 'Price', value: formatCurrency(sig.price) }] : []),
                          ]}
                          description={sig.reason}
                        />
                      }
                    >
                      <motion.div
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.02 }}
                        className={clsx(
                          "flex items-center justify-between py-1 px-2 border-b border-hud-line/10 hover:bg-hud-line/10 cursor-help",
                          sig.isCrypto && "bg-hud-warning/5"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          {sig.isCrypto && <span className="text-hud-warning text-xs">₿</span>}
                          <span className="hud-value-sm">{sig.symbol}</span>
                          <span className={clsx('hud-label', sig.isCrypto ? 'text-hud-warning' : '')}>{sig.source.toUpperCase()}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {sig.isCrypto && sig.momentum !== undefined ? (
                            <span className={clsx('hud-label hidden sm:inline', sig.momentum >= 0 ? 'text-hud-success' : 'text-hud-error')}>
                              {sig.momentum >= 0 ? '+' : ''}{sig.momentum.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="hud-label hidden sm:inline">VOL {sig.volume}</span>
                          )}
                          <span className={clsx('hud-value-sm', getSentimentColor(sig.sentiment))}>
                            {formatRatioPercent(sig.sentiment, 0)}
                          </span>
                        </div>
                      </motion.div>
                    </Tooltip>
                  ))
                )}
              </div>
            </Panel>
          </div>

          <div className="col-span-6 lg:col-span-4">
            <Panel
              title="ACTIVITY FEED"
              titleRight={
                <div className="flex items-center gap-2">
                  <span className="hud-label text-hud-success">LIVE</span>
                  <span className="hud-label text-hud-text-dim">{activityLogs.length} events</span>
                </div>
              }
              className="h-100"
            >
              <div className="h-full flex flex-col gap-2">
                <div className="grid grid-cols-3 gap-2">
                  <select
                    className="hud-input h-auto text-xs"
                    value={activityEventTypeFilter}
                    onChange={(e) => setActivityEventTypeFilter(e.target.value as ActivityEventTypeFilter)}
                  >
                    {ACTIVITY_EVENT_TYPES.map((eventType) => (
                      <option key={eventType} value={eventType}>
                        {eventType === 'all' ? 'All types' : getActivityTypeBadge(eventType)}
                      </option>
                    ))}
                  </select>
                  <select
                    className="hud-input h-auto text-xs"
                    value={activitySeverityFilter}
                    onChange={(e) => setActivitySeverityFilter(e.target.value as ActivitySeverityFilter)}
                  >
                    {ACTIVITY_SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {severity === 'all' ? 'All severities' : severity.toUpperCase()}
                      </option>
                    ))}
                  </select>
                  <select 
                    className="hud-input h-auto text-xs"
                    value={activityTimeRangeFilter}
                    onChange={(e) => setActivityTimeRangeFilter(e.target.value as ActivityTimeRange)}
                  >
                    {ACTIVITY_TIME_RANGES.map((range) => (
                      <option key={range} value={range}>
                        {range === 'all' ? 'All history' : range}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="overflow-y-auto flex-1 font-mono text-xs space-y-1 pr-1">
                  {activityLogs.length === 0 ? (
                    <div className="text-hud-text-dim py-4 text-center">{activityEmptyText}</div>
                  ) : (
                    activityLogs.map((log: LogEntry, i: number) => {
                      const rowId = log.id || `${log.timestamp}-${log.agent}-${log.action}-${i}`
                      const eventType = getActivityType(log)
                      const severity = getActivitySeverity(log)
                      const statusLabel = getActivityStatus(log)
                      const details = getActivityDescription(log)
                      const metadata = getActivityMetadata(log)
                      const hasMetadata = Object.keys(metadata).length > 0
                      const expanded = !!activityExpandedRows[rowId]

                      return (
                        <motion.div
                          key={rowId}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className={clsx(
                            'py-2 px-2 border rounded border-hud-line/20 bg-hud-panel/30 hover:bg-hud-panel/50 transition-colors',
                            severity === 'error' || severity === 'critical' ? 'border-hud-error/30' : ''
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <span className="text-hud-text-dim shrink-0 hidden sm:inline w-[56px]">
                              {new Date(getActivityTimestampMs(log)).toLocaleTimeString('en-US', { hour12: false })}
                            </span>
                            <span className={clsx('shrink-0 w-[40px] text-right hud-label', getActivityTypeClass(eventType))}>
                              {getActivityTypeIcon(eventType)}
                            </span>
                            <span className={clsx('shrink-0 w-[68px] text-right hud-label', getActivityTypeClass(eventType))}>
                              {getActivityTypeBadge(eventType)}
                            </span>
                            <span className={clsx('shrink-0 w-[90px] text-right', getAgentColor(log.agent))}>
                              {log.agent}
                            </span>
                            <div className="text-hud-text flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <span className="break-words">{titleCaseAction(log.action)}</span>
                                <span className={clsx('hud-label', getSeverityClass(severity))}>{severity.toUpperCase()}</span>
                                <span className={clsx('hud-label', getStatusClass(statusLabel))}>{statusLabel}</span>
                              </div>
                              {details && (
                                <div className="text-hud-text-dim break-words mt-0.5">
                                  {details}
                                </div>
                              )}
                            </div>
                          </div>

                          {hasMetadata && (
                            <div className="mt-2 pl-[56px] sm:pl-[260px]">
                              <button
                                className="hud-label text-hud-primary hover:text-hud-cyan"
                                onClick={() => toggleActivityRow(rowId)}
                              >
                                {expanded ? '[HIDE DETAILS]' : '[SHOW DETAILS]'}
                              </button>
                              {expanded && (
                                <pre className="mt-2 text-[11px] leading-relaxed bg-hud-bg/70 border border-hud-line/20 rounded p-2 text-hud-text-dim overflow-x-auto">
                                  {JSON.stringify(metadata, null, 2)}
                                </pre>
                              )}
                            </div>
                          )}
                        </motion.div>
                      )
                    })
                  )}
                </div>
              </div>
            </Panel>
          </div>

          <div className="col-span-4 lg:col-span-4">
            <Panel title="SIGNAL RESEARCH" titleRight={Object.keys(status?.signalResearch || {}).length.toString()} className="h-100">
              <div className="overflow-y-auto h-full space-y-2">
                {Object.entries(status?.signalResearch || {}).length === 0 ? (
                  <div className="text-hud-text-dim text-sm py-4 text-center">
                    {signalResearchEmptyText}
                  </div>
                ) : (
                  Object.entries(status?.signalResearch || {})
                    .sort(([, a], [, b]) => b.timestamp - a.timestamp)
                    .map(([symbol, research]: [string, SignalResearch]) => (
                      <Tooltip
                        key={symbol}
                        position="left"
                        content={
                          <div className="space-y-2 min-w-[200px]">
                            <div className="hud-label text-hud-primary border-b border-hud-line/50 pb-1">
                              {symbol} DETAILS
                            </div>
                            <div className="space-y-1">
                              <div className="flex justify-between">
                                <span className="text-hud-text-dim">Confidence</span>
                                <span className="text-hud-text-bright">{formatRatioPercent(research.confidence, 0)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-hud-text-dim">Sentiment</span>
                                <span className={getSentimentColor(research.sentiment)}>
                                  {formatRatioPercent(research.sentiment, 0)}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-hud-text-dim">Analyzed</span>
                                <span className="text-hud-text">
                                  {new Date(research.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                                </span>
                              </div>
                            </div>
                            {research.catalysts.length > 0 && (
                              <div className="pt-1 border-t border-hud-line/30">
                                <span className="text-[9px] text-hud-text-dim">CATALYSTS:</span>
                                <ul className="mt-1 space-y-0.5">
                                  {research.catalysts.map((c, i) => (
                                    <li key={i} className="text-[10px] text-hud-success">+ {c}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {research.red_flags.length > 0 && (
                              <div className="pt-1 border-t border-hud-line/30">
                                <span className="text-[9px] text-hud-text-dim">RED FLAGS:</span>
                                <ul className="mt-1 space-y-0.5">
                                  {research.red_flags.map((f, i) => (
                                    <li key={i} className="text-[10px] text-hud-error">- {f}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        }
                      >
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="p-2 border border-hud-line/30 rounded hover:border-hud-line/60 cursor-help transition-colors"
                        >
                          <div className="flex justify-between items-center mb-1">
                            <span className="hud-value-sm">{symbol}</span>
                            <div className="flex items-center gap-2">
                              <span className={clsx('hud-label', getQualityColor(research.entry_quality))}>
                                {research.entry_quality.toUpperCase()}
                              </span>
                              <span className={clsx('hud-value-sm font-bold', getVerdictColor(research.verdict))}>
                                {research.verdict}
                              </span>
                            </div>
                          </div>
                          <p className="text-xs text-hud-text-dim leading-tight mb-1">{research.reasoning}</p>
                          {research.red_flags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {research.red_flags.slice(0, 2).map((flag, i) => (
                                <span key={i} className="text-xs text-hud-error bg-hud-error/10 px-1 rounded">
                                  {flag.slice(0, 30)}...
                                </span>
                              ))}
                            </div>
                          )}
                        </motion.div>
                      </Tooltip>
                    ))
                )}
              </div>
            </Panel>
          </div>
        </div>

        {/* Mobile Responsive Views */}
        <div className="md:hidden space-y-4">
          {mobileView === 'overview' && (
            <>
              <Panel title="ACCOUNT">
                {account ? (
                  <div className="space-y-3">
                    <Metric label="EQUITY" value={formatCurrency(account.equity)} size="lg" />
                    <div className="grid grid-cols-2 gap-3">
                      <Metric label="CASH" value={formatCurrency(account.cash)} size="sm" />
                      <Metric label="POWER" value={formatCurrency(account.buying_power)} size="sm" />
                    </div>
                    <div className="pt-2 border-t border-hud-line">
                      <Metric
                        label="TOTAL P&L"
                        value={`${formatCurrency(totalPl)} (${formatPercent(totalPlPct)})`}
                        size="sm"
                        color={totalPl >= 0 ? 'success' : 'error'}
                      />
                    </div>
                  </div>
                ) : brokerError ? (
                  <div className="space-y-2">
                    <div className="text-hud-error text-sm">Broker unavailable</div>
                    <div className="text-hud-text-dim text-xs break-words">{brokerError}</div>
                  </div>
                ) : (
                  <div className="text-hud-text-dim text-sm">Loading...</div>
                )}
              </Panel>

              <Panel title="PORTFOLIO" className="h-[250px]">
                {portfolioChartData.length > 1 ? (
                  <div className="h-full w-full">
                    <LineChart
                      series={[{ label: 'Equity', data: portfolioChartData, variant: totalPl >= 0 ? 'green' : 'red' }]}
                      labels={portfolioChartLabels}
                      showArea={true}
                      showGrid={false}
                      showDots={false}
                      formatValue={(v) => `$${(v / 1000).toFixed(1)}k`}
                    />
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-hud-text-dim text-sm">
                    Loading...
                  </div>
                )}
              </Panel>

              <Panel title="LLM COSTS">
                <div className="grid grid-cols-2 gap-3">
                  <Metric label="SPENT" value={`$${costs.total_usd.toFixed(4)}`} size="md" />
                  <Metric label="CALLS" value={costs.calls.toString()} size="md" />
                </div>
              </Panel>

              <Panel title="RISK SNAPSHOT">
                <div className="grid grid-cols-2 gap-2">
                  <MetricInline label="REGIME" value={portfolioRisk?.regime?.toUpperCase() || 'N/A'} />
                  <MetricInline label="LEVERAGE" value={portfolioRisk ? `${portfolioRisk.leverage.toFixed(2)}x` : 'N/A'} />
                  <MetricInline label="VaR 95" value={portfolioRisk ? formatRatioPercent(portfolioRisk.valueAtRisk95Pct, 1) : 'N/A'} />
                  <MetricInline label="MAX CORR" value={signalQuality ? formatRatioPercent(signalQuality.maxCorrelation, 0) : 'N/A'} />
                  <MetricInline label="OUTLIERS" value={(signalQuality?.outlierCount ?? 0).toString()} />
                  <MetricInline label="HIT RATE" value={signalPerformance ? formatRatioPercent(signalPerformance.hitRate, 1) : 'N/A'} />
                </div>
              </Panel>
            </>
          )}

          {mobileView === 'positions' && (
            <>
              <Panel title="POSITIONS" titleRight={`${positions.length}/${config?.max_positions || 5}`}>
                {positions.length === 0 ? (
                  <div className="text-hud-text-dim text-sm py-8 text-center">No open positions</div>
                ) : (
                  <div className="space-y-2">
                    {positions.map((pos: Position) => {
                      const plPct = safePercent(pos.unrealized_pl, pos.market_value - pos.unrealized_pl)
                      const priceHistory = positionPriceHistories[pos.symbol] || []
                      
                      return (
                        <div key={pos.symbol} className="p-3 border border-hud-line/30 rounded">
                          <div className="flex justify-between items-start mb-2">
                            <div>
                              <div className="hud-value-sm">{pos.symbol}</div>
                              <div className="text-xs text-hud-text-dim">{pos.qty} shares</div>
                            </div>
                            <div className="text-right">
                              <div className={clsx(
                                'hud-value-sm',
                                pos.unrealized_pl >= 0 ? 'text-hud-success' : 'text-hud-error'
                              )}>
                                {formatCurrency(pos.unrealized_pl)}
                              </div>
                              <div className="text-xs text-hud-text-dim">{formatPercent(plPct)}</div>
                            </div>
                          </div>
                          <Sparkline data={priceHistory} width={200} height={40} />
                        </div>
                      )
                    })}
                  </div>
                )}
              </Panel>
            </>
          )}

          {mobileView === 'activity' && (
            <Panel title="ACTIVITY FEED" className="h-[500px]">
              <div className="h-full flex flex-col gap-2">
                <div className="grid grid-cols-2 gap-2">
                  <select
                    className="hud-input h-auto text-xs"
                    value={activityEventTypeFilter}
                    onChange={(e) => setActivityEventTypeFilter(e.target.value as ActivityEventTypeFilter)}
                  >
                    {ACTIVITY_EVENT_TYPES.map((eventType) => (
                      <option key={eventType} value={eventType}>
                        {eventType === 'all' ? 'All' : getActivityTypeBadge(eventType)}
                      </option>
                    ))}
                  </select>
                  <select 
                    className="hud-input h-auto text-xs"
                    value={activityTimeRangeFilter}
                    onChange={(e) => setActivityTimeRangeFilter(e.target.value as ActivityTimeRange)}
                  >
                    {ACTIVITY_TIME_RANGES.map((range) => (
                      <option key={range} value={range}>
                        {range === 'all' ? 'All' : range}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="overflow-y-auto flex-1 font-mono text-xs space-y-1">
                  {activityLogs.length === 0 ? (
                    <div className="text-hud-text-dim py-4 text-center">{activityEmptyText}</div>
                  ) : (
                    activityLogs.slice(0, 50).map((log: LogEntry, i: number) => {
                      const eventType = getActivityType(log)
                      const details = getActivityDescription(log)

                      return (
                        <div
                          key={i}
                          className="py-2 px-2 border rounded border-hud-line/20 bg-hud-panel/30"
                        >
                          <div className="flex justify-between mb-1">
                            <span className={clsx('hud-label', getActivityTypeClass(eventType))}>
                              {getActivityTypeBadge(eventType)}
                            </span>
                            <span className="text-hud-text-dim text-[10px]">
                              {new Date(getActivityTimestampMs(log)).toLocaleTimeString('en-US', { hour12: false })}
                            </span>
                          </div>
                          <div className="text-hud-text">{titleCaseAction(log.action)}</div>
                          {details && (
                            <div className="text-hud-text-dim text-[10px] mt-1">{details.slice(0, 80)}...</div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </Panel>
          )}

          {isStrategyLabEnabled && mobileView === 'lab' && (
            <ExperimentsPage enabled={statusPollingEnabled} compact={true} />
          )}

          {mobileView === 'alerts' && (
            <AlertsPage enabled={statusPollingEnabled} compact={true} />
          )}

          {mobileView === 'signals' && (
            <>
              <Panel title="ACTIVE SIGNALS" titleRight={signals.length.toString()}>
                <div className="space-y-1">
                  {signals.length === 0 ? (
                    <div className="text-hud-text-dim text-sm py-4 text-center">
                      {status?.enabled === false ? 'Agent paused' : 'Gathering signals...'}
                    </div>
                  ) : (
                    signals.slice(0, 10).map((sig: Signal, i: number) => (
                      <div
                        key={`${sig.symbol}-${sig.source}-${i}`}
                        className="flex items-center justify-between py-2 px-2 border-b border-hud-line/10"
                      >
                        <div className="flex flex-col">
                          <span className="hud-value-sm">{sig.symbol}</span>
                          <span className="hud-label text-xs">{sig.source.toUpperCase()}</span>
                        </div>
                        <span className={clsx('hud-value-sm', getSentimentColor(sig.sentiment))}>
                          {formatRatioPercent(sig.sentiment, 0)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </Panel>

              <Panel title="SIGNAL RESEARCH" titleRight={Object.keys(status?.signalResearch || {}).length.toString()}>
                <div className="space-y-2">
                  {Object.entries(status?.signalResearch || {}).length === 0 ? (
                    <div className="text-hud-text-dim text-sm py-4 text-center">
                      {signalResearchEmptyText}
                    </div>
                  ) : (
                    Object.entries(status?.signalResearch || {})
                      .sort(([, a], [, b]) => b.timestamp - a.timestamp)
                      .slice(0, 5)
                      .map(([symbol, research]: [string, SignalResearch]) => (
                        <div key={symbol} className="p-2 border border-hud-line/30 rounded">
                          <div className="flex justify-between items-center mb-1">
                            <span className="hud-value-sm">{symbol}</span>
                            <span className={clsx('hud-value-sm font-bold', getVerdictColor(research.verdict))}>
                              {research.verdict}
                            </span>
                          </div>
                          <p className="text-xs text-hud-text-dim leading-tight">{research.reasoning.slice(0, 100)}...</p>
                        </div>
                      ))
                  )}
                </div>
              </Panel>
            </>
          )}
        </div>
        </OverviewPage>
      </div>

      <footer className="mt-auto w-full border-t border-hud-line bg-hud-bg">
        <div className="max-w-[1920px] mx-auto px-2 sm:px-4 py-2 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 sm:gap-3">
          <div className="flex flex-wrap gap-2 md:gap-4 text-xs sm:text-sm">
            {config && (
              <>
                <MetricInline label="MAX POS" value={`$${config.max_position_value}`} className="text-xs" />
                <MetricInline label="TAKE PROFIT" value={`${config.take_profit_pct}%`} className="text-xs" />
                <MetricInline label="STOP LOSS" value={`${config.stop_loss_pct}%`} className="text-xs" />
                <MetricInline
                  label="OPTIONS"
                  value={config.options_enabled ? 'ON' : 'OFF'}
                  valueClassName={config.options_enabled ? 'text-hud-purple' : 'text-hud-text-dim'}
                  className="text-xs hidden sm:flex"
                />
                <MetricInline
                  label="CRYPTO"
                  value={config.crypto_enabled ? '24/7' : 'OFF'}
                  valueClassName={config.crypto_enabled ? 'text-hud-warning' : 'text-hud-text-dim'}
                  className="text-xs hidden sm:flex"
                />
              </>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <span className="hud-label hidden md:inline text-xs">AUTONOMOUS TRADING SYSTEM</span>
            <span className="hud-value-sm text-xs">PAPER MODE</span>
          </div>
        </div>
      </footer>

      <ErrorBoundary title="SETTINGS PANEL ERROR">
        <SettingsPage
          show={showSettings}
          config={config}
          onSave={handleSaveConfig}
          onClose={() => setShowSettings(false)}
          onReset={handleResetAgent}
        />
      </ErrorBoundary>
    </div>
  )
}
