import { motion } from 'motion/react'
import clsx from 'clsx'
import { Panel } from './Panel'
import { StatusIndicator } from './StatusIndicator'
import type { SwarmStatus } from '../types'

interface SwarmDashboardProps {
  swarm?: SwarmStatus
}

export function SwarmDashboard({ swarm }: SwarmDashboardProps) {
  if (!swarm) {
    return (
      <Panel title="SWARM NETWORK" className="h-full">
        <div className="flex items-center justify-center h-40 text-hud-text-dim">
          Swarm data unavailable
        </div>
      </Panel>
    )
  }

  const agents = Object.values(swarm.agents || {})

  return (
    <Panel 
      title="SWARM NETWORK" 
      titleRight={
        <div className="flex items-center gap-2">
           <StatusIndicator 
             status={swarm.healthy ? 'active' : 'warning'} 
             label={swarm.healthy ? 'HEALTHY' : 'DEGRADED'}
             pulse={swarm.healthy}
           />
           <span className="text-hud-text-dim">|</span>
           <span className="text-hud-text-dim">{swarm.active_agents} ACTIVE</span>
        </div>
      }
      className="h-full"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {agents.map((agent) => {
          const isAlive = Date.now() - agent.lastHeartbeat < 300_000 // 5 min
          return (
            <motion.div
              key={agent.id}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className={clsx(
                "p-3 rounded border bg-hud-panel/50 backdrop-blur-sm transition-colors hover:bg-hud-panel/80",
                isAlive ? "border-hud-line/50" : "border-hud-error/30"
              )}
            >
              <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2">
                  <div className={clsx(
                    "w-2 h-2 rounded-full",
                    isAlive ? "bg-hud-success shadow-[0_0_8px_rgba(var(--color-hud-success),0.5)]" : "bg-hud-error"
                  )} />
                  <span className="hud-label text-hud-text-bright">{agent.type.toUpperCase()}</span>
                </div>
                <span className="text-[10px] text-hud-text-dim font-mono">
                  {agent.id.slice(0, 8)}
                </span>
              </div>
              
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-hud-text-dim">Status</span>
                  <span className={clsx(
                    agent.status === 'active' ? 'text-hud-success' : 'text-hud-warning'
                  )}>
                    {agent.status.toUpperCase()}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-hud-text-dim">Last Heartbeat</span>
                  <span className={clsx(
                    "font-mono",
                    Date.now() - agent.lastHeartbeat > 60000 ? "text-hud-warning" : "text-hud-text"
                  )}>
                    {Math.floor((Date.now() - agent.lastHeartbeat) / 1000)}s ago
                  </span>
                </div>
                
                {agent.metadata && Object.keys(agent.metadata).length > 0 && (
                   <div className="pt-2 mt-2 border-t border-hud-line/20 text-[10px] text-hud-text-dim space-y-0.5">
                      {Object.entries(agent.metadata).slice(0, 2).map(([k, v]) => (
                        <div key={k} className="flex justify-between">
                          <span className="opacity-70">{k}</span>
                          <span className="font-mono">{String(v).slice(0, 15)}</span>
                        </div>
                      ))}
                   </div>
                )}
              </div>
            </motion.div>
          )
        })}
        {agents.length === 0 && (
          <div className="col-span-full text-center py-8 text-hud-text-dim">
            No agents registered in swarm
          </div>
        )}
      </div>
    </Panel>
  )
}
