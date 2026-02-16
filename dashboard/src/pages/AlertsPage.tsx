import { useCallback, useEffect, useMemo, useState } from 'react'
import { Panel } from '../components/Panel'
import {
  acknowledgeAlertEvent,
  acknowledgeAlertRule,
  createAlertRule,
  deleteAlertRule,
  fetchAlertHistory,
  fetchAlertRules,
  updateAlertRule,
} from '../lib/api'
import type { AlertHistoryEvent, AlertRule, AlertSeverity } from '../types'

interface AlertsPageProps {
  enabled?: boolean
  compact?: boolean
}

type HistoryFilter = 'all' | 'open' | 'acknowledged'

function severityClass(severity: AlertSeverity): string {
  if (severity === 'critical') return 'text-hud-error'
  if (severity === 'warning') return 'text-hud-warning'
  return 'text-hud-primary'
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Date(parsed).toLocaleString('en-US', { hour12: false })
}

export function AlertsPage({ enabled = true, compact = false }: AlertsPageProps) {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [history, setHistory] = useState<AlertHistoryEvent[]>([])
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('open')
  const [loading, setLoading] = useState(false)
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [newRuleId, setNewRuleId] = useState('')
  const [newRuleTitle, setNewRuleTitle] = useState('')
  const [newRuleDescription, setNewRuleDescription] = useState('')
  const [newRuleSeverity, setNewRuleSeverity] = useState<AlertSeverity>('warning')
  const [newRuleEnabled, setNewRuleEnabled] = useState(true)

  const loadData = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError(null)

    try {
      const acknowledged = historyFilter === 'all' ? undefined : historyFilter === 'acknowledged'
      const [nextRules, nextHistory] = await Promise.all([
        fetchAlertRules({ include_disabled: true, limit: 500 }),
        fetchAlertHistory({ acknowledged, limit: 200 }),
      ])
      setRules(nextRules)
      setHistory(nextHistory)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [enabled, historyFilter])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    if (!message) return
    const timeout = setTimeout(() => setMessage(null), 3000)
    return () => clearTimeout(timeout)
  }, [message])

  const openAlerts = useMemo(() => history.filter((event) => !event.acknowledged_at).length, [history])

  const handleCreateRule = useCallback(async () => {
    if (!newRuleTitle.trim() || creating) return
    setCreating(true)
    setError(null)

    try {
      await createAlertRule({
        id: newRuleId.trim() || undefined,
        title: newRuleTitle,
        description: newRuleDescription,
        enabled: newRuleEnabled,
        default_severity: newRuleSeverity,
      })
      setNewRuleId('')
      setNewRuleTitle('')
      setNewRuleDescription('')
      setNewRuleSeverity('warning')
      setNewRuleEnabled(true)
      setMessage('Alert rule created')
      await loadData()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
    } finally {
      setCreating(false)
    }
  }, [creating, loadData, newRuleDescription, newRuleEnabled, newRuleId, newRuleSeverity, newRuleTitle])

  const handleToggleRule = useCallback(
    async (rule: AlertRule) => {
      if (busyRuleId) return
      setBusyRuleId(rule.id)
      setError(null)

      try {
        const updated = await updateAlertRule(rule.id, { enabled: !rule.enabled })
        setRules((previous) => previous.map((item) => (item.id === updated.id ? updated : item)))
      } catch (updateError) {
        setError(updateError instanceof Error ? updateError.message : String(updateError))
      } finally {
        setBusyRuleId(null)
      }
    },
    [busyRuleId]
  )

  const handleSeverityChange = useCallback(
    async (rule: AlertRule, severity: AlertSeverity) => {
      if (busyRuleId) return
      setBusyRuleId(rule.id)
      setError(null)

      try {
        const updated = await updateAlertRule(rule.id, { default_severity: severity })
        setRules((previous) => previous.map((item) => (item.id === updated.id ? updated : item)))
      } catch (updateError) {
        setError(updateError instanceof Error ? updateError.message : String(updateError))
      } finally {
        setBusyRuleId(null)
      }
    },
    [busyRuleId]
  )

  const handleDeleteRule = useCallback(
    async (ruleId: string) => {
      if (busyRuleId) return
      setBusyRuleId(ruleId)
      setError(null)

      try {
        await deleteAlertRule(ruleId)
        setRules((previous) => previous.filter((rule) => rule.id !== ruleId))
        setMessage('Alert rule deleted')
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
      } finally {
        setBusyRuleId(null)
      }
    },
    [busyRuleId]
  )

  const handleAcknowledgeEvent = useCallback(async (eventId: string) => {
    setError(null)
    try {
      const updated = await acknowledgeAlertEvent(eventId, 'dashboard')
      setHistory((previous) => previous.map((event) => (event.id === updated.id ? updated : event)))
    } catch (ackError) {
      setError(ackError instanceof Error ? ackError.message : String(ackError))
    }
  }, [])

  const handleAcknowledgeRule = useCallback(async (ruleId: string) => {
    setError(null)
    try {
      const acknowledged = await acknowledgeAlertRule(ruleId, 'dashboard')
      if (acknowledged > 0) {
        await loadData()
      }
    } catch (ackError) {
      setError(ackError instanceof Error ? ackError.message : String(ackError))
    }
  }, [loadData])

  const wrapperClass = compact ? '' : 'col-span-4 md:col-span-8 lg:col-span-12'

  return (
    <div className={wrapperClass}>
      <Panel title='ALERT MANAGEMENT' titleRight={`${rules.length} rules / ${openAlerts} open`} className={compact ? 'h-auto' : 'h-[520px]'}>
        <div className='h-full flex flex-col gap-3'>
          <div className='flex flex-wrap items-center gap-2'>
            <button className='hud-button' onClick={() => void loadData()} disabled={loading}>
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
            <select
              className='hud-input h-auto min-w-[160px]'
              value={historyFilter}
              onChange={(event) => setHistoryFilter(event.target.value as HistoryFilter)}
            >
              <option value='open'>Open Alerts</option>
              <option value='all'>All Alerts</option>
              <option value='acknowledged'>Acknowledged</option>
            </select>
            {message && <span className='text-xs text-hud-cyan'>{message}</span>}
            {error && <span className='text-xs text-hud-error'>{error}</span>}
          </div>

          <div className={compact ? 'space-y-3' : 'grid grid-cols-1 xl:grid-cols-3 gap-3 flex-1 min-h-0'}>
            <div className={compact ? 'space-y-3' : 'space-y-3 min-h-0'}>
              <div className='border border-hud-line/30 rounded p-3 space-y-2'>
                <div className='hud-label text-hud-primary'>Create Rule</div>
                <input
                  className='hud-input'
                  placeholder='Rule ID (optional)'
                  value={newRuleId}
                  onChange={(event) => setNewRuleId(event.target.value)}
                />
                <input
                  className='hud-input'
                  placeholder='Title'
                  value={newRuleTitle}
                  onChange={(event) => setNewRuleTitle(event.target.value)}
                />
                <input
                  className='hud-input'
                  placeholder='Description'
                  value={newRuleDescription}
                  onChange={(event) => setNewRuleDescription(event.target.value)}
                />
                <div className='grid grid-cols-2 gap-2'>
                  <select
                    className='hud-input h-auto'
                    value={newRuleSeverity}
                    onChange={(event) => setNewRuleSeverity(event.target.value as AlertSeverity)}
                  >
                    <option value='info'>info</option>
                    <option value='warning'>warning</option>
                    <option value='critical'>critical</option>
                  </select>
                  <label className='flex items-center gap-2 text-xs text-hud-text'>
                    <input
                      type='checkbox'
                      checked={newRuleEnabled}
                      onChange={(event) => setNewRuleEnabled(event.target.checked)}
                    />
                    Enabled
                  </label>
                </div>
                <button className='hud-button w-full' onClick={() => void handleCreateRule()} disabled={creating || !newRuleTitle.trim()}>
                  {creating ? 'Creating...' : 'Create Rule'}
                </button>
              </div>

              <div className={compact ? 'max-h-[220px] overflow-y-auto border border-hud-line/30 rounded' : 'min-h-0 flex-1 overflow-y-auto border border-hud-line/30 rounded'}>
                {rules.length === 0 ? (
                  <div className='text-sm text-hud-text-dim text-center py-6'>No alert rules found.</div>
                ) : (
                  rules.map((rule) => (
                    <div key={rule.id} className='border-b border-hud-line/10 p-2 space-y-2'>
                      <div className='flex items-center justify-between gap-2'>
                        <div className='min-w-0'>
                          <div className='text-sm text-hud-text truncate'>{rule.title}</div>
                          <div className='text-[11px] text-hud-text-dim truncate'>{rule.id}</div>
                        </div>
                        <button className='hud-button' onClick={() => void handleToggleRule(rule)} disabled={busyRuleId === rule.id}>
                          {rule.enabled ? 'Disable' : 'Enable'}
                        </button>
                      </div>

                      <div className='text-[11px] text-hud-text-dim leading-relaxed'>{rule.description || 'No description'}</div>

                      <div className='flex items-center justify-between gap-2'>
                        <select
                          className='hud-input h-auto text-xs max-w-[140px]'
                          value={rule.default_severity}
                          onChange={(event) => void handleSeverityChange(rule, event.target.value as AlertSeverity)}
                        >
                          <option value='info'>info</option>
                          <option value='warning'>warning</option>
                          <option value='critical'>critical</option>
                        </select>
                        <div className='flex gap-1'>
                          <button className='hud-button' onClick={() => void handleAcknowledgeRule(rule.id)}>
                            Ack Open
                          </button>
                          <button className='hud-button' onClick={() => void handleDeleteRule(rule.id)} disabled={busyRuleId === rule.id}>
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className={compact ? '' : 'xl:col-span-2 min-h-0 flex flex-col'}>
              <div className={compact ? 'border border-hud-line/30 rounded max-h-[280px] overflow-y-auto' : 'border border-hud-line/30 rounded h-full overflow-y-auto'}>
                <div className='grid grid-cols-12 gap-1 px-2 py-2 border-b border-hud-line/30 text-[10px] text-hud-text-dim uppercase tracking-wide'>
                  <span className='col-span-2'>Severity</span>
                  <span className='col-span-3'>Rule</span>
                  <span className='col-span-4'>Message</span>
                  <span className='col-span-2 text-right'>Time</span>
                  <span className='col-span-1 text-right'>Ack</span>
                </div>

                {history.length === 0 ? (
                  <div className='text-sm text-hud-text-dim text-center py-6'>No alert events available.</div>
                ) : (
                  history.map((event) => (
                    <div key={event.id} className='grid grid-cols-12 gap-1 px-2 py-2 border-b border-hud-line/10 text-xs'>
                      <div className={`col-span-2 uppercase ${severityClass(event.severity)}`}>{event.severity}</div>
                      <div className='col-span-3 min-w-0'>
                        <div className='truncate text-hud-text'>{event.rule_id}</div>
                        <div className='truncate text-hud-text-dim text-[11px]'>{event.title}</div>
                      </div>
                      <div className='col-span-4 text-hud-text-dim text-[11px] leading-relaxed line-clamp-2'>{event.message}</div>
                      <div className='col-span-2 text-right text-[11px] text-hud-text-dim'>{formatTimestamp(event.occurred_at)}</div>
                      <div className='col-span-1 text-right'>
                        {event.acknowledged_at ? (
                          <span className='text-[11px] text-hud-success'>ACK</span>
                        ) : (
                          <button className='hud-button' onClick={() => void handleAcknowledgeEvent(event.id)}>
                            Ack
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}
