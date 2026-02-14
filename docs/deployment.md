# Deployment and Operations Runbook

This project ships a production deployment workflow for the Worker and dashboard, with swarm-specific monitoring and recovery operations.

## Deployment Paths

- Staging Worker deploy: `.github/workflows/ci.yml`
- Dashboard container publish (GHCR): `.github/workflows/container-dashboard.yml`
- One-click production deploy (Worker + dashboard blue/green): `.github/workflows/deploy-oneclick.yml`

Wrangler environments:

- Staging: default (no `--env`)
- Production: `--env production`

Primary config file: `wrangler.jsonc`.

## One-Click Deploy

Trigger and monitor deploy from CLI:

```bash
npm run deploy:oneclick -- --env production --components all
```

Options:

- `--env staging|production`
- `--components all|worker|dashboard`
- `--repo owner/repo`
- `--ref <branch>`

Implementation: `scripts/deploy.ts`.

## Pre-Deploy Checklist

1. Validate type safety and tests.
2. Confirm production secrets and environment variables are set.
3. Confirm D1 migrations are ready.
4. Confirm rollback owners are on-call.

Suggested commands:

```bash
npm run typecheck
npm run test:run
npm run benchmark:swarm -- --messages 1000 --agents 5 --runs 3
```

## Required Environment Configuration

GitHub environments:

- `staging`
- `production` (recommended: required reviewers)

Environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `KUBE_CONFIG`
- `SLACK_WEBHOOK_URL` (optional)
- Optional SMTP credentials for notifications

Environment variables:

- `OWOKX_WORKER_URL`
- `OWOKX_DASHBOARD_URL`

## D1 Migration Strategy

One-click deploy runs migrations remotely:

- Staging: `wrangler d1 migrations apply Okx-db --remote`
- Production: `wrangler d1 migrations apply Okx-db --remote --env production`

## Monitoring Endpoints

All endpoints below require read authorization.

Global:

- `GET /health`
- `GET /metrics`

Swarm-specific:

- `GET /swarm/health`
- `GET /swarm/metrics`
- `GET /swarm/agents`
- `GET /swarm/queue`
- `GET /swarm/subscriptions`
- `GET /swarm/routing?type=<agentType>&count=<n>`

Operational actions (trade authorization required):

- `POST /swarm/dispatch`
- `POST /swarm/publish`
- `POST /swarm/recovery/requeue-dlq`
- `POST /swarm/recovery/prune-stale`

## Quick Operations

Replace `$TOKEN` with a valid read or trade token.

Check aggregate swarm health:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://<worker-domain>/swarm/health
```

Check aggregated metrics:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://<worker-domain>/swarm/metrics
```

Requeue dead-letter messages:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":50}' \
  https://<worker-domain>/swarm/recovery/requeue-dlq
```

Prune stale agents:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"staleMs":600000}' \
  https://<worker-domain>/swarm/recovery/prune-stale
```

## Incident Runbook

1. Verify `GET /swarm/health` and `GET /swarm/metrics`.
2. If queue grows and dead letters increase, run dead-letter requeue.
3. If stale agents increase, prune stale agents and verify new heartbeats.
4. Trigger controlled dispatch (`POST /swarm/dispatch`) and observe queue drain.
5. If system remains degraded, execute workflow rollback and investigate logs.

## Training

Use `docs/swarm-training.md` for onboarding, drill steps, and readiness checks.
