
import { AgentBase } from "../lib/agents/base";
import type { AgentMessage, AgentStatus, AgentType, SwarmState } from "../lib/agents/protocol";
import type { Env } from "../env.d";

export class SwarmRegistry extends AgentBase<SwarmState & { lastHeartbeat: number; status: "active"; config: Record<string, unknown> }> {
  protected agentType: AgentType = "registry";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Initialize default state if needed
    if (!this.state.agents) {
      this.state.agents = {};
    }
  }

  protected async onStart(): Promise<void> {
    this.log("info", "Swarm Registry started");
  }

  // Override to avoid self-registration loop or unnecessary calls
  protected async registerWithSwarm(): Promise<void> {
    // I am the registry.
  }

  protected async handleMessage(message: AgentMessage): Promise<unknown> {
    switch (message.topic) {
      case "register":
        return this.handleRegister(message.payload as AgentStatus);
      case "list_agents":
        return this.state.agents;
      case "heartbeat":
        return this.handleHeartbeat(message.source);
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

    if (path === "/health") {
      const activeAgents = Object.values(this.state.agents).filter(a => Date.now() - a.lastHeartbeat < 300_000).length;
      return new Response(JSON.stringify({ healthy: activeAgents > 0, active_agents: activeAgents }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return super.handleCustomFetch(request, url);
  }

  private async handleRegister(status: AgentStatus): Promise<void> {
    this.state.agents[status.id] = {
      ...status,
      lastHeartbeat: Date.now(),
    };
    await this.saveState();
    this.log("info", `Registered agent: ${status.type} (${status.id})`);
  }

  private async handleHeartbeat(agentId: string): Promise<{ success: boolean }> {
    if (this.state.agents[agentId]) {
      this.state.agents[agentId].lastHeartbeat = Date.now();
      this.state.agents[agentId].status = "active";
      await this.saveState();
      return { success: true };
    }
    return { success: false };
  }
}
