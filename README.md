# claude-code-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)

An open-source local proxy that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
use Kilo Gateway, OpenCode Zen, or another OpenAI-compatible Chat Completions API.

It translates Anthropic Messages requests into OpenAI Chat Completions requests,
including streaming, tools, images, thinking, retries, and model fallbacks.

## Quick start

Requires [Bun](https://bun.sh) 1.0+ and a Kilo and/or OpenCode API key.

```bash
git clone https://github.com/sunil-gumatimath/claude-code-proxy.git
cd claude-code-proxy
cp .env.example .env
```

Set at least one upstream key in `.env`:

```env
KILO_API_KEY=your-kilo-key
# OPENCODE_API_KEY=your-opencode-key
```

Start the proxy:

```bash
bun run start
```

Point Claude Code to it:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:4181"
$env:ANTHROPIC_AUTH_TOKEN = "your-kilo-key"
$env:ANTHROPIC_API_KEY = ""
claude
```

If `PROXY_API_KEY` is set, use that value for `ANTHROPIC_AUTH_TOKEN` and keep
the upstream provider key in `.env`.

## Set up with an LLM

Paste this into Claude Code or another coding agent:

```text
Set up this claude-code-proxy repository so Claude Code can use Kilo Gateway or
OpenCode Zen through it.

1. Ensure Bun 1.0+ is installed and run `bun install`.
2. Copy `.env.example` to `.env` if needed. Ask me for an API key; never print,
   commit, or expose it.
3. Start the proxy with `bun run start` and confirm
   http://127.0.0.1:4181/health returns status "ok".
4. Configure the current shell with:
   ANTHROPIC_BASE_URL=http://127.0.0.1:4181
   ANTHROPIC_AUTH_TOKEN=<proxy key or upstream key>
   ANTHROPIC_API_KEY=""
5. Send one small request to `/v1/messages` and report whether it succeeds.
6. If upstream TLS verification fails, prefer `UPSTREAM_CA_FILE`; use
   `UPSTREAM_TLS_REJECT_UNAUTHORIZED=false` only after explaining the risk.

Report the commands run, the health-check result, and any remaining action I
need to take.
```

## Recommended free model

```env
DEFAULT_MODEL=opencode/deepseek-v4-flash-free
```

The built-in routing chooses `kilo/stepfun/step-3.7-flash:free` for image
requests. Set `FALLBACK_MODELS` to a comma-separated list of provider-qualified
models to control fallback order.

## Important settings

| Setting | Default | Purpose |
|---|---|---|
| `PROXY_PORT` | `4181` | Local listen port |
| `PROXY_HOST` | `127.0.0.1` | Bind address |
| `PROXY_API_KEY` | unset | Client shared secret |
| `KILO_API_KEY` | unset | Kilo Gateway API key |
| `OPENCODE_API_KEY` | unset | OpenCode Zen API key |
| `DEFAULT_MODEL` | Claude Sonnet alias | Model used when omitted by the client |
| `FALLBACK_MODELS` | built-in list | Models used after temporary upstream failures |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream timeout in milliseconds |

For all options and troubleshooting, see [SETUP.md](./SETUP.md).

## TLS certificates

Certificate verification is enabled by default. On a network with HTTPS
inspection, set `UPSTREAM_CA_FILE` to the inspection root CA PEM file. As a
temporary workaround only, set `UPSTREAM_TLS_REJECT_UNAUTHORIZED=false`.

## Health and development

```bash
curl http://127.0.0.1:4181/health
bun test
bun run typecheck
```

## Security

The proxy binds to localhost by default. Do not expose it to an untrusted
network; if you bind beyond localhost, set `PROXY_API_KEY` and restrict network
access. Never commit `.env`.

## License

[MIT](./LICENSE)
