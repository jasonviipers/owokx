import type { Env } from "../env.d";
import { AgentBase, type AgentBaseState } from "../lib/agents/base";
import {
  type AgentMessage,
  type AgentStatus,
  type AgentType,
  createMessageId,
  type QueuedMessage,
  type SwarmState,
} from "../lib/agents/protocol";
import { createTelemetry, type TelemetryTags } from "../lib/telemetry";

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
    routingState: {},
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
const REGISTRY_MAINTENANCE_INTERVAL_MS = 15_000;

export class SwarmRegistry extends AgentBase<RegistryState> {
  protected agentType: AgentType = "registry";
  private readonly telemetry = createTelemetry("swarm_registry");

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
      routingState: this.state.routingState ?? {},
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
    await this.scheduleMaintenanceAlarm();
  }

  protected getCapabilities(): string[] {
    return [
      "agent_registry",
      "queueing",
      "pubsub",
      "dispatch",
      "heartbeat_tracking",
      "load_balancing",
      "dead_letter_recovery",
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
      case "requeue_dead_letter":
        return this.requeueDeadLetter(50);
      case "prune_stale_agents":
        return this.pruneStaleAgents(HEARTBEAT_STALE_MS * 2);
      default:
        this.log("warn", `Unknown topic: ${message.topic}`);
        return { error: "Unknown topic" };
    }
  }

  protected async handleCustomFetch(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const telemetryTags: TelemetryTags = {
      path,
      method: request.method.toUpperCase(),
    };
    this.telemetry.increment("http_requests_total", 1, telemetryTags);
    const stopTimer = this.telemetry.startTimer("http_request_latency_ms", telemetryTags);

    const respondJson = (payload: unknown, status = 200): Response => {
      this.telemetry.increment("http_responses_total", 1, { ...telemetryTags, status });
      if (status >= 400) {
        this.telemetry.increment("http_errors_total", 1, { ...telemetryTags, status });
      }
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      if (path === "/register") {
        const status = (await request.json()) as AgentStatus;
        await this.handleRegister(status);
        return respondJson({ success: true });
      }

      if (path === "/agents") {
        return respondJson(this.state.agents);
      }

      if (path === "/subscriptions" && request.method === "GET") {
        const topic = url.searchParams.get("topic");
        const subscriptions = topic ? { [topic]: this.state.subscriptions[topic] ?? [] } : this.state.subscriptions;
        return respondJson({ subscriptions });
      }

      if (path === "/subscriptions/subscribe" && request.method === "POST") {
        const body = (await request.json()) as { agentId?: string; topic?: string };
        if (!body.agentId || !body.topic) {
          return respondJson({ error: "agentId and topic are required" }, 400);
        }
        const ok = await this.subscribeAgent(body.agentId, body.topic);
        return respondJson({ ok });
      }

      if (path === "/subscriptions/unsubscribe" && request.method === "POST") {
        const body = (await request.json()) as { agentId?: string; topic?: string };
        if (!body.agentId || !body.topic) {
          return respondJson({ error: "agentId and topic are required" }, 400);
        }
        const ok = await this.unsubscribeAgent(body.agentId, body.topic);
        return respondJson({ ok });
      }

      if (path === "/queue/enqueue" && request.method === "POST") {
        const body = (await request.json()) as {
          message?: AgentMessage;
          delayMs?: number;
          maxAttempts?: number;
        };
        if (!body.message) {
          return respondJson({ error: "message is required" }, 400);
        }

        const queued = await this.enqueueMessage(body.message, body.delayMs, body.maxAttempts);
        return respondJson({
          ok: true,
          queueId: queued.queueId,
        });
      }

      if (path === "/queue/publish" && request.method === "POST") {
        const body = (await request.json()) as {
          source?: string;
          topic?: string;
          payload?: unknown;
        };

        const topic = String(body.topic ?? "");
        if (!topic) {
          return respondJson({ error: "topic is required" }, 400);
        }

        const result = await this.publishTopic(body.source ?? "system", topic, body.payload);
        return respondJson(result);
      }

      if (path === "/queue/poll" && request.method === "GET") {
        const agentId = url.searchParams.get("agentId");
        if (!agentId) {
          return respondJson({ error: "agentId is required" }, 400);
        }
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        const messages = await this.pollQueueForAgent(agentId, Number.isFinite(limit) ? limit : 20);
        return respondJson({ messages });
      }

      if (path === "/queue/dispatch" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { limit?: number };
        const limit = body.limit ?? 50;
        const result = await this.dispatchQueue(Math.max(1, Math.min(limit, 200)));
        return respondJson(result);
      }

      if (path === "/queue/state" && request.method === "GET") {
        return respondJson({
          queued: this.state.queueOrder.length,
          deadLettered: Object.keys(this.state.deadLetterQueue).length,
          stats: this.state.deliveryStats,
          routingState: this.state.routingState,
          staleAgents: this.countStaleAgents(),
          telemetry: this.telemetry.snapshot(),
        });
      }

      if (path === "/routing/preview" && request.method === "GET") {
        const type = url.searchParams.get("type");
        if (!type) {
          return respondJson({ error: "type is required" }, 400);
        }
        const count = Number.parseInt(url.searchParams.get("count") ?? "3", 10);
        const preview = this.previewRouting(type as AgentType, Number.isFinite(count) ? count : 3);
        return respondJson(preview);
      }

      if (path === "/recovery/requeue-dead-letter" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { limit?: number };
        const limit = Number.isFinite(body.limit) ? Math.max(1, Math.min(Number(body.limit), 500)) : 50;
        const result = await this.requeueDeadLetter(limit);
        return respondJson(result);
      }

      if (path === "/recovery/prune-stale-agents" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { staleMs?: number };
        const staleMs =
          Number.isFinite(body.staleMs) && body.staleMs !== undefined
            ? Math.max(60_000, Number(body.staleMs))
            : HEARTBEAT_STALE_MS * 2;
        const result = await this.pruneStaleAgents(staleMs);
        return respondJson(result);
      }

      if (path === "/health") {
        const activeAgents = Object.values(this.state.agents).filter(
          (a) => Date.now() - a.lastHeartbeat < HEARTBEAT_STALE_MS
        ).length;
        return respondJson({
          healthy: true,
          active_agents: activeAgents,
          total_agents: Object.keys(this.state.agents).length,
          queue_depth: this.state.queueOrder.length,
          dead_letter_depth: Object.keys(this.state.deadLetterQueue).length,
          telemetry: this.telemetry.snapshot(),
        });
      }

      const fallback = await super.handleCustomFetch(request, url);
      const fallbackStatus = fallback.status;
      this.telemetry.increment("http_responses_total", 1, { ...telemetryTags, status: fallbackStatus });
      if (fallbackStatus >= 400) {
        this.telemetry.increment("http_errors_total", 1, { ...telemetryTags, status: fallbackStatus });
      }
      return fallback;
    } catch (error) {
      this.telemetry.increment("http_errors_total", 1, { ...telemetryTags, status: 500 });
      throw error;
    } finally {
      stopTimer();
    }
  }

  private async handleRegister(status: AgentStatus): Promise<void> {
    if (!status.id) return;

    this.state.agents[status.id] = {
      ...status,
      lastHeartbeat: Date.now(),
    };
    if (this.state.routingState[status.type] === undefined) {
      this.state.routingState[status.type] = 0;
    }
    await this.saveState();
    this.telemetry.increment("agents_registered_total", 1, {
      type: status.type,
      status: status.status,
    });
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
      this.telemetry.increment("heartbeat_success_total", 1, {
        status: this.state.agents[agentId].status,
      });
      return { success: true };
    }
    this.telemetry.increment("heartbeat_missing_agent_total", 1);
    return { success: false };
  }

  private async subscribeAgent(agentId: string, topic: string): Promise<boolean> {
    if (!agentId || !topic) return false;
    const current = this.state.subscriptions[topic] ?? [];
    if (!current.includes(agentId)) {
      this.state.subscriptions[topic] = [...current, agentId];
      await this.saveState();
      this.telemetry.increment("subscriptions_added_total", 1, { topic });
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
    this.telemetry.increment("subscriptions_removed_total", 1, { topic });
    return true;
  }

  private async enqueueMessage(message: AgentMessage, delayMs = 0, maxAttempts = 3): Promise<QueuedMessage> {
    const stopTimer = this.telemetry.startTimer("enqueue_latency_ms");
    try {
      if (!this.isValidMessage(message)) {
        this.telemetry.increment("enqueue_invalid_total", 1);
        throw new Error("Invalid message payload");
      }

      const routedMessage = this.resolveMessageTarget(message);

      const queueId = createMessageId("queue");
      const queued: QueuedMessage = {
        queueId,
        message: routedMessage,
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
      const targetType = this.parseTargetAgentType(routedMessage.target);
      this.telemetry.increment("queue_enqueued_total", 1, {
        topic: routedMessage.topic,
        target_type: targetType ?? "direct",
      });
      return queued;
    } finally {
      stopTimer();
    }
  }

  private async publishTopic(source: string, topic: string, payload: unknown): Promise<{ enqueued: number }> {
    const stopTimer = this.telemetry.startTimer("publish_latency_ms", { topic });
    const subscribers = this.state.subscriptions[topic] ?? [];
    let enqueued = 0;

    try {
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

      this.telemetry.increment("publish_events_total", 1, { topic });
      this.telemetry.increment("publish_fanout_total", enqueued, { topic });
      return { enqueued };
    } finally {
      stopTimer();
    }
  }

  private async pollQueueForAgent(agentId: string, limit: number): Promise<AgentMessage[]> {
    const stopTimer = this.telemetry.startTimer("poll_latency_ms");
    const now = Date.now();
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const messages: AgentMessage[] = [];
    const queueIdsToRemove: string[] = [];

    try {
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

      this.telemetry.increment("poll_calls_total", 1);
      this.telemetry.increment("poll_messages_total", messages.length);
      return messages;
    } finally {
      stopTimer();
    }
  }

  private async dispatchQueue(limit: number): Promise<{ delivered: number; failed: number; pending: number }> {
    const stopTimer = this.telemetry.startTimer("dispatch_latency_ms");
    const now = Date.now();
    let delivered = 0;
    let failed = 0;
    const queueIdsToRemove: string[] = [];
    const safeLimit = Math.max(1, Math.min(limit, 200));

    try {
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

        const resolvedMessage = this.resolveMessageTarget(queued.message, true);
        queued.message = resolvedMessage;
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

      this.telemetry.increment("dispatch_runs_total", 1);
      this.telemetry.increment("dispatch_delivered_total", delivered);
      this.telemetry.increment("dispatch_failed_total", failed);

      return {
        delivered,
        failed,
        pending: this.state.queueOrder.length,
      };
    } finally {
      stopTimer();
    }
  }

  private async tryDeliver(queued: QueuedMessage, agentType: AgentType): Promise<boolean> {
    const stopTimer = this.telemetry.startTimer("delivery_latency_ms", { agent_type: agentType });
    const namespace = this.namespaceForAgentType(agentType);
    if (!namespace) {
      this.telemetry.increment("delivery_failed_total", 1, { agent_type: agentType, reason: "namespace_missing" });
      stopTimer();
      return false;
    }

    let targetId: DurableObjectId;
    try {
      targetId = namespace.idFromString(queued.message.target);
    } catch {
      this.telemetry.increment("delivery_failed_total", 1, { agent_type: agentType, reason: "invalid_target_id" });
      stopTimer();
      return false;
    }

    try {
      const stub = namespace.get(targetId);
      const response = await stub.fetch("http://agent/message", {
        method: "POST",
        body: JSON.stringify(queued.message),
      });

      if (response.ok) {
        this.state.deliveryStats.delivered += 1;
        this.telemetry.increment("delivery_success_total", 1, { agent_type: agentType });
        return true;
      }

      this.telemetry.increment("delivery_failed_total", 1, { agent_type: agentType, status: response.status });
      return false;
    } catch {
      this.telemetry.increment("delivery_failed_total", 1, { agent_type: agentType, reason: "exception" });
      return false;
    } finally {
      stopTimer();
    }
  }

  private bumpRetry(queued: QueuedMessage, reason: string): void {
    queued.attempts += 1;
    queued.status = "failed";
    queued.lastError = reason;
    this.state.deliveryStats.failed += 1;
    this.telemetry.increment("queue_retries_total", 1);

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
    this.telemetry.increment("queue_dead_letter_total", 1);
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

  private resolveMessageTarget(message: AgentMessage, allowUnresolved = false): AgentMessage {
    const agentType = this.parseTargetAgentType(message.target);
    if (!agentType) {
      return message;
    }

    const selectedAgentId = this.selectAgentForType(agentType);
    if (!selectedAgentId) {
      if (allowUnresolved) {
        return message;
      }
      throw new Error(`No active agents available for type ${agentType}`);
    }

    return {
      ...message,
      target: selectedAgentId,
      headers: {
        ...(message.headers ?? {}),
        "x-routed-type": agentType,
      },
    };
  }

  private parseTargetAgentType(target: string): AgentType | null {
    if (target.startsWith("type:")) {
      const candidate = target.slice("type:".length);
      return this.isAgentType(candidate) ? candidate : null;
    }
    if (target.startsWith("role:")) {
      const candidate = target.slice("role:".length);
      return this.isAgentType(candidate) ? candidate : null;
    }
    return null;
  }

  private isAgentType(candidate: string): candidate is AgentType {
    return (
      candidate === "scout" ||
      candidate === "analyst" ||
      candidate === "trader" ||
      candidate === "risk_manager" ||
      candidate === "learning" ||
      candidate === "registry"
    );
  }

  private selectAgentForType(agentType: AgentType): string | null {
    const candidates = Object.values(this.state.agents).filter((agent) => agent.type === agentType);
    if (candidates.length === 0) {
      return null;
    }

    const activeCandidates = candidates.filter((agent) => Date.now() - agent.lastHeartbeat <= HEARTBEAT_STALE_MS);
    const pool = activeCandidates.length > 0 ? activeCandidates : candidates;
    const cursor = this.state.routingState[agentType] ?? 0;
    const index = cursor % pool.length;
    const selected = pool[index];
    if (!selected) return null;
    this.state.routingState[agentType] = (cursor + 1) % pool.length;
    return selected.id;
  }

  private previewRouting(
    agentType: AgentType,
    count: number
  ): {
    agentType: AgentType;
    targets: string[];
  } {
    const safeCount = Math.max(1, Math.min(count, 20));
    const targets: string[] = [];
    const originalCursor = this.state.routingState[agentType] ?? 0;
    for (let i = 0; i < safeCount; i += 1) {
      const selected = this.selectAgentForType(agentType);
      if (!selected) break;
      targets.push(selected);
    }
    this.state.routingState[agentType] = originalCursor;
    return { agentType, targets };
  }

  private countStaleAgents(): number {
    const now = Date.now();
    return Object.values(this.state.agents).filter((agent) => now - agent.lastHeartbeat > HEARTBEAT_STALE_MS).length;
  }

  private async requeueDeadLetter(limit: number): Promise<{ requeued: number; remaining: number }> {
    const stopTimer = this.telemetry.startTimer("requeue_dead_letter_latency_ms");
    try {
      const entries = Object.values(this.state.deadLetterQueue)
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
        .slice(0, Math.max(1, Math.min(limit, 500)));

      let requeued = 0;
      for (const entry of entries) {
        try {
          await this.enqueueMessage(entry.message, 0, entry.maxAttempts);
          delete this.state.deadLetterQueue[entry.queueId];
          requeued += 1;
        } catch {
          // Keep in DLQ if still not routable
        }
      }
      await this.saveState();
      this.telemetry.increment("queue_requeued_total", requeued);
      return {
        requeued,
        remaining: Object.keys(this.state.deadLetterQueue).length,
      };
    } finally {
      stopTimer();
    }
  }

  private async pruneStaleAgents(staleMs: number): Promise<{ removed: number; remaining: number }> {
    const stopTimer = this.telemetry.startTimer("prune_stale_agents_latency_ms");
    try {
      const threshold = Date.now() - staleMs;
      const staleAgentIds = Object.values(this.state.agents)
        .filter((agent) => agent.lastHeartbeat < threshold)
        .map((agent) => agent.id);

      if (staleAgentIds.length === 0) {
        this.telemetry.increment("stale_agents_pruned_total", 0);
        return { removed: 0, remaining: Object.keys(this.state.agents).length };
      }

      const staleSet = new Set(staleAgentIds);
      for (const agentId of staleAgentIds) {
        delete this.state.agents[agentId];
      }

      for (const topic in this.state.subscriptions) {
        const subscribers = this.state.subscriptions[topic];
        if (!subscribers) continue;
        this.state.subscriptions[topic] = subscribers.filter((id) => !staleSet.has(id));
        if (this.state.subscriptions[topic].length === 0) {
          delete this.state.subscriptions[topic];
        }
      }

      await this.saveState();
      this.telemetry.increment("stale_agents_pruned_total", staleAgentIds.length);
      return {
        removed: staleAgentIds.length,
        remaining: Object.keys(this.state.agents).length,
      };
    } finally {
      stopTimer();
    }
  }

  private async scheduleMaintenanceAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + REGISTRY_MAINTENANCE_INTERVAL_MS);
  }

  async alarm(): Promise<void> {
    this.telemetry.increment("maintenance_runs_total", 1);
    const stopTimer = this.telemetry.startTimer("maintenance_latency_ms");
    try {
      await this.dispatchQueue(200);
      await this.pruneStaleAgents(HEARTBEAT_STALE_MS * 3);
    } catch (error) {
      this.telemetry.increment("maintenance_errors_total", 1);
      throw error;
    } finally {
      await this.scheduleMaintenanceAlarm();
      stopTimer();
    }
  }
}
