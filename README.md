WARNING: This software is provided for educational and informational purposes only. Nothing in this repository constitutes financial, investment, legal, or tax advice.

# owokx Trading Agent

An autonomous, LLM-powered trading agent that runs on Cloudflare Workers using Durable Objects.

[![Discord](https://img.shields.io/discord/1467592472158015553?color=7289da&label=Discord&logo=discord&logoColor=white)](https://discord.gg/vMFnHe2YBh)

The system gathers market/social signals, runs LLM-based research, and executes trades through a configurable broker (Alpaca or OKX).

<img width="1278" height="957" alt="dashboard" src="https://github.com/user-attachments/assets/56473ab6-e2c6-45fc-9e32-cf85e69f1a2d" />

## Features

- 24/7 worker runtime on Cloudflare
- Multi-source signals: StockTwits, Reddit public feeds, SEC filings, crypto market data
- DataScout source extensions: Reddit RSS backup + Alpha Vantage sentiment
- Multi-provider LLM support: OpenAI, Anthropic, Google, xAI, DeepSeek (via AI SDK)
- Broker abstraction: Alpaca or OKX
- Activity logging with event typing, severity, status, filtering, and history
- Swarm-aware execution with production safety guardrails
- Discord notifications and configurable risk/position rules

## Requirements

- Node.js 18+
- Cloudflare account
- Broker account:
  - Alpaca (paper trading recommended first), or
  - OKX (API key, secret, passphrase)
- LLM provider credentials (or Cloudflare AI Gateway credentials)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/jasonviipers/owokx.git
cd owokx
npm install
```

### 2. Create Cloudflare resources

```bash
# D1
npx wrangler d1 create Okx-db

# KV
npx wrangler kv namespace create CACHE

# Apply migrations
npx wrangler d1 migrations apply Okx-db
```

### 3. Configure secrets

```bash
# Required auth
npx wrangler secret put OWOKX_API_TOKEN
npx wrangler secret put KILL_SWITCH_SECRET

# Broker selection
npx wrangler secret put BROKER_PROVIDER    # "alpaca" or "okx"

# Alpaca (when BROKER_PROVIDER=alpaca)
npx wrangler secret put ALPACA_API_KEY
npx wrangler secret put ALPACA_API_SECRET
npx wrangler secret put ALPACA_PAPER        # "true" recommended

# OKX (when BROKER_PROVIDER=okx)
npx wrangler secret put OKX_API_KEY
npx wrangler secret put OKX_SECRET
npx wrangler secret put OKX_PASSPHRASE
# optional:
# npx wrangler secret put OKX_SIMULATED_TRADING
# npx wrangler secret put OKX_DEFAULT_QUOTE_CCY

# LLM mode
npx wrangler secret put LLM_PROVIDER         # "openai-raw" | "ai-sdk" | "cloudflare-gateway"
npx wrangler secret put LLM_MODEL

# Provider keys (based on chosen mode)
npx wrangler secret put OPENAI_API_KEY
# optional:
# npx wrangler secret put OPENAI_BASE_URL
# npx wrangler secret put ANTHROPIC_API_KEY
# npx wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
# npx wrangler secret put XAI_API_KEY
# npx wrangler secret put DEEPSEEK_API_KEY
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_ID
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_TOKEN

# Optional data/alert integrations
npx wrangler secret put TWITTER_BEARER_TOKEN
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put ALPHA_VANTAGE_API_KEY

# Optional shard routing vars (wrangler vars, not secrets)
# OWOKX_SHARD_KEY="default"         # shared key for registry/scout/analyst/trader/risk/learning
# OWOKX_HARNESS_SHARD_KEY="main"    # key for the harness Durable Object
```

### 4. Run locally

```bash
# Terminal 1
npx wrangler dev

# Terminal 2
cd dashboard && npm install && npm run dev
```

Set a token in your shell:

```bash
# bash/zsh
export OWOKX_TOKEN="<your token>"

# PowerShell
$env:OWOKX_TOKEN="<your token>"
```

Enable the agent:

```bash
curl -X POST -H "Authorization: Bearer $OWOKX_TOKEN" http://127.0.0.1:8787/agent/enable
```

## API Endpoints

| Endpoint | Description |
|---|---|
| `/agent/status` | Full runtime status |
| `/agent/config` | Read/update config |
| `/agent/enable` (POST) | Enable scheduler |
| `/agent/disable` (POST) | Disable scheduler |
| `/agent/trigger` (POST) | Trigger one alarm cycle |
| `/agent/logs` | Query activity logs with filters |
| `/agent/history` | Portfolio history |
| `/agent/metrics` | Runtime metrics |
| `/agent/costs` | LLM usage/cost totals |
| `/agent/reset` (POST) | Reset durable state |
| `/agent/kill` | Emergency kill switch (`KILL_SWITCH_SECRET`) |
| `/swarm/*` | Swarm health/metrics/queue endpoints |
| `/mcp` | MCP server endpoint |

## Activity Logs

`/agent/logs` supports server-side filtering and search.

### Query parameters

- `event_type`: `agent,trade,crypto,research,system,swarm,risk,data,api`
- `severity`: `debug,info,warning,error,critical`
- `status`: `info,started,in_progress,success,warning,failed,skipped`
- `agent`: agent name (`Analyst`, `SignalResearch`, etc.)
- `search`: full-text search over agent/action/description/metadata
- `since`, `until`: epoch milliseconds
- `limit`: max rows (1-2000, default 200)

### Examples

```bash
# Latest logs
curl -H "Authorization: Bearer $OWOKX_TOKEN" "http://127.0.0.1:8787/agent/logs?limit=50"

# Research errors in the last hour
NOW_MS=$(date +%s000)
ONE_HOUR_AGO=$((NOW_MS - 3600000))
curl -H "Authorization: Bearer $OWOKX_TOKEN" "http://127.0.0.1:8787/agent/logs?event_type=research&severity=error&since=$ONE_HOUR_AGO"

# System warnings for swarm gating
curl -H "Authorization: Bearer $OWOKX_TOKEN" "http://127.0.0.1:8787/agent/logs?event_type=system&search=alarm_skipped"
```

## Swarm Health and Dev Override

By default, alarm cycles can be skipped when swarm quorum is not met. In development you can temporarily override:

```bash
curl -X POST -H "Authorization: Bearer $OWOKX_TOKEN" -H "Content-Type: application/json" \
  -d '{"allow_unhealthy_swarm":true}' \
  http://127.0.0.1:8787/agent/config
```

Production guardrail:

- If `ENVIRONMENT=production`, setting `allow_unhealthy_swarm=true` is rejected with HTTP 400.
- The harness also auto-corrects persisted production config so this flag cannot remain enabled.

## LLM Provider Modes

| Mode | Description |
|---|---|
| `openai-raw` | Direct OpenAI-compatible API calls |
| `ai-sdk` | Vercel AI SDK provider routing |
| `cloudflare-gateway` | Cloudflare AI Gateway OpenAI-compat flow |

Model format:

- `openai-raw`: `gpt-4o-mini` style
- `ai-sdk` and `cloudflare-gateway`: `provider/model` style (example: `deepseek/deepseek-chat`)

## Troubleshooting

### Signal research stuck at "Researching candidates..."

- Check `/agent/logs` for `action=alarm_skipped` with `Swarm unhealthy (quorum not met)`.
- If seen, either register/start required swarm agents, or use `allow_unhealthy_swarm=true` only in local dev.

### Sentiment shows `-` in Signal Research cards

- The UI prints `-` when `research.sentiment` is missing/non-numeric.
- New backend writes sentiment into every `signalResearch` record and backfills legacy entries.
- If you still see `-`, trigger a fresh cycle:

```bash
curl -X POST -H "Authorization: Bearer $OWOKX_TOKEN" http://127.0.0.1:8787/agent/trigger
```

### LLM usage remains at 0 calls / 0 tokens

- This usually means research never ran (often due to swarm health gating), not necessarily provider failure.
- Confirm with `/agent/logs` and `/agent/status` before debugging provider keys.

## Key Files

```text
owokx/
|- wrangler.jsonc
|- src/
|  |- index.ts
|  |- durable-objects/
|  |  |- owokx-harness.ts
|  |  |- data-scout-simple.ts
|  |  |- analyst-simple.ts
|  |  |- trader-simple.ts
|  |  |- swarm-registry.ts
|  |  |- risk-manager.ts
|  |  |- learning-agent.ts
|  |- providers/
|- dashboard/
|- docs/
`- migrations/
```

## Safety

- Start with paper trading (`ALPACA_PAPER=true`)
- Use tight risk limits (`max_positions`, `max_position_value`, stop loss)
- Keep kill switch secret separate from API token
- Review logs before enabling live trading

## Community

Join the Discord:

- https://discord.gg/vMFnHe2YBh

## Disclaimer

IMPORTANT: READ BEFORE USING

This software is provided for educational and informational purposes only. Nothing in this repository constitutes financial, investment, legal, or tax advice.

By using this software, you acknowledge and agree that:

- Trading decisions are made at your own risk
- Markets are volatile and you can lose some or all capital
- No guarantees of profit or performance are made
- Authors/contributors are not responsible for losses
- Software may contain bugs or unexpected behavior

Always start with paper trading and never risk money you cannot afford to lose.

## License

MIT. See `LICENSE`.
