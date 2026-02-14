Used `code-review` skill and reviewed the workspace in 3 layers: static scan (`rg` patterns), config/workflow audit, and executable checks (`pnpm run typecheck`, `pnpm run check`, `pnpm run test:run`, dashboard `pnpm run build`).  
Current best-practice baselines were cross-checked against Cloudflare, OWASP, GitHub Actions, and Vite/TypeScript primary docs (sources at end).

**PRIORITIZE**
1. **[CRITICAL] Approval token replay/race allows duplicate order execution**  
`src/policy/approval.ts:60`, `src/policy/approval.ts:83`, `src/mcp/agent.ts:556`, `src/mcp/agent.ts:590`, `src/storage/d1/queries/approvals.ts:42`  
Issue: `orders-submit` validates token, then submits broker order, then marks token used. No atomic reservation/consume guard. Two concurrent submits can both pass validation before either marks used.  
Impact: duplicate real-money orders.  
Exploit probability: **High** (easy with retries/concurrent calls).  
Suggested fix: atomic state transition before broker submit (`ACTIVE -> RESERVED`) with `WHERE id=? AND used_at IS NULL AND state='ACTIVE'`, check `changes==1`, then finalize to `USED`.

2. **[HIGH] HMAC verification uses non constant-time equality**  
`src/lib/utils.ts:42`, `src/lib/utils.ts:44`, used at `src/mcp/agent.ts:788` and approval verification path `src/policy/approval.ts:94`  
Issue: `expected === signature` leaks timing characteristics.  
Impact: auth/signature verification hardening gap.  
Exploit probability: **Low-Medium** (depends on attacker proximity/noise).  
Suggested fix: constant-time byte compare for equal-length normalized hex.

3. **[HIGH] API token persisted in browser localStorage**  
`dashboard/src/App.tsx:34`, `dashboard/src/App.tsx:793`, `dashboard/src/App.tsx:794`, `dashboard/src/components/SettingsModal.tsx:18`, `dashboard/src/components/SettingsModal.tsx:25`  
Issue: bearer token stored/read via `localStorage`.  
Impact: XSS -> token theft -> trade/admin API abuse.  
Exploit probability: **Medium** (any DOM XSS on same origin compromises token).  
Suggested fix: move auth to short-lived HttpOnly Secure SameSite cookies and avoid token exposure to JS.

4. **[HIGH] Deployment drift in D1 database name across deploy paths**  
`wrangler.jsonc:36`, `wrangler.jsonc:132` use `Okx-db`, but one-click pipeline/docs use `owokx-db`:  
`.github/workflows/deploy-oneclick.yml:99`, `.github/workflows/deploy-oneclick.yml:105`, `docs/deployment.md:73`, `docs/deployment.md:74`  
Impact: migration/deploy failures or targeting wrong DB.  
Exploit probability: **High operational probability**.

5. **[HIGH] One-click deploy lockfile strategy mismatched to repo**  
`.github/workflows/deploy-oneclick.yml:72`, `.github/workflows/deploy-oneclick.yml:78`, repo has only `pnpm-lock.yaml`  
Issue: `bun install --frozen-lockfile` without `bun.lock`.  
Impact: deployment pipeline can fail before build/test.  
Exploit probability: **High operational probability**.

**FIX**
1. **Formatting/lint gate currently failing**  
Command: `pnpm run check`  
Error: `Found 13 errors.`  
Representative files:  
`src/.test/data-scout-simple.test.ts:1`, `src/.test/engine.test.ts:1`, `src/.test/index.swarm.test.ts:1`, `src/.test/learning-agent.test.ts:1`, `src/.test/scraper.test.ts:1`, `src/.test/swarm-registry.test.ts:1`, `src/durable-objects/owokx-harness.ts:48`, `src/mcp/agent.ts:42`, `src/providers/broker-factory.ts:17`, `src/schemas/agent-config.ts:26`, `src/storage/d1/client.ts:163`.  
Remediation: run `pnpm run check:fix`, then rerun `pnpm run check`.

2. **Tests not executable in this environment (tooling spawn failure)**  
Command: `pnpm run test:run`  
Error: `failed to load config ... Startup Error ... Error: spawn EPERM` (vitest/esbuild startup).  
Remediation: run in less restricted runtime/CI host; keep test command as gating step.

3. **Dashboard build not executable in this environment (spawn failure)**  
Command: `dashboard/pnpm run build`  
Error: `failed to load config ... [plugin externalize-deps] Error: spawn EPERM`.  
Remediation: same as above; verify on CI runner or local machine without spawn restrictions.

