# One-Click Deployment (Production-Ready)

This repository ships a full “commit → CI → deploy” pipeline:

- Cloudflare Worker deploys via Wrangler (staging on push, production via manual one-click).
- Dashboard deploys as a Docker image published to GHCR and rolled out to Kubernetes via blue/green.
- Real-time status monitoring is available via a CLI that triggers and watches the deployment workflow.

## Workflows

- CI (staging worker deploy): [.github/workflows/ci.yml](file:///c:/Users/4hkee/OneDrive/Bureau/Jason%20Platform/okx-trading/.github/workflows/ci.yml)
- Dashboard container publish (GHCR): [.github/workflows/container-dashboard.yml](file:///c:/Users/4hkee/OneDrive/Bureau/Jason%20Platform/okx-trading/.github/workflows/container-dashboard.yml)
- One-click deploy (worker + k8s blue/green + rollback + notifications): [.github/workflows/deploy-oneclick.yml](file:///c:/Users/4hkee/OneDrive/Bureau/Jason%20Platform/okx-trading/.github/workflows/deploy-oneclick.yml)

## Environments

Wrangler environments:

- Staging: default (no `--env`)
- Production: `--env production`

Config lives in [wrangler.jsonc](file:///c:/Users/4hkee/OneDrive/Bureau/Jason%20Platform/okx-trading/wrangler.jsonc).

Kubernetes environments:

- Staging overlay: [deploy/k8s/dashboard/overlays/staging](file:///c:/Users/4hkee/OneDrive/Bureau/Jason%20Platform/okx-trading/deploy/k8s/dashboard/overlays/staging)
- Production overlay: [deploy/k8s/dashboard/overlays/production](file:///c:/Users/4hkee/OneDrive/Bureau/Jason%20Platform/okx-trading/deploy/k8s/dashboard/overlays/production)

Each overlay pins the namespace and dashboard API origin via a ConfigMap patch.

## One-Click Deploy (CLI)

Trigger and monitor a deploy with a single command:

```bash
npm run deploy:oneclick -- --env production --components all
```

Options:

- `--env staging|production`
- `--components all|worker|dashboard`
- `--repo owner/repo` (optional override)
- `--ref <branch>` (optional override)

The CLI is implemented at [scripts/deploy.ts](file:///c:/Users/4hkee/OneDrive/Bureau/Jason%20Platform/okx-trading/scripts/deploy.ts).

## Kubernetes Blue/Green Dashboard

Dashboard manifests are:

- Base: [deploy/k8s/dashboard/base](file:///c:/Users/4hkee/OneDrive/Bureau/Jason%20Platform/okx-trading/deploy/k8s/dashboard/base)
- Two deployments (`owokx-dashboard-blue`, `owokx-dashboard-green`) and a single Service that selects the active track.

The one-click deploy workflow:

1. Detects the currently active track from the Service selector
2. Updates the inactive deployment image to the new GHCR tag
3. Waits for rollout readiness
4. Switches the Service selector to cut over traffic
5. Runs post-deploy health checks and rolls back automatically on failure

## Required GitHub Environment Configuration

Create two GitHub Environments: `staging` and `production`. Use environment protection rules for production (required reviewers).

Environment secrets:

- `CLOUDFLARE_API_TOKEN` (Worker deploy + D1 migrations)
- `KUBE_CONFIG` (base64-encoded kubeconfig for the target cluster)
- `SLACK_WEBHOOK_URL` (optional)
- SMTP email (optional):
  - `SMTP_SERVER`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`
  - `NOTIFY_EMAIL_TO`, `NOTIFY_EMAIL_FROM`

Environment variables (non-secret):

- `OWOKX_WORKER_URL` (used for `/health` checks)
- `OWOKX_DASHBOARD_URL` (used for `/health` checks)

## Secrets Management

- Cloudflare secrets: use `wrangler secret put <NAME>` and `wrangler secret put <NAME> --env production` for production.
- Kubernetes secrets: keep secrets out of git. Prefer an external secrets controller (ESO/SealedSecrets/SOPS) or inject via your cluster’s secret manager.
- GitHub: keep all credentials in Environment secrets and use environment protection rules for production promotions.

## Database Migrations (D1)

The one-click deploy workflow runs:

- Staging: `wrangler d1 migrations apply owokx-db --remote`
- Production: `wrangler d1 migrations apply owokx-db --remote --env production`

## Metrics

An authenticated metrics endpoint is exposed:

- Worker: `GET /metrics` (requires a `read` token)
- Backed by the harness state (costs, run timestamps, cache sizes)

See routing in [src/index.ts](file:///c:/Users/4hkee/OneDrive/Bureau/Jason%20Platform/okx-trading/src/index.ts) and the handler in [owokx-harness.ts](file:///c:/Users/4hkee/OneDrive/Bureau/Jason%20Platform/okx-trading/src/durable-objects/owokx-harness.ts).

