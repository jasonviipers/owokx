import clsx from 'clsx'
import { StatusIndicator } from './StatusIndicator'

interface AgentControlsProps {
  enabled: boolean | null
  busy: boolean
  onEnable: () => void
  onDisable: () => void
  message?: { type: 'success' | 'error'; text: string } | null
}

export function AgentControls({
  enabled,
  busy,
  onEnable,
  onDisable,
  message = null,
}: AgentControlsProps) {
  const status = enabled === true ? 'active' : 'inactive'
  const label = enabled === true ? 'AGENT ENABLED' : enabled === false ? 'AGENT DISABLED' : 'AGENT UNKNOWN'

  const buttonLabel = enabled === true ? 'DISABLE AGENT' : 'ENABLE AGENT'
  const buttonAction = enabled === true ? onDisable : onEnable
  const buttonVariant = enabled === true ? 'hud-button-danger' : 'hud-button-success'

  return (
    <div className="flex items-center gap-3">
      <div className="hidden sm:block">
        <StatusIndicator status={status} label={label} pulse={enabled === true && !busy} />
      </div>
      <button
        type="button"
        className={clsx('hud-button min-h-[44px]', buttonVariant)}
        onClick={buttonAction}
        disabled={busy || enabled === null}
      >
        {busy ? 'WORKING…' : buttonLabel}
      </button>
      {message && (
        <span
          className={clsx(
            'hud-label',
            message.type === 'success' ? 'text-hud-success' : 'text-hud-error'
          )}
          role={message.type === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </span>
      )}
    </div>
  )
}
