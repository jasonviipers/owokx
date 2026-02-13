import clsx from 'clsx'

interface MobileNavProps {
  view: 'overview' | 'positions' | 'activity' | 'signals'
  onViewChange: (view: 'overview' | 'positions' | 'activity' | 'signals') => void
}

export function MobileNav({ view, onViewChange }: MobileNavProps) {
  const tabs = [
    { id: 'overview' as const, label: 'Overview', icon: '📊' },
    { id: 'positions' as const, label: 'Positions', icon: '💼' },
    { id: 'activity' as const, label: 'Activity', icon: '📝' },
    { id: 'signals' as const, label: 'Signals', icon: '📡' },
  ]

  return (
    <div className="flex gap-1 p-1 bg-hud-panel border border-hud-line rounded">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onViewChange(tab.id)}
          className={clsx(
            'flex-1 px-3 py-2 rounded transition-all text-xs font-medium',
            view === tab.id
              ? 'bg-hud-primary text-hud-bg'
              : 'text-hud-text-dim hover:text-hud-text hover:bg-hud-line/20'
          )}
        >
          <span className="hidden xs:inline">{tab.icon} </span>
          {tab.label}
        </button>
      ))}
    </div>
  )
}