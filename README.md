# claude-code-proxy

[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)

A public-source local proxy that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
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

For a persistent setup via `~/.claude/settings.json`, see
[Configure Claude Code](#configure-claude-code) below.

## Set up with an LLM

Paste this single-paragraph prompt into Claude Code or another coding agent:

```text
Set up this claude-code-proxy repository so Claude Code uses Kilo Gateway or
OpenCode Zen through it: install Bun and run `bun install`, copy `.env.example`
to `.env`, ask me for an API key (never print or expose it), start the proxy
with `bun run start`, verify http://127.0.0.1:4181/health returns "ok", and
configure `~/.claude/settings.json` per README's "Configure Claude Code"
section. Prefer `UPSTREAM_CA_FILE` for TLS problems; use
`UPSTREAM_TLS_REJECT_UNAUTHORIZED=false` only after explaining the risk. Confirm
one small `/v1/messages` request succeeds and report anything I still need to do.
```

## Recommended free model

```env
DEFAULT_MODEL=kilo/poolside/laguna-s-2.1:free
```

Laguna S 2.1 (Poolside's 118B agentic coding model, 8B active) is the fastest
capable free coding model on Kilo, scoring 70.2% on Terminal-Bench 2.1. The
built-in routing chooses `kilo/stepfun/step-3.7-flash:free` for image requests.
Set `FALLBACK_MODELS` to a comma-separated list of provider-qualified models to
control fallback order — the default puts `kilo/tencent/hy3:free` (Tencent's
295B MoE, the highest-benchmarked free model) first so it catches rate-limits
and failures from the primary.

## Configure Claude Code

To make Claude Code use the proxy, set `~/.claude/settings.json` (create it if
missing) so every session points at the proxy and the model you want:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4181",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy",
    "ANTHROPIC_MODEL": "kilo/poolside/laguna-s-2.1:free",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "262144",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

Notes:

- `ANTHROPIC_AUTH_TOKEN` is the value Claude Code sends to the proxy. If
  `PROXY_API_KEY` is set, use that key here and keep the upstream provider key
  in `.env`; otherwise use your upstream key (or any non-empty value if
  `KILO_API_KEY` is set in `.env`).
- `ANTHROPIC_MODEL` names the model Claude Code asks for. Use a
  provider-qualified ID (e.g. `kilo/poolside/laguna-s-2.1:free`) to bypass the
  alias table, or a `claude-*` name to let `MODEL_ALIASES` route it (e.g.
  `*sonnet*` now maps to Laguna). `CLAUDE_CODE_MAX_CONTEXT_TOKENS` tells Claude
  Code the model's real window (262K) so auto-compact doesn't assume 200K for
  unrecognized model IDs.
- Restart Claude Code (or run `claude /logout`, then `claude`) after editing.

## Important settings

| Setting | Default | Purpose |
| --- | --- | --- |
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
access. Operational endpoints (`/dashboard`, `/metrics`, `/v1/models`,
`/version`) are only reachable from loopback when `PROXY_API_KEY` is unset,
and require the key over any non-localhost host. Never commit `.env`.
