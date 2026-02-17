# Deployment and Operations Runbook

This repository now deploys both services natively on Cloudflare in one workflow:

- Backend API: Cloudflare Worker (`wrangler.jsonc`)
- Frontend dashboard: Cloudflare Container Worker (`dashboard/wrangler.container.jsonc` + `dashboard/Dockerfile`)

## Architecture

### Runtime topology

1. Browser sends traffic to the dashboard Worker domain.
2. Dashboard Worker (`dashboard/worker/index.ts`) routes:
   - `/api/*` and `/auth/*` to the backend Worker over a Cloudflare service binding (`OWOKX_BACKEND`).
   - all other paths to the running dashboard container instance (`DashboardUi` class).
3. Backend Worker serves API, Durable Objects, D1, KV, and R2 workloads.

### Why this design

- No external Kubernetes cluster is required.
- Service-to-service traffic stays on Cloudflare's internal network via service bindings.
- Dashboard remains Dockerized, but orchestration and rollout are handled by Cloudflare Containers.

## One-Click Deployment

Trigger from local CLI:

```bash
npm run deploy:oneclick -- --env production --components all
```

Options:

- `--env staging|production`
- `--components all|worker|dashboard`
- `--repo owner/repo`
- `--ref <branch>`

Dispatcher implementation: `scripts/deploy.ts`
Workflow: `.github/workflows/deploy-oneclick.yml`

## Cloudflare Container Configuration

Primary dashboard container config: `dashboard/wrangler.container.jsonc`

Key fields:

- `containers[].image`: points to `./Dockerfile`
- `containers[].max_instances`: horizontal capacity ceiling
- `containers[].instance_type`: container sizing tier
- `containers[].rollout_step_percentage`: progressive rollout steps
- `containers[].rollout_active_grace_period`: health stabilization between rollout steps
- `durable_objects.bindings`: binds the container class (`DashboardUi`)
- `services`: binds backend Worker as `OWOKX_BACKEND`
- `env.production.services[].environment`: targets backend production environment via service binding

Template: `dashboard/wrangler.container.example.jsonc`

## Docker Integration and Image Management

Dashboard image source:

- Dockerfile: `dashboard/Dockerfile`
- Web server config: `dashboard/nginx.conf`

Operational behavior:

- Cloudflare builds and deploys the container image during `wrangler deploy --config dashboard/wrangler.container.jsonc`.
- Container lifecycle is controlled by `sleepAfter`, `max_instances`, and progressive rollout settings.
- Health endpoint used for runtime checks: `/health`.

Optional image mirror workflow (for registry retention/audit): `.github/workflows/container-dashboard.yml`.

## Service Mesh Configuration

Service mesh here is implemented with Cloudflare service bindings:

- Dashboard Worker binding: `OWOKX_BACKEND`
- Binding target (staging): `owokx`
- Binding target (production): `owokx` + `environment = "production"`

This removes public-origin dependency between frontend and backend and keeps internal API traffic private to Cloudflare.

## Environment Variables and Secrets

GitHub Environment Secrets (required):

- `CLOUDFLARE_API_TOKEN`

GitHub Environment Secrets (optional but recommended):

- `CLOUDFLARE_ACCOUNT_ID`
- `OWOKX_VERIFY_TOKEN` (used for authenticated post-deploy verification)

GitHub Environment Variables (required for post-deploy checks):

- `OWOKX_WORKER_URL`
- `OWOKX_DASHBOARD_URL`

Worker runtime secrets and vars remain defined in:

- `wrangler.jsonc`
- `wrangler secret put ...`

Broker rollout note:

- To stage a Polymarket rollout safely, deploy with `BROKER_PROVIDER=polymarket` and set `BROKER_FALLBACK_PROVIDER` to your current broker.
- Keep `BROKER_FALLBACK_ALLOW_TRADING=false` during initial bake-in so only read paths fail over.
- Set `POLYMARKET_DATA_API_URL` only if you need a non-default Polymarket Data API endpoint.

## Deployment Orchestration Flow

