# ⚡ claude-code-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Use [Kilo Code](https://kilo.ai) and [OpenCode Zen](https://opencode.ai/docs/zen/) models with [Claude Code](https://docs.anthropic.com/en/docs/claude-code).**

Production-oriented local proxy that translates **Anthropic Messages API** ↔ **OpenAI Chat Completions** so Claude Code can use Kilo Gateway (or any OpenAI-compatible API).

```
Claude Code CLI  ──(Anthropic format)──▶  claude-code-proxy  ──▶ Kilo Gateway
                                                        └──▶ OpenCode Zen
                 ◀──(Anthropic format)──                 ◀──(OpenAI format)──
```

> **Disclaimer:** Unofficial community project. Not affiliated with, endorsed by, or sponsored by Anthropic or Kilo. APIs may change; use at your own risk.

## Features

- **Dual-Provider Routing**: Seamlessly route to both **Kilo Code** (`kilo/*`) and **OpenCode Zen** (`opencode/*`) models in a unified fallback chain
- Full request/response translation (Anthropic ↔ OpenAI)
- Streaming (SSE) with reliable stream finalization
- Tool use / function calling (including multi-turn tool results)
- Image content support & automated smart vision routing
- Upstream timeouts, body size limits, request IDs
- Localhost-only bind by default
- Graceful shutdown (SIGINT / SIGTERM)
- Debug logging with secret/base64 redaction
- Zero runtime npm dependencies — [Bun](https://bun.sh) only
- Docker image included
- Comprehensive unit tests

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- A [Kilo](https://kilo.ai) API key and/or an [OpenCode Zen](https://opencode.ai/docs/zen/) API key

> **Full walkthrough:** see **[SETUP.md](./SETUP.md)** (install Bun, `.env`, Claude Code env vars, Docker, troubleshooting).

## Quick Start

### 1. Clone & configure

```bash
git clone https://github.com/sunil-gumatimath/claude-code-proxy.git
cd claude-code-proxy
cp .env.example .env
# Edit .env and set your API keys for Kilo Code and OpenCode Zen:
# KILO_API_KEY=your-kilo-key
# OPENCODE_API_KEY=your-opencode-key
```

### 2. Start the proxy

```bash
bun run start
# hot reload:
bun run dev
```

### 3. Point Claude Code at the proxy

**PowerShell:**

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:4181"
$env:ANTHROPIC_AUTH_TOKEN = "your-kilo-api-key"
$env:ANTHROPIC_API_KEY = ""
```

**Bash / Zsh:**

```bash
export ANTHROPIC_BASE_URL="http://localhost:4181"
export ANTHROPIC_AUTH_TOKEN="your-kilo-api-key"
export ANTHROPIC_API_KEY=""
```

```bash
claude /logout
claude
```

You can leave `KILO_API_KEY` empty and pass the key only via `ANTHROPIC_AUTH_TOKEN` / `x-api-key`.
When `PROXY_API_KEY` is set, use it as `ANTHROPIC_AUTH_TOKEN` and keep the Kilo
key in `KILO_API_KEY`.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `KILO_API_KEY` | *(optional if sent on request)* | Kilo upstream API key (`https://kilo.ai`) |
| `OPENCODE_API_KEY` | *(optional)* | OpenCode Zen upstream API key; enables `opencode/*` models |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen/v1` | OpenCode Zen API base URL |
| `PROXY_API_KEY` | *(unset)* | Optional shared secret required from proxy clients |
| `KILO_BASE_URL` | `https://api.kilo.ai/api/gateway` | Kilo upstream base URL |
| `PROXY_HOST` | `127.0.0.1` | Bind address (localhost-only by default) |
| `PROXY_PORT` | `4181` | Listen port |
| `MODEL_PREFIX` | *(empty)* | Optional prefix added to model names for Kilo Gateway |
| `DEFAULT_MODEL` | `claude-sonnet-4-20250514` | Fallback when client request omits `model` |
| `FALLBACK_MODELS` | Provider-qualified models | Models tried after 429/5xx failures (`kilo/*` and `opencode/*`) |
| `MODEL_ALIASES` | Sonnet $\rightarrow$ DeepSeek Flash | Wildcard rules (`*sonnet*=opencode/deepseek-v4-flash-free`) |
| `FREE_MODELS_ONLY` | `true` | Reject paid models before reaching upstream providers (explicit `ALLOWED_MODELS` entries bypass this — that list is your approval list) |
| `ALLOWED_MODELS` | Built-in free allowlist | Permitted provider-qualified models (Kilo & OpenCode); explicitly listing a paid model here opts in to it |
| `REASONING_EFFORT` | *(empty)* | Force upstream reasoning effort `low`/`medium`/`high`/`xhigh`/`max`. Empty derives it from Claude Code's thinking budget; `xhigh` = DeepSeek "max" reasoning on OpenCode Zen / OpenRouter |
| `SMART_ROUTING` | `true` | Automatically routes Claude image requests to vision-capable models |
| `MAX_CONCURRENT_REQUESTS` | `4` | Active upstream generation limit |
| `MAX_QUEUED_REQUESTS` | `20` | Max requests waiting for a generation slot |
| `MODEL_COOLDOWN_MS` | `30000` | Cooldown duration for a model after 429/5xx failures |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream fetch timeout (ms) |
| `UPSTREAM_TLS_REJECT_UNAUTHORIZED` | `true` | Verify upstream TLS certificate |
| `UPSTREAM_CA_FILE` | *(unset)* | Custom PEM CA file to trust for upstream connections |
| `MAX_BODY_BYTES` | `20971520` (20MB) | Max request body size in bytes |
| `DEBUG` | `false` | Verbose debug logging (with key & payload redaction) |
| `CORS_ALLOWED_ORIGINS` | *(unset)* | Comma-separated browser origins (disabled by default) |

## Project structure

```
src/
  index.ts              # Entry
  config.ts             # Env config
  server.ts             # HTTP routing + lifecycle
  auth.ts               # API key extraction
  errors.ts             # Anthropic-shaped errors
  log.ts                # Logging + redaction
  types.ts              # Shared types
  version.ts            # Package version
  translate.ts          # Anthropic ↔ OpenAI core
  handlers/
    messages.ts         # POST /v1/messages
tests/
  translate.test.ts
Dockerfile
```

## Docker

```bash
docker build -t claude-code-proxy .
docker run --rm -p 4181:4181 \
  -e KILO_API_KEY=your-key \
  claude-code-proxy
```

> Container sets `PROXY_HOST=0.0.0.0` so port publishing works. Keep the host firewall tight.

## Other OpenAI-compatible gateways

```bash
KILO_BASE_URL=http://localhost:11434/v1 MODEL_PREFIX="" bun run start
```

## Health & version

```bash
curl http://localhost:4181/health
curl http://localhost:4181/version
```

## Development

```bash
bun install          # devDependencies (types, typescript)
bun test             # unit tests
bun run typecheck    # tsc --noEmit
bun run dev          # hot reload
```

## Security

- Default bind is **localhost only** (`PROXY_HOST=127.0.0.1`).
- Do not expose the port to the public internet without additional auth.
- Never commit `.env`.
- See [SECURITY.md](./SECURITY.md).

## How it works

### Request (Anthropic → OpenAI)

- `system` → `messages[0].role: "system"`
- `tool_use` → `tool_calls[]`
- `tool_result` → `role: "tool"`
- `tools[].input_schema` → `tools[].function.parameters`
- `thinking.budget_tokens` → `reasoning_effort` (high/medium/low)
- Model prefixed for gateway routing

### Dual-Provider & Free-model policy

Models are provider-qualified: `opencode/deepseek-v4-flash-free` (OpenCode Zen) and `kilo/stepfun/step-3.7-flash:free` (Kilo Gateway). The proxy supports simultaneous authentication to both providers by supplying `KILO_API_KEY` and `OPENCODE_API_KEY` in `.env`.

Requests dynamically evaluate and iterate through candidate targets across both providers in a unified fallback chain if an upstream model encounters rate limits (429) or temporary errors. Tool and image requests are filtered against known model capabilities; image inputs automatically trigger vision-capable fallbacks such as `kilo/stepfun/step-3.7-flash:free`.

### Streaming (OpenAI → Anthropic SSE)

- Chunks → `message_start` / `content_block_*` / `message_delta` / `message_stop`
- `finish_reason: tool_calls` → `stop_reason: tool_use`
- Stream always finalized if upstream closes early

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © TED
