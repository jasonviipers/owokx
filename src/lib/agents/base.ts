
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.d";
import type { AgentMessage, AgentStatus, AgentType } from "./protocol";

export interface AgentBaseState {
  lastHeartbeat: number;
  status: AgentStatus["status"];
  config: Record<string, unknown>;
}

export abstract class AgentBase<TState extends AgentBaseState = AgentBaseState> extends DurableObject<Env> {
  protected state: TState;
  protected abstract agentType: AgentType;

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
        return new Response(JSON.stringify({ status: "ok", type: this.agentType }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/message") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        const message = await request.json() as AgentMessage;
        const response = await this.handleMessage(message);
        return new Response(JSON.stringify(response || { ack: true }), {
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

  protected async saveState(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  protected async log(level: "info" | "warn" | "error", message: string, data?: unknown): Promise<void> {
    console.log(`[${this.agentType}] ${level.toUpperCase()}: ${message}`, data ? JSON.stringify(data) : "");
  }

  protected async registerWithSwarm(): Promise<void> {
    if (!this.env.SWARM_REGISTRY) {
        this.log("warn", "Swarm Registry not configured");
        return;
    }
    const registryId = this.env.SWARM_REGISTRY.idFromName("default");
    const registry = this.env.SWARM_REGISTRY.get(registryId);
    
    const status: AgentStatus = {
        id: this.ctx.id.toString(),
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
}
