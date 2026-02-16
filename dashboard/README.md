# owokx Dashboard

Frontend UI for the owokx trading agent.

## Local Development

```bash
pnpm --dir dashboard install
pnpm --dir dashboard run dev
```

The Vite dev server runs on `http://localhost:3000` and proxies API requests to `http://localhost:8787` by default.

## Containerized Runtime (Cloudflare Containers)

The production dashboard is deployed as a containerized Worker:

- Worker entry: `dashboard/worker/index.ts`
- Container config: `dashboard/wrangler.container.jsonc`
- Docker image definition: `dashboard/Dockerfile`
- Web server config: `dashboard/nginx.conf`

Deploy commands (from repo root):

```bash
pnpm run deploy:dashboard:container
pnpm run deploy:dashboard:container:production
```

## Quality Checks

```bash
pnpm --dir dashboard run typecheck
pnpm --dir dashboard run check
```

