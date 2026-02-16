import { Container, getContainer } from "@cloudflare/containers";

export class DashboardUi extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
}

type Env = {
  DASHBOARD_UI: DurableObjectNamespace;
  OWOKX_BACKEND: Fetcher;
};

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function rewriteApiPath(pathname: string): string {
  if (pathname === "/api") return "/agent";
  if (pathname.startsWith("/api/swarm/")) return pathname.replace(/^\/api/, "");
  if (pathname === "/api/swarm") return "/swarm";
  return pathname.replace(/^\/api/, "/agent");
}

function proxyToBackend(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (isApiPath(url.pathname)) {
    url.pathname = rewriteApiPath(url.pathname);
  }
  const proxied = new Request(url.toString(), request);
  return env.OWOKX_BACKEND.fetch(proxied);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({
        status: "ok",
        service: "owokx-dashboard",
        timestamp: new Date().toISOString(),
      });
    }

    if (isApiPath(url.pathname) || url.pathname.startsWith("/auth/") || url.pathname === "/auth") {
      return proxyToBackend(request, env);
    }

    const container = getContainer(env.DASHBOARD_UI, "active");
    return container.fetch(request);
  },
};
