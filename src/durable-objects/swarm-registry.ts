
import { AgentBase, type AgentBaseState } from "../lib/agents/base";
import {
  createMessageId,
  type AgentMessage,
  type AgentStatus,
  type AgentType,
  type QueuedMessage,
  type SwarmState,
} from "../lib/agents/protocol";
import type { Env } from "../env.d";

interface RegistryState extends AgentBaseState, SwarmState {
  lastDispatchAt: number;
}

function createDefaultRegistryState(): RegistryState {
  return {
    lastHeartbeat: Date.now(),
    status: "active",
    config: {},
    agents: {},
    queue: {},
    queueOrder: [],
    deadLetterQueue: {},
    subscriptions: {},
    deliveryStats: {
      enqueued: 0,
      delivered: 0,
      failed: 0,
      deadLettered: 0,
    },
    lastDispatchAt: 0,
  };
}

const HEARTBEAT_STALE_MS = 300_000;

export class SwarmRegistry extends AgentBase<RegistryState> {
  protected agentType: AgentType = "registry";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const defaults = createDefaultRegistryState();
    this.state = {
      ...defaults,
      ...this.state,
      agents: this.state.agents ?? {},
      queue: this.state.queue ?? {},
      queueOrder: this.state.queueOrder ?? [],
      deadLetterQueue: this.state.deadLetterQueue ?? {},
      subscriptions: this.state.subscriptions ?? {},
      deliveryStats: {
        ...defaults.deliveryStats,
        ...(this.state.deliveryStats ?? {}),
      },
    };
  }

  protected async onStart(): Promise<void> {
    this.log("info", "Swarm Registry started", {
      agents: Object.keys(this.state.agents).length,
      queued: this.state.queueOrder.length,
    });
  }

  protected getCapabilities(): string[] {
    return [
      "agent_registry",
      "queueing",
      "pubsub",
      "dispatch",
      "heartbeat_tracking",
    ];
  }

  protected async handleMessage(message: AgentMessage): Promise<unknown> {
    switch (message.topic) {
      case "register":
        return this.handleRegister(message.payload as AgentStatus);
      case "list_agents":
        return this.state.agents;
      case "heartbeat":
        return this.handleHeartbeat(message.source, message.payload as { status?: AgentStatus["status"] } | null);
      case "subscribe":
        return this.subscribeAgent(message.source, String((message.payload as { topic?: string })?.topic ?? ""));
      case "unsubscribe":
        return this.unsubscribeAgent(message.source, String((message.payload as { topic?: string })?.topic ?? ""));
      case "enqueue":
        return this.enqueueMessage(message.payload as AgentMessage);
      case "publish":
        return this.publishTopic(
          message.source,
          String((message.payload as { topic?: string })?.topic ?? ""),
          (message.payload as { payload?: unknown })?.payload
        );
      case "dispatch":
        return this.dispatchQueue(50);
      default:
        this.log("warn", `Unknown topic: ${message.topic}`);
        return { error: "Unknown topic" };
    }
  }

  protected async handleCustomFetch(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;

    if (path === "/register") {
      const status = await request.json() as AgentStatus;
      await this.handleRegister(status);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/agents") {
      return new Response(JSON.stringify(this.state.agents), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/subscriptions" && request.method === "GET") {
      const topic = url.searchParams.get("topic");
      const subscriptions = topic ? { [topic]: this.state.subscriptions[topic] ?? [] } : this.state.subscriptions;
      return new Response(JSON.stringify({ subscriptions }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/subscriptions/subscribe" && request.method === "POST") {
      const body = await request.json() as { agentId?: string; topic?: string };
      if (!body.agentId || !body.topic) {
        return new Response(JSON.stringify({ error: "agentId and topic are required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const ok = await this.subscribeAgent(body.agentId, body.topic);
      return new Response(JSON.stringify({ ok }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/subscriptions/unsubscribe" && request.method === "POST") {
      const body = await request.json() as { agentId?: string; topic?: string };
      if (!body.agentId || !body.topic) {
        return new Response(JSON.stringify({ error: "agentId and topic are required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const ok = await this.unsubscribeAgent(body.agentId, body.topic);
      return new Response(JSON.stringify({ ok }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/queue/enqueue" && request.method === "POST") {
      const body = await request.json() as {
        message?: AgentMessage;
        delayMs?: number;
        maxAttempts?: number;
      };
      if (!body.message) {
        return new Response(JSON.stringify({ error: "message is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const queued = await this.enqueueMessage(body.message, body.delayMs, body.maxAttempts);
      return new Response(JSON.stringify({
        ok: true,
        queueId: queued.queueId,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/queue/publish" && request.method === "POST") {
      const body = await request.json() as {
        source?: string;
        topic?: string;
        payload?: unknown;
      };

      const topic = String(body.topic ?? "");
      if (!topic) {
        return new Response(JSON.stringify({ error: "topic is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const result = await this.publishTopic(body.source ?? "system", topic, body.payload);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/queue/poll" && request.method === "GET") {
      const agentId = url.searchParams.get("agentId");
      if (!agentId) {
        return new Response(JSON.stringify({ error: "agentId is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
      const messages = await this.pollQueueForAgent(agentId, Number.isFinite(limit) ? limit : 20);
      return new Response(JSON.stringify({ messages }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/queue/dispatch" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { limit?: number };
      const limit = body.limit ?? 50;
      const result = await this.dispatchQueue(Math.max(1, Math.min(limit, 200)));
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/queue/state" && request.method === "GET") {
      return new Response(JSON.stringify({
        queued: this.state.queueOrder.length,
        deadLettered: Object.keys(this.state.deadLetterQueue).length,
        stats: this.state.deliveryStats,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/health") {
      const activeAgents = Object.values(this.state.agents).filter((a) => Date.now() - a.lastHeartbeat < HEARTBEAT_STALE_MS).length;
      return new Response(JSON.stringify({
        healthy: true,
        active_agents: activeAgents,
        total_agents: Object.keys(this.state.agents).length,
        queue_depth: this.state.queueOrder.length,
        dead_letter_depth: Object.keys(this.state.deadLetterQueue).length,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return super.handleCustomFetch(request, url);
  }

  private async handleRegister(status: AgentStatus): Promise<void> {
    if (!status.id) return;

    this.state.agents[status.id] = {
      ...status,
      lastHeartbeat: Date.now(),
    };
    await this.saveState();
    this.log("info", `Registered agent: ${status.type} (${status.id})`);
  }

  private async handleHeartbeat(
    agentId: string,
    payload: { status?: AgentStatus["status"] } | null
  ): Promise<{ success: boolean }> {
    if (this.state.agents[agentId]) {
      this.state.agents[agentId].lastHeartbeat = Date.now();
      this.state.agents[agentId].status = payload?.status ?? "active";
      await this.saveState();
      return { success: true };
    }
    return { success: false };
  }

  private async subscribeAgent(agentId: string, topic: string): Promise<boolean> {
    if (!agentId || !topic) return false;
    const current = this.state.subscriptions[topic] ?? [];
    if (!current.includes(agentId)) {
      this.state.subscriptions[topic] = [...current, agentId];
      await this.saveState();
    }
    return true;
  }

  private async unsubscribeAgent(agentId: string, topic: string): Promise<boolean> {
    if (!agentId || !topic) return false;
    const current = this.state.subscriptions[topic] ?? [];
    this.state.subscriptions[topic] = current.filter((id) => id !== agentId);
    if (this.state.subscriptions[topic].length === 0) {
      delete this.state.subscriptions[topic];
    }
    await this.saveState();
    return true;
  }

  private async enqueueMessage(
    message: AgentMessage,
    delayMs = 0,
    maxAttempts = 3
  ): Promise<QueuedMessage> {
    if (!this.isValidMessage(message)) {
      throw new Error("Invalid message payload");
    }

    const queueId = createMessageId("queue");
    const queued: QueuedMessage = {
      queueId,
      message,
      enqueuedAt: Date.now(),
      availableAt: Date.now() + Math.max(0, delayMs),
      attempts: 0,
      maxAttempts: Math.max(1, maxAttempts),
      status: "pending",
    };

    this.state.queue[queueId] = queued;
    this.state.queueOrder.push(queueId);
    this.state.deliveryStats.enqueued += 1;
    await this.saveState();
    return queued;
  }

  private async publishTopic(source: string, topic: string, payload: unknown): Promise<{ enqueued: number }> {
    const subscribers = this.state.subscriptions[topic] ?? [];
    let enqueued = 0;

    for (const target of subscribers) {
      const message: AgentMessage = {
        id: createMessageId("event"),
        source,
        target,
        type: "EVENT",
        topic,
        payload,
        timestamp: Date.now(),
      };
      await this.enqueueMessage(message);
      enqueued += 1;
    }

    return { enqueued };
  }

  private async pollQueueForAgent(agentId: string, limit: number): Promise<AgentMessage[]> {
    const now = Date.now();
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const messages: AgentMessage[] = [];
    const queueIdsToRemove: string[] = [];

    for (const queueId of this.state.queueOrder) {
      if (messages.length >= safeLimit) break;
      const queued = this.state.queue[queueId];
      if (!queued) continue;
      if (queued.message.target !== agentId) continue;
      if (queued.availableAt > now) continue;
      if (this.isExpired(queued)) {
        await this.moveToDeadLetter(queued, "Message expired before poll");
        queueIdsToRemove.push(queueId);
        continue;
      }

      messages.push(queued.message);
      queueIdsToRemove.push(queueId);
      this.state.deliveryStats.delivered += 1;
    }

    if (queueIdsToRemove.length > 0) {
      this.removeQueuedMessages(queueIdsToRemove);
      await this.saveState();
    }

    return messages;
  }

  private async dispatchQueue(limit: number): Promise<{ delivered: number; failed: number; pending: number }> {
    const now = Date.now();
    let delivered = 0;
    let failed = 0;
    const queueIdsToRemove: string[] = [];
    const safeLimit = Math.max(1, Math.min(limit, 200));

    for (const queueId of this.state.queueOrder) {
      if (delivered + failed >= safeLimit) break;
      const queued = this.state.queue[queueId];
      if (!queued) continue;
      if (queued.availableAt > now) continue;

      if (this.isExpired(queued)) {
        await this.moveToDeadLetter(queued, "Message expired before dispatch");
        queueIdsToRemove.push(queueId);
        failed += 1;
        continue;
      }

      const targetStatus = this.state.agents[queued.message.target];
      if (!targetStatus) {
        this.bumpRetry(queued, "Target agent is not registered");
        failed += 1;
        if (queued.attempts >= queued.maxAttempts) {
          await this.moveToDeadLetter(queued, queued.lastError ?? "Target agent unavailable");
          queueIdsToRemove.push(queueId);
        }
        continue;
      }

      if (Date.now() - targetStatus.lastHeartbeat > HEARTBEAT_STALE_MS) {
        continue;
      }

      const deliveredNow = await this.tryDeliver(queued, targetStatus.type);
      if (deliveredNow) {
        queueIdsToRemove.push(queueId);
        delivered += 1;
        continue;
      }

      this.bumpRetry(queued, "Dispatch to target failed");
      failed += 1;

      if (queued.attempts >= queued.maxAttempts) {
        await this.moveToDeadLetter(queued, queued.lastError ?? "Max retry attempts exceeded");
        queueIdsToRemove.push(queueId);
      }
    }

    this.state.lastDispatchAt = Date.now();
    if (queueIdsToRemove.length > 0) {
      this.removeQueuedMessages(queueIdsToRemove);
    }
    await this.saveState();

    return {
      delivered,
      failed,
      pending: this.state.queueOrder.length,
    };
  }

  private async tryDeliver(queued: QueuedMessage, agentType: AgentType): Promise<boolean> {
    const namespace = this.namespaceForAgentType(agentType);
    if (!namespace) {
      return false;
    }

    let targetId: DurableObjectId;
    try {
      targetId = namespace.idFromString(queued.message.target);
    } catch {
      return false;
    }

    const stub = namespace.get(targetId);
    const response = await stub.fetch("http://agent/message", {
      method: "POST",
      body: JSON.stringify(queued.message),
    });

    if (response.ok) {
      this.state.deliveryStats.delivered += 1;
      return true;
    }

    return false;
  }

  private bumpRetry(queued: QueuedMessage, reason: string): void {
    queued.attempts += 1;
    queued.status = "failed";
    queued.lastError = reason;
    this.state.deliveryStats.failed += 1;

    const backoffMs = Math.min(30_000, 1_000 * 2 ** Math.max(0, queued.attempts - 1));
    queued.availableAt = Date.now() + backoffMs;
    queued.status = "pending";
  }

  private async moveToDeadLetter(queued: QueuedMessage, reason: string): Promise<void> {
    this.state.deadLetterQueue[queued.queueId] = {
      ...queued,
      status: "failed",
      lastError: reason,
    };
    this.state.deliveryStats.deadLettered += 1;
  }

  private removeQueuedMessages(queueIds: string[]): void {
    const toRemove = new Set(queueIds);
    for (const queueId of queueIds) {
      delete this.state.queue[queueId];
    }
    this.state.queueOrder = this.state.queueOrder.filter((id) => !toRemove.has(id));
  }

  private isValidMessage(message: AgentMessage): boolean {
    if (!message.id || !message.source || !message.target || !message.topic) {
      return false;
    }
    if (!message.timestamp || !Number.isFinite(message.timestamp)) {
      return false;
    }
    return true;
  }

  private isExpired(queued: QueuedMessage): boolean {
    const ttl = queued.message.ttlMs;
    if (!ttl || ttl <= 0) return false;
    return Date.now() > queued.message.timestamp + ttl;
  }

  private namespaceForAgentType(agentType: AgentType): DurableObjectNamespace | null {
    switch (agentType) {
      case "scout":
        return this.env.DATA_SCOUT;
      case "analyst":
        return this.env.ANALYST;
      case "trader":
        return this.env.TRADER;
      case "risk_manager":
        return this.env.RISK_MANAGER;
      case "learning":
        return this.env.LEARNING_AGENT ?? null;
      case "registry":
        return this.env.SWARM_REGISTRY;
      default:
        return null;
    }
  }

  async alarm(): Promise<void> {
    await this.dispatchQueue(200);
  }
}
