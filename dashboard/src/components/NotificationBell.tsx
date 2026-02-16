import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import clsx from 'clsx'
import type { AlertHistoryEvent, OvernightActivity, PremarketPlan } from '../types'

interface NotificationBellProps {
  overnightActivity?: OvernightActivity
  premarketPlan?: PremarketPlan | null
  alerts?: AlertHistoryEvent[]
  onAcknowledgeAlert?: (eventId: string) => Promise<void> | void
}

function alertSeverityClass(severity: AlertHistoryEvent['severity']): string {
  if (severity === 'critical') return 'text-hud-error'
  if (severity === 'warning') return 'text-hud-warning'
  return 'text-hud-primary'
}

function formatAlertTime(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Date(parsed).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function NotificationBell({ overnightActivity, premarketPlan, alerts = [], onAcknowledgeAlert }: NotificationBellProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [hasRead, setHasRead] = useState(false)
  const [ackingAlertId, setAckingAlertId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const hasActivity = overnightActivity && (
    overnightActivity.signalsGathered > 0 ||
    overnightActivity.signalsResearched > 0 ||
    overnightActivity.buySignals > 0
  )

  const openAlerts = alerts.filter((alert) => !alert.acknowledged_at)
  const overnightUnread = hasActivity && !hasRead
    ? (overnightActivity?.buySignals || 0) + (premarketPlan?.highConvictionPlays?.length || 0)
    : 0
  const unreadCount = openAlerts.length + overnightUnread

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      setHasRead(true)
    }

    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }

  const handleAcknowledge = async (eventId: string) => {
    if (!onAcknowledgeAlert || ackingAlertId) return
    setAckingAlertId(eventId)
    try {
      await onAcknowledgeAlert(eventId)
    } finally {
      setAckingAlertId(null)
    }
  }

  return (
    <div ref={containerRef} className='relative'>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'relative p-2 transition-colors',
          isOpen ? 'text-hud-primary' : 'text-hud-text-dim hover:text-hud-text'
        )}
      >
        <svg
          width='16'
          height='16'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.5'
          className={clsx(unreadCount > 0 && 'animate-pulse')}
        >
          <path d='M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9' />
          <path d='M13.73 21a2 2 0 0 1-3.46 0' />
        </svg>

        {unreadCount > 0 && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className='absolute -top-0.5 -right-0.5 w-4 h-4 bg-hud-error text-[9px] font-bold rounded-full flex items-center justify-center text-white'
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </motion.span>
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className='absolute right-0 top-full mt-2 w-80 hud-panel z-50'
          >
            <div className='px-3 py-2 border-b border-hud-line flex justify-between items-center'>
              <span className='hud-label'>ALERTS</span>
              <span className='text-[9px] text-hud-text-dim'>{openAlerts.length} open</span>
            </div>

            <div className='p-3 space-y-2 max-h-[190px] overflow-y-auto'>
              {openAlerts.length === 0 ? (
                <div className='text-hud-text-dim text-xs text-center py-2'>No active alerts</div>
              ) : (
                openAlerts.slice(0, 6).map((alert) => (
                  <div key={alert.id} className='border border-hud-line/30 rounded p-2 space-y-1'>
                    <div className='flex items-center justify-between gap-2'>
                      <span className={clsx('hud-label uppercase', alertSeverityClass(alert.severity))}>{alert.severity}</span>
                      <span className='text-[10px] text-hud-text-dim'>{formatAlertTime(alert.occurred_at)}</span>
                    </div>
                    <div className='text-xs text-hud-text'>{alert.title}</div>
                    <div className='text-[10px] text-hud-text-dim leading-tight'>{alert.message}</div>
                    <div className='flex justify-end'>
                      <button
                        className='hud-button'
                        disabled={ackingAlertId === alert.id}
                        onClick={() => void handleAcknowledge(alert.id)}
                      >
                        {ackingAlertId === alert.id ? 'Acking...' : 'Ack'}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className='px-3 py-2 border-y border-hud-line flex justify-between items-center'>
              <span className='hud-label'>OVERNIGHT ACTIVITY</span>
              {overnightActivity?.lastUpdated && (
                <span className='text-[9px] text-hud-text-dim'>
                  {formatTime(overnightActivity.lastUpdated)}
                </span>
              )}
            </div>

            <div className='p-3 space-y-3'>
              {!hasActivity ? (
                <div className='text-hud-text-dim text-xs text-center py-2'>
                  No overnight activity yet
                </div>
              ) : (
                <>
                  <div className='grid grid-cols-2 gap-2'>
                    <ActivityStat
                      label='SIGNALS FOUND'
                      value={overnightActivity?.signalsGathered || 0}
                    />
                    <ActivityStat
                      label='RESEARCHED'
                      value={overnightActivity?.signalsResearched || 0}
                    />
                    <ActivityStat
                      label='BUY SIGNALS'
                      value={overnightActivity?.buySignals || 0}
                      highlight={overnightActivity?.buySignals ? overnightActivity.buySignals > 0 : false}
                    />
                    <ActivityStat
                      label='TWITTER CONF'
                      value={overnightActivity?.twitterConfirmations || 0}
                    />
                  </div>

                  <div className='pt-2 border-t border-hud-line/50'>
                    <div className='flex items-center justify-between mb-2'>
                      <span className='hud-label'>PRE-MARKET PLAN</span>
                      <span className={clsx(
                        'text-[9px] px-1.5 py-0.5 rounded',
                        overnightActivity?.premarketPlanReady
                          ? 'bg-hud-success/20 text-hud-success'
                          : 'bg-hud-text-dim/20 text-hud-text-dim'
                      )}>
                        {overnightActivity?.premarketPlanReady ? 'READY' : 'PENDING'}
                      </span>
                    </div>

                    {premarketPlan && premarketPlan.highConvictionPlays?.length > 0 && (
                      <div className='space-y-1'>
                        <span className='text-[9px] text-hud-text-dim'>HIGH CONVICTION:</span>
                        <div className='flex flex-wrap gap-1'>
                          {premarketPlan.highConvictionPlays.map((symbol) => (
                            <span
                              key={symbol}
                              className='text-xs px-1.5 py-0.5 bg-hud-success/10 text-hud-success border border-hud-success/30 rounded'
                            >
                              {symbol}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {premarketPlan?.marketOutlook && (
                      <p className='text-[10px] text-hud-text-dim mt-2 leading-tight'>
                        {premarketPlan.marketOutlook.slice(0, 100)}
                        {premarketPlan.marketOutlook.length > 100 && '...'}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ActivityStat({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  return (
    <div className='text-center'>
      <div className={clsx(
        'text-lg font-light',
        highlight ? 'text-hud-success' : 'text-hud-text-bright'
      )}>
        {value}
      </div>
      <div className='hud-label'>{label}</div>
    </div>
  )
}
