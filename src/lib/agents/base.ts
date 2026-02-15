import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.d";
import { resolveShardKey } from "../sharding";
import {
  type AgentMessage,
  type AgentStatus,
  type AgentType,
  createMessageId,
  type MessagePriority,
  type MessageType,
} from "./protocol";

export interface AgentBaseState {
  lastHeartbeat: number;
  status: AgentStatus["status"];
  config: Record<string, unknown>;
}

interface SendMessageOptions {
  type?: MessageType;
  correlationId?: string;
  replyTo?: string;
  priority?: MessagePriority;
  ttlMs?: number;
  headers?: Record<string, string>;
  delayMs?: number;
  maxAttempts?: number;
}

interface PollResult {
  messages?: AgentMessage[];
}

export abstract class AgentBase<TState extends AgentBaseState = AgentBaseState> extends DurableObject<Env> {
  protected state: TState;
  protected abstract agentType: AgentType;
  private readonly heartbeatIntervalMs = 60_000;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = {
      lastHeartbeat: Date.now(),
      status: "active",
      config: {},
    } as TState;

    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<TState>("state");
      if (stored) {
        this.state = { ...this.state, ...stored };
      }
      await this.onStart();
      await this.registerWithSwarm();
      await this.scheduleHeartbeat();
    });
  }

  protected async onStart(): Promise<void> {
    // Override in subclasses
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            type: this.agentType,
            agentId: this.getAgentId(),
            lastHeartbeat: this.state.lastHeartbeat,
          }),
          {
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (path === "/message") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        const message = (await request.json()) as AgentMessage;
        const response = await this.handleMessage(message);
        return new Response(JSON.stringify(response || { ack: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/swarm/poll") {
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        const messages = await this.pollInbox(Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 20);
        return new Response(JSON.stringify({ messages }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/swarm/subscribe") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        const body = (await request.json()) as { topic?: string };
        if (!body.topic) {
          return new Response(JSON.stringify({ error: "Missing topic" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const ok = await this.subscribe(body.topic);
        return new Response(JSON.stringify({ ok }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/swarm/unsubscribe") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        const body = (await request.json()) as { topic?: string };
        if (!body.topic) {
          return new Response(JSON.stringify({ error: "Missing topic" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const ok = await this.unsubscribe(body.topic);
        return new Response(JSON.stringify({ ok }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/state") {
        return new Response(JSON.stringify(this.state), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Allow subclasses to handle custom routes
      return this.handleCustomFetch(request, url);
    } catch (error) {
      console.error(`[${this.agentType}] Error handling request:`, error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  protected async handleCustomFetch(_request: Request, _url: URL): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  protected abstract handleMessage(message: AgentMessage): Promise<unknown>;

  protected getAgentId(): string {
    return this.ctx.id.toString();
  }

  protected async saveState(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  protected log(level: "info" | "warn" | "error", message: string, data?: unknown): void {
    const payload = {
      provider: "agent",
      agent: this.agentType,
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(data && typeof data === "object" ? (data as Record<string, unknown>) : data ? { data } : {}),
    };
    console.log(JSON.stringify(payload));
  }

  protected async registerWithSwarm(): Promise<void> {
    if (this.agentType === "registry") return;

    const registry = this.getRegistryStub();
    if (!registry) {
      this.log("warn", "Swarm Registry not configured");
      return;
    }

    const status: AgentStatus = {
      id: this.getAgentId(),
      type: this.agentType,
      status: this.state.status,
      lastHeartbeat: Date.now(),
      capabilities: this.getCapabilities(),
    };

    await registry.fetch("http://registry/register", {
      method: "POST",
      body: JSON.stringify(status),
    });
  }

  protected getCapabilities(): string[] {
    return [];
  }

  protected async sendMessage<T = unknown>(
    target: string,
    topic: string,
    payload: T,
    options: SendMessageOptions = {}
  ): Promise<AgentMessage<T>> {
    const message: AgentMessage<T> = {
      id: createMessageId("swarm"),
      source: this.getAgentId(),
      target,
      type: options.type ?? "COMMAND",
      topic,
      payload,
      timestamp: Date.now(),
      correlationId: options.correlationId,
      replyTo: options.replyTo,
      priority: options.priority ?? "normal",
      ttlMs: options.ttlMs,
      headers: options.headers,
    };

    const registry = this.getRegistryStub();
    if (!registry) {
      throw new Error("Swarm Registry not configured");
    }

    await registry.fetch("http://registry/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        message,
        delayMs: options.delayMs,
        maxAttempts: options.maxAttempts,
      }),
    });

    return message;
  }

  protected async publishEvent<T = unknown>(
    topic: string,
    payload: T,
    options: Omit<SendMessageOptions, "type"> = {}
  ): Promise<{ enqueued: number }> {
    const registry = this.getRegistryStub();
    if (!registry) {
      throw new Error("Swarm Registry not configured");
    }

    const response = await registry.fetch("http://registry/queue/publish", {
      method: "POST",
      body: JSON.stringify({
        source: this.getAgentId(),
        topic,
        payload,
        priority: options.priority ?? "normal",
        ttlMs: options.ttlMs,
        headers: options.headers,
      }),
    });

    if (!response.ok) {
      return { enqueued: 0 };
    }

    const data = (await response.json()) as { enqueued?: number };
    return { enqueued: data.enqueued ?? 0 };
  }

  protected async subscribe(topic: string): Promise<boolean> {
    const registry = this.getRegistryStub();
    if (!registry) return false;

    const response = await registry.fetch("http://registry/subscriptions/subscribe", {
      method: "POST",
      body: JSON.stringify({
        agentId: this.getAgentId(),
        topic,
      }),
    });

    return response.ok;
  }

  protected async unsubscribe(topic: string): Promise<boolean> {
    const registry = this.getRegistryStub();
    if (!registry) return false;

    const response = await registry.fetch("http://registry/subscriptions/unsubscribe", {
      method: "POST",
      body: JSON.stringify({
        agentId: this.getAgentId(),
        topic,
      }),
    });

    return response.ok;
  }

  protected async pollInbox(limit = 20): Promise<AgentMessage[]> {
    const registry = this.getRegistryStub();
    if (!registry) return [];

    const safeLimit = Math.max(1, Math.min(limit, 100));
    const response = await registry.fetch(
      `http://registry/queue/poll?agentId=${encodeURIComponent(this.getAgentId())}&limit=${safeLimit}`
    );
    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as PollResult;
    return Array.isArray(data.messages) ? data.messages : [];
  }

  protected async processInbox(limit = 20): Promise<number> {
    const messages = await this.pollInbox(limit);
    for (const message of messages) {
      try {
        await this.handleMessage(message);
      } catch (error) {
        this.log("warn", "Failed to process queued message", {
          messageId: message.id,
          topic: message.topic,
          error: String(error),
        });
      }
    }
    return messages.length;
  }

  protected getRegistryStub(): DurableObjectStub | null {
    if (!this.env.SWARM_REGISTRY || this.agentType === "registry") {
      return null;
    }
    const registryId = this.env.SWARM_REGISTRY.idFromName(resolveShardKey(this.env.OWOKX_SHARD_KEY, "default"));
    return this.env.SWARM_REGISTRY.get(registryId);
  }

  // Heartbeat scheduler to keep registry health green
  async alarm(): Promise<void> {
    await this.processInbox(50);
    await this.sendHeartbeat();
    await this.scheduleHeartbeat();
  }

  private async scheduleHeartbeat(): Promise<void> {
    if (this.agentType === "registry") return; // Registry doesn't heartbeat itself
    if (!this.env.SWARM_REGISTRY) return;
    const next = Date.now() + this.heartbeatIntervalMs;
    await this.ctx.storage.setAlarm(next);
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.agentType === "registry") return;
    if (!this.env.SWARM_REGISTRY) return;

    try {
      const registryId = this.env.SWARM_REGISTRY.idFromName(resolveShardKey(this.env.OWOKX_SHARD_KEY, "default"));
      const registry = this.env.SWARM_REGISTRY.get(registryId);
      const message: AgentMessage = {
        id: createMessageId("heartbeat"),
        source: this.getAgentId(),
        target: "registry",
        type: "EVENT",
        topic: "heartbeat",
        payload: null,
        timestamp: Date.now(),
      };

      this.state.lastHeartbeat = Date.now();
      await this.saveState();

      await registry.fetch("http://registry/message", {
        method: "POST",
        body: JSON.stringify(message),
      });
    } catch (err) {
      this.log("warn", "Heartbeat failed", { error: String(err) });
    }
  }
}
