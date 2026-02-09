
export type AgentType = 
  | "scout" 
  | "analyst" 
  | "trader" 
  | "risk_manager" 
  | "learning"
  | "registry";

export type MessageType = "COMMAND" | "EVENT" | "QUERY" | "RESPONSE";

export interface AgentMessage<T = unknown> {
  id: string;
  source: string; // Agent ID or "system"
  target: string; // Agent ID or "broadcast"
  type: MessageType;
  topic: string; // e.g., "analyze_signal", "market_update"
  payload: T;
  timestamp: number;
  correlationId?: string; // For request/response tracking
}

export interface AgentStatus {
  id: string;
  type: AgentType;
  status: "active" | "busy" | "error" | "offline";
  lastHeartbeat: number;
  capabilities: string[];
  metrics?: Record<string, number>;
}

export interface SwarmState {
  agents: Record<string, AgentStatus>;
}
