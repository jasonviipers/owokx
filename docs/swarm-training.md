# Swarm Operator Training

This guide is for developers and operators responsible for running the agent swarm in staging and production.

## Training Goals

1. Understand swarm health and queue behavior.
2. Execute recovery actions safely.
3. Validate deployment readiness before production releases.

## Required Access

- Read token (`OWOKX_API_TOKEN_READONLY`) for monitoring.
- Trade/admin token for recovery actions.
- Access to GitHub Actions deployment workflows.

## Readiness Checklist

1. Can explain what `GET /swarm/health` and `GET /swarm/metrics` report.
2. Can identify queue pressure and stale-agent conditions.
3. Can run dead-letter requeue and stale-agent prune commands.
4. Can trigger and monitor one-click deployment.
5. Can run swarm benchmark and interpret throughput/latency output.

## Daily Operational Checks

1. Verify `GET /health` and `GET /swarm/health`.
2. Check `GET /swarm/metrics` for:
   - unexpected dead-letter growth
   - rising stale agent count
   - unusual queue delivery failure rates
3. Spot-check `GET /swarm/agents` and `GET /swarm/routing`.

## Drill 1: Dead-Letter Recovery

1. Confirm dead letters are present via `GET /swarm/queue` or `GET /swarm/metrics`.
2. Run:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":50}' \
  https://<worker-domain>/swarm/recovery/requeue-dlq
```

3. Trigger dispatch:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":200}' \
  https://<worker-domain>/swarm/dispatch
```

4. Confirm dead letters and queue depth decrease.

## Drill 2: Stale Agent Cleanup

1. Check stale count in `GET /swarm/metrics`.
2. Prune stale records:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"staleMs":600000}' \
  https://<worker-domain>/swarm/recovery/prune-stale
```

3. Confirm stale count and routing anomalies are reduced.

## Drill 3: Release Validation

1. Run local checks:

```bash
npm run typecheck
npm run test:run
npm run benchmark:swarm -- --messages 1000 --agents 5 --runs 3
```

2. Trigger one-click staging deployment.
3. Validate endpoint health and metrics post-deploy.
4. Promote to production only after staging validation passes.

## Escalation Guidance

Escalate immediately if any condition persists after two recovery cycles:

- `deadLettered` continues to increase.
- `staleAgents` does not recover.
- dispatch failures remain elevated.
- `/swarm/health` remains degraded.