4. **Workflow dependency/binding drift fixes required**  
- Switch one-click deploy install to pnpm or commit `bun.lock`.  
- Normalize D1 DB identifier across `wrangler.jsonc`, workflow, and docs to one canonical value.

**IMPROVEMENT**
1. **Type safety debt (`any`, bridge casts) in critical logic**  
`src/mcp/agent.ts:46`, `src/mcp/agent.ts:49`, `src/mcp/agent.ts:1704`, `src/durable-objects/analyst-simple.ts:90`, `src/durable-objects/risk-manager.ts:75`, `dashboard/src/types.ts:233`  
Improve by replacing `as unknown as` and `any` with strict schemas/types.

2. **Dashboard polling pressure is very high**  
`dashboard/src/App.tsx:486` (`limit` up to 2000), `dashboard/src/App.tsx:513` (2s polling), `dashboard/src/App.tsx:471` (5s status polling).  
Move activity stream to SSE/WebSocket or incremental `since` cursor + lower cadence.

3. **Dashboard quality gates missing**  
`dashboard/package.json:6` has no `lint`/`check` script.  
Add `lint` and `check`, and enforce in CI.

4. **CI/CD supply-chain hardening**  
Actions are tag-pinned (`@v4`, `@v7`) not immutable SHA pinned in workflows.  
Adopt commit-SHA pinning + Dependabot updates for GitHub Actions.

5. **Container hardening**  
`dashboard/Dockerfile:1` runtime uses default nginx root user.  
Run as non-root where feasible, add explicit `USER`, tighten filesystem and headers.

**Before/After Examples**
```ts
// Before: non-atomic one-time token consume
const validation = await validateApprovalToken(...);
const order = await broker.trading.createOrder(...);
await consumeApprovalToken(db, validation.approval_id!);

// After: reserve first (CAS), then submit, then finalize
const reserved = await reserveApprovalToken(db, approvalId, reservationId); // changes must be 1
if (!reserved) throw invalidTokenError;
const order = await broker.trading.createOrder(...);
await finalizeApprovalUsed(db, approvalId, reservationId);
```

```ts
// Before
return expected === signature;

// After
return constantTimeEqualHex(expected, signature);
```

```ts
// Before
localStorage.setItem("OWOKX_API_TOKEN", token);

// After
// Store session in HttpOnly cookie server-side; JS never reads bearer token.
await fetch("/auth/session", { method: "POST", body: JSON.stringify({ token }) });
```

**Implementation Plan (Timeline / Resources / Success Criteria)**
1. **P0 Security and execution integrity (2-3 days, 1 backend engineer)**  
Scope: atomic approval lifecycle + constant-time compare.  
Success: no duplicate submit under concurrent replay tests; signature checks constant-time; new tests for replay/race pass.

2. **P0 Deployment reliability (0.5-1 day, 1 DevOps engineer)**  
Scope: DB name normalization + package manager/lockfile consistency in one-click workflow/docs.  
Success: one-click staging deploy succeeds end-to-end; migrations target expected DB.

3. **P1 Frontend auth hardening (1-2 days, 1 frontend + 1 backend)**  
Scope: remove localStorage token flow, adopt cookie-based session.  
Success: no token in browser storage; auth still works for all dashboard routes.

4. **P1 Quality gates and typing cleanup (2-4 days, 1-2 engineers)**  
Scope: fix `biome` errors, add dashboard lint/check, reduce `any`/casts in critical paths.  
Success: `pnpm run check` clean; dashboard lint/check integrated in CI; reduced unsafe casts in `src/mcp/agent.ts`.

**Sources (best-practice baselines)**
- Cloudflare DO Rules: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/  
- Cloudflare DO Error Handling: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/  
- Cloudflare DO WebSockets/Hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/  
- OWASP ASVS: https://owasp.org/www-project-application-security-verification-standard/  
- OWASP HTML5 Security Cheat Sheet (localStorage guidance): https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html  
- GitHub Actions hardening (pin by SHA): https://docs.github.com/en/enterprise-server%403.16/actions/how-tos/security-for-github-actions/security-guides/security-hardening-for-github-actions  
- GitHub OIDC for cloud auth: https://docs.github.com/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers  
- Dependabot for Actions updates: https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot  
- Vite 8 beta announcement: https://vite.dev/blog/announcing-vite8-beta  
- TypeScript 5.9 release: https://devblogs.microsoft.com/typescript/announcing-typescript-5-9/