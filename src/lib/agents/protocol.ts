
export type AgentType = 
  | "scout" 
  | "analyst" 
  | "trader" 
  | "risk_manager" 
  | "learning"
  | "registry";

export type MessageType = "COMMAND" | "EVENT" | "QUERY" | "RESPONSE";
export type MessagePriority = "low" | "normal" | "high" | "critical";

export interface AgentMessage<T = unknown> {
  id: string;
  source: string; // Agent ID or "system"
  target: string; // Agent ID or "broadcast"
  type: MessageType;
  topic: string; // e.g., "analyze_signal", "market_update"
  payload: T;
  timestamp: number;
  correlationId?: string; // For request/response tracking
  replyTo?: string;
  priority?: MessagePriority;
  ttlMs?: number;
  headers?: Record<string, string>;
}

export interface AgentStatus {
  id: string;
  type: AgentType;
  status: "active" | "busy" | "error" | "offline";
  lastHeartbeat: number;
  capabilities: string[];
  metrics?: Record<string, number>;
}

export interface QueuedMessage<T = unknown> {
  queueId: string;
  message: AgentMessage<T>;
  enqueuedAt: number;
  availableAt: number;
  attempts: number;
  maxAttempts: number;
  status: "pending" | "inflight" | "failed";
  lastError?: string;
}

export interface DeliveryStats {
  enqueued: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

export interface SwarmState {
  agents: Record<string, AgentStatus>;
  queue: Record<string, QueuedMessage>;
  queueOrder: string[];
  deadLetterQueue: Record<string, QueuedMessage>;
  subscriptions: Record<string, string[]>;
  deliveryStats: DeliveryStats;
  routingState: Partial<Record<AgentType, number>>;
}

export function createMessageId(prefix = "msg"): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`;
}