`deploy-oneclick.yml` executes:

1. Creates GitHub deployment record.
2. Runs worker quality gates (`typecheck`, `test:ci`, `check`).
3. Runs dashboard checks.
4. Captures current Worker and dashboard deployment versions.
5. Applies remote D1 migrations.
6. Deploys backend Worker.
7. Deploys dashboard container Worker.
8. Runs deployment verification (`scripts/verify-deployment.mjs`).
9. Uploads artifacts (`deploy-report.json`, `deploy-verification.json`).
10. Marks deployment success/failure in GitHub.
11. Auto-rolls back previous versions on failure.

## Lifecycle Management

Dashboard container lifecycle controls:

- Idle sleep policy: `sleepAfter` in `DashboardUi` class (`dashboard/worker/index.ts`)
- Capacity guardrail: `max_instances` in `dashboard/wrangler.container.jsonc`
- Progressive rollout and grace period: container rollout fields in wrangler config

Backend lifecycle controls:

- Versioned Worker deployments (`wrangler deployments list`)
- Version rollback (`wrangler rollback <version_id> --name <worker-name>`)

## Monitoring and Status Feedback

Health endpoints:

- Backend: `/health`
- Dashboard: `/health`
- Routed API via dashboard: `/api/status`, `/api/swarm/health`

Operational endpoints:

- Backend swarm/metrics/status endpoints under `/swarm/*` and `/agent/*`
- Broker failover events are emitted as structured logs with `[broker-fallback]` prefix for alerting/search.

Automated feedback:

- GitHub Deployment status (in_progress, success, failure)
- GitHub Step Summary with target/environment metadata
- Artifact uploads with verification and deployment reports

## Rollback Procedures

Automatic rollback runs on workflow failure when previous versions were captured.

Manual rollback commands:

```bash
# List backend deployments
npx wrangler deployments list --name owokx-production --json

# Roll back backend
npx wrangler rollback <backend_version_id> --name owokx-production

# List dashboard deployments
npx wrangler deployments list --name owokx-dashboard-production --json

# Roll back dashboard
npx wrangler rollback <dashboard_version_id> --name owokx-dashboard-production
```

Use non-`-production` names for staging (`owokx`, `owokx-dashboard`).

## Testing and Deployment Verification

Pre-deploy local checks:

```bash
pnpm run typecheck
pnpm run test:ci
pnpm run check
pnpm --dir dashboard run check
```

Post-deploy verification script:

```bash
node scripts/verify-deployment.mjs \
  --worker-url https://<worker-domain> \
  --dashboard-url https://<dashboard-domain> \
  --token <read-or-trade-token> \
  --strict-auth true \
  --json-output deploy-verification.json
```

Verification coverage includes:

- backend health
- dashboard health
- dashboard-to-backend API routing (`/api/status`, `/api/swarm/health`)
- auth route forwarding (`/auth/session`)

## Production Readiness Checklist

1. `wrangler.jsonc` resources are correct for production bindings.
2. `dashboard/wrangler.container.jsonc` includes production service binding override.
3. GitHub `production` environment has required secrets/vars.
4. D1 migrations are reviewed and backward-compatible.
5. Rollback command owners are on-call.
6. Verification URLs point to production domains.
7. One-click workflow is triggered with `--components all`.

## Reference Files

- Backend Worker config: `wrangler.jsonc`
- Dashboard container Worker config: `dashboard/wrangler.container.jsonc`
- Dashboard service-binding router: `dashboard/worker/index.ts`
- Dashboard image build: `dashboard/Dockerfile`
- Dashboard web server config: `dashboard/nginx.conf`
- One-click workflow: `.github/workflows/deploy-oneclick.yml`
- Deploy dispatcher: `scripts/deploy.ts`
- Deploy verifier: `scripts/verify-deployment.mjs`

## Cloudflare References

- Workers + Containers architecture: https://developers.cloudflare.com/containers/
- Build first containerized Worker: https://developers.cloudflare.com/containers/get-started/
- Service bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
