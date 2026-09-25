# claude-code-proxy

[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)

A public-source local proxy that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
use Kilo Gateway, QwenCloud/DashScope, or another OpenAI-compatible Chat Completions API.

It translates Anthropic Messages requests into OpenAI Chat Completions requests,
including streaming, tools, images, thinking, retries, and model fallbacks — and
ships pointed at Kilo's free tier by default, so a full setup costs nothing.

- **Zero runtime dependencies** — Bun built-ins only
- **Cost-guarded by default** — `FREE_MODELS_ONLY` plus an explicit
  `ALLOWED_MODELS` allowlist, so a request cannot reach a paid model you have
  not approved (see [SECURITY.md](./SECURITY.md#cost-control))
- **Self-healing routing** — fallback chain, per-model cooldowns, and
  body-level deadlines on *both* the streaming and non-streaming paths, so a
  stalled upstream cannot wedge the proxy
- **Fail-closed configuration** — unrecognised booleans keep their secure
  default, so a typo cannot silently switch off a safety gate
- **Loud about the sharp edge** — any non-loopback bind is announced at startup,
  because the data plane is not loopback-restricted

## Quick start

Requires [Bun](https://bun.sh) 1.1+ and a Kilo and/or QwenCloud API key.

```bash
git clone https://github.com/sunil-gumatimath/claude-code-proxy.git
cd claude-code-proxy
bun install
cp .env.example .env
```

Set at least one upstream key in `.env`:

```env
KILO_API_KEY=your-kilo-key
# QWEN_API_KEY=your-qwencloud-key
```

Start the proxy:

```bash
bun run start
```

Point Claude Code at it — for a persistent setup, put this in
`~/.claude/settings.json` (create it if missing):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4181",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy",
    "ANTHROPIC_MODEL": "kilo/stealth/space-bunny-alpha",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "16384"
  }
}
```

Then `claude /logout && claude`. See [Configure Claude Code](#configure-claude-code)
for what each value means.

If `PROXY_API_KEY` is set, use that value for `ANTHROPIC_AUTH_TOKEN` and keep
the upstream provider key in `.env`.

## Set up with an LLM

Paste this single-paragraph prompt into Claude Code or another coding agent:

```text
Set up this claude-code-proxy repository so Claude Code uses Kilo Gateway
through it: install Bun, run `bun install`, copy `.env.example` to `.env`, ask
me for a Kilo API key (never print or expose it), start the proxy with
`bun run start`, verify http://127.0.0.1:4181/health returns "ok", then merge
an `env` block into ~/.claude/settings.json per README's "Configure Claude
Code" section with ANTHROPIC_BASE_URL=http://127.0.0.1:4181,
ANTHROPIC_MODEL=kilo/stealth/space-bunny-alpha, and
CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 — back the file up first and do not
overwrite existing keys. Prefer UPSTREAM_CA_FILE for TLS problems; use
UPSTREAM_TLS_REJECT_UNAUTHORIZED=false only after explaining the risk. Confirm
one small /v1/messages request succeeds and report anything I still need to do.
```

## Recommended free model

```env
DEFAULT_MODEL=kilo/stealth/space-bunny-alpha
REASONING_EFFORT=high
```

Space Bunny Alpha is the default primary: an anonymous large model on Kilo's
free tier with **1M-token context**, native **image and video** input, explicit
`reasoning_effort` support, and roughly 1.2s median latency. Because it handles
vision natively it is also the `VISION_MODEL`, so image requests need no reroute.

`FALLBACK_MODELS` then works down through `nvidia/nemotron-3-ultra-550b-a55b:free`
(1M, next strongest), `cohere/north-mini-code:free` (fast, code-specialised),
`stepfun/step-3.7-flash:free` (vision), `nemotron-3-nano-omni-...-reasoning:free`
(omni), and finally `kilo/kilo-auto/free` — Kilo's own free router, kept last
because it resolves server-side to a smaller model for free accounts.

`REASONING_EFFORT=high` forces high reasoning on every turn. Clear it to derive
effort from Claude Code's thinking budget instead.

Kilo's free tier rotates as providers end promotions, and the proxy already
fails over and cools down dead models automatically. To re-check what is free
right now:

```bash
curl -s https://api.kilo.ai/api/gateway/models \
  | grep -o '"id":"[^"]*:free"'
```

`ALLOWED_MODELS` is an explicit approval list: with `FREE_MODELS_ONLY=true`
(the default) a model that is not listed is rejected outright. It **defaults to
every model marked `free: true` in the `CAPABILITIES` table in
[`src/providers.ts`](./src/providers.ts)** — that table is the single source of
truth, so adding a model there makes it usable with no second edit. QwenCloud
models are **not** free-tier — they bill per token once the promotional quota is
spent — so they must be allowlisted before use.

## Configure Claude Code

To make Claude Code use the proxy, set `~/.claude/settings.json` (create it if
missing) so every session points at the proxy and the model you want:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4181",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy",
    "ANTHROPIC_MODEL": "kilo/stealth/space-bunny-alpha",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "16384",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

Notes:

- `ANTHROPIC_AUTH_TOKEN` is the value Claude Code sends to the proxy. If
  `PROXY_API_KEY` is set, use that key here and keep the upstream provider key
  in `.env`; otherwise use your upstream key (or any non-empty value if
  `KILO_API_KEY` is set in `.env`). Set `ANTHROPIC_API_KEY` to `""` so Claude
  Code never calls real Anthropic by mistake.
- `ANTHROPIC_MODEL` names the model Claude Code asks for. Use a
  provider-qualified ID (e.g. `kilo/stealth/space-bunny-alpha`) to bypass the
  alias table, or a `claude-*` name to let `MODEL_ALIASES` route it.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` tells Claude Code the model's real window so
  auto-compact doesn't assume 200K for unrecognized model IDs — set it to the
  context size of whichever model you actually run (1M for Space Bunny Alpha and
  Nemotron Ultra, 262144 for Laguna S 2.1).
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` should match the proxy's hard cap of `16384`
  on `max_tokens`, so Claude Code budgets against what it can actually get.
  Requests above the cap are clamped, and the clamp is logged.
- Restart Claude Code (or run `claude /logout`, then `claude`) after editing.

Shell-export equivalents (PowerShell, bash, zsh) are in
[SETUP.md](./SETUP.md#4-configure-claude-code).

## Settings

Every setting lives in `.env`. Copy [`.env.example`](./.env.example) and edit
that; it documents each one inline.

### Network and auth

| Setting | Default | Purpose |
| --- | --- | --- |
| `PROXY_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only on a trusted network |
| `PROXY_PORT` | `4181` | Local listen port |
| `PROXY_API_KEY` | unset | Shared secret clients must present. When set, required on *every* request including loopback |
| `CORS_ALLOWED_ORIGINS` | *(empty)* | Comma-separated browser origins. Empty disables browser access entirely |
| `MAX_BODY_BYTES` | `20971520` (20 MB) | Max request body (larger gets `413`); also bounds a single upstream SSE line or frame |

### Upstream providers

| Setting | Default | Purpose |
| --- | --- | --- |
| `KILO_API_KEY` | unset | Kilo Gateway key. Optional if the client sends `x-api-key`/`Authorization` |
| `KILO_BASE_URL` | `https://api.kilo.ai/api/gateway` | Point at any OpenAI-compatible `/chat/completions` API |
| `QWEN_API_KEY` | unset | QwenCloud/DashScope key (`DASHSCOPE_API_KEY` is an accepted alias) |
| `QWEN_BASE_URL` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_BASE_URL` is an accepted alias |
| `MODEL_PREFIX` | *(empty)* | Prefix applied to Kilo model names, e.g. `anthropic/`. Never applied to Qwen |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Header timeout **and** per-read deadline on both response paths (see below) |
| `UPSTREAM_TLS_REJECT_UNAUTHORIZED` | `true` | Verify upstream certificates. Prefer `UPSTREAM_CA_FILE` over disabling |
| `UPSTREAM_CA_FILE` | *(empty)* | PEM file for a corporate/HTTPS-inspection root CA |

### Model routing

| Setting | Default | Purpose |
| --- | --- | --- |
| `DEFAULT_MODEL` | `kilo/stealth/space-bunny-alpha` | Model used when the client omits one |
| `FALLBACK_MODELS` | built-in list | Tried in order after a temporary upstream failure |
| `ALLOWED_MODELS` | every `free: true` model | Explicit approval list — anything else is rejected |
| `FREE_MODELS_ONLY` | `true` | Also reject paid models. Set `false` to allow allowlisted paid models |
| `VISION_MODEL` | `kilo/stealth/space-bunny-alpha` | Model used for image requests when smart routing applies |
| `MODEL_ALIASES` | built-in list | `pattern=model` pairs; `*` is a wildcard. Patterns only match bare `claude-*` names |
| `SMART_ROUTING` | `true` | Apply `MODEL_ALIASES` and `VISION_MODEL` to bare `claude-*` model names |
| `REASONING_EFFORT` | *(empty)* | Force `low`/`medium`/`high`/`xhigh`/`max`/`no_think`. Empty derives effort from the thinking budget |

Prefix any model with `kilo/` or `qwen/` to name a provider explicitly
(`dashscope/` is an alias for `qwen/`). A bare, unqualified name is treated as
Kilo. Provider-qualified ids are never rewritten by `MODEL_ALIASES`.

**Configured model ids resolve exactly like requested ones.** Every id in
`DEFAULT_MODEL`, `VISION_MODEL`, `FALLBACK_MODELS`, `ALLOWED_MODELS`, and
`MODEL_ALIASES` is passed through the same parser a client's request goes
through, so an entry and the target it approves always land on the same
canonical `provider/model` form. A bare entry is therefore equivalent to the
`kilo/` form, and `dashscope/qwen3-max` matches `qwen/qwen3-max`:

```env
ALLOWED_MODELS=my-local-model            # same as kilo/my-local-model
ALLOWED_MODELS=dashscope/qwen3-max       # same as qwen/qwen3-max
```

This is what makes the allowlist trustworthy: there is no spelling of a config
entry that approves a *different* target than the one it reads as.

`REASONING_EFFORT` is clamped per model rather than sent blindly. A model with a
restricted vocabulary (Tencent Hy3 accepts only `no_think`, `low`, `high`)
receives the strongest effort it actually supports, so `xhigh`/`max` arrive as
`high` and `medium` as `low`, instead of costing the turn with a `400`.

### Capacity and observability

| Setting | Default | Purpose |
| --- | --- | --- |
| `MAX_CONCURRENT_REQUESTS` | `4` | Upstream requests in flight. Each streaming response holds a slot for its whole life |
| `MAX_QUEUED_REQUESTS` | `20` | Requests allowed to wait for a slot. `0` disables queueing so a saturated proxy fails fast with `429` |
| `MODEL_COOLDOWN_MS` | `30000` | How long a model is skipped after a `429`/`402`/`403`/`404`/`408`/`5xx`, or any upstream or body-read timeout |
| `DEBUG` | `false` | Log request/response shapes with secrets and base64 redacted |

Booleans fail closed: a value that is not one of `1/true/yes/y/on` or
`0/false/no/n/off` keeps the default. `FREE_MODELS_ONLY=ture` therefore leaves
the paid-model gate **on**, rather than silently switching it off.

A stalled upstream is bounded on both response paths. `UPSTREAM_TIMEOUT_MS`
doubles as a per-read deadline on a streaming body *and* as a body deadline on a
non-streaming response, so an upstream that sends headers and then goes quiet is
aborted instead of pinning a slot forever. The request body is bounded too, both
by `MAX_BODY_BYTES` and by a per-chunk read deadline, so a slow-drip upload
cannot hold a connection open either.

For troubleshooting, see [SETUP.md](./SETUP.md#troubleshooting).

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/messages` | Anthropic Messages — streaming and sync |
| `POST /v1/messages/count_tokens` | Local token estimate (`chars/4`, minimum 1). Never touches upstream, so it is never capacity-limited |
| `GET /health`, `/healthz` | Liveness only: `{"status":"ok"}` |
| `GET /` | Liveness plus proxy version, upstream target, and uptime |
| `GET /version` | Name and version |
| `GET /v1/models` | Allowlisted + fallback + alias model ids |
| `GET /metrics` | Prometheus text format |
| `GET /dashboard`, `/dashboard.json` | Live metrics in a browser / as JSON |

A trailing slash is accepted on every path (`/health/` ≡ `/health`). A known
path under the wrong verb returns `405` with an `Allow` header rather than a
`404`.

Every endpoint except `POST /v1/messages*` is **operational**: loopback-only
when `PROXY_API_KEY` is unset, and requiring the key over any non-localhost
host. The loopback check reads the real socket address, so a spoofed `Host`
header does not grant access.

`POST /v1/messages` is the **data plane** and is deliberately *not*
loopback-restricted — the proxy is a single-user local adapter, and gating it
would break every documented setup. The consequence is that binding to a
non-loopback address without `PROXY_API_KEY` publishes an open relay on your
upstream key. That is your call to make, so it is not blocked; it is announced
in the startup banner, announced again on the first non-local request, and
documented in [SECURITY.md](./SECURITY.md#network-exposure).

## TLS certificates

Certificate verification is enabled by default. On a network with HTTPS
inspection, set `UPSTREAM_CA_FILE` to the inspection root CA PEM file. As a
temporary workaround only, set `UPSTREAM_TLS_REJECT_UNAUTHORIZED=false`.

## Behaviour under failure

What the proxy does when things go wrong is the part most worth knowing before
you tune anything.

**A stalled upstream cannot wedge the proxy.** `fetch` resolves on *headers*, so
bounding only the header phase is not enough — the body would be unbounded. The
proxy therefore applies `UPSTREAM_TIMEOUT_MS` three times: to the header phase,
as a per-read deadline that resets on every chunk of a streaming body, and as a
deadline on a non-streaming response body. A stall on any path aborts the
upstream, releases the concurrency slot, and puts the model in cooldown. The
request body is bounded the same way, by `MAX_BODY_BYTES` *and* a per-chunk read
deadline, so a slow-drip upload cannot hold a connection open either.

**Failures walk the fallback chain; bad requests do not.** `404`, `408`, `429`,
`403`, `402`, and `5xx` are transient or model-specific, so the next candidate is
tried. A `400` is the client's fault and would fail identically everywhere, so it
is returned immediately rather than multiplied across the chain.

**A failing model is skipped, not retried.** A `429`/`402`/`403`/`404`/`408`/`5xx`
or a timeout puts the model in cooldown for `MODEL_COOLDOWN_MS`, and the next
request leads with a healthy candidate. If *every* candidate is cooling, they are
all retried anyway — refusing the request because of stale cooldown state would
be worse than trying one that may have recovered.

**A `200` carrying an error body is treated as a failure.** Some gateways answer
`200` with `{"error": ...}`. Forwarding that as a completion would hand the
client a fabricated empty answer, so it becomes a `502` and is counted in
`kilo_proxy_upstream_errors_total`. The same applies mid-stream, where it becomes
an SSE `error` event.

**A turn that emitted a tool call reports `tool_use`.** Some upstreams send
`finish_reason: "stop"` alongside a completed tool call. Taken literally, Claude
Code would treat the turn as finished and never dispatch the tool, silently
stalling the agent — so a started `tool_use` block wins.

**Incomplete tool calls are dropped, never fabricated.** If a stream ends before
a tool call's `id`/`name` arrived, no `tool_use` block is emitted. Inventing one
would leave a dangling call in the conversation history that strict gateways
reject on the next turn.

## Development

```bash
curl http://127.0.0.1:4181/health
bun test          # 238 unit + integration tests
bun run typecheck # tsc --noEmit
bun run dev       # --watch reload
bun run check     # format + lint + typecheck + test, as CI runs it
```

Zero **runtime** dependencies — Bun built-ins only. Dev dependencies are
TypeScript, `bun-types`, and [Biome](https://biomejs.dev) for format and lint;
`bun run format` rewrites, `bun run format:check` and `bun run lint` are what CI
enforces.

Layout:

| Module | Responsibility |
| --- | --- |
| `config.ts` | Validated, immutable env config |
| `server.ts` | Route table, CORS, loopback gate, lifecycle |
| `auth.ts` | Credential extraction and constant-time key check |
| `routing.ts` | Model resolution, capability filtering, the cost gate |
| `providers.ts` | Provider registry, capability table, id translation |
| `handlers/messages.ts` | `POST /v1/messages` and `count_tokens` |
| `handlers/upstream.ts` | Upstream call, cooldowns, fallback chain |
| `handlers/stream.ts` | SSE frame decoding and the Anthropic SSE pump |
| `handlers/body.ts` | Size- and time-bounded request body reading |
| `translate.ts` | Anthropic ↔ OpenAI request/response/SSE translation |
| `runtime.ts` | Capacity limiter, cooldowns, metrics |
| `errors.ts` | Anthropic-shaped error responses |
| `log.ts` | Console logging, redaction, debug sanitisation |

## Security

The proxy binds to localhost by default. Do not expose it to an untrusted
network; if you bind beyond localhost, set `PROXY_API_KEY` and restrict network
access. Every operational endpoint is loopback-only when `PROXY_API_KEY` is
unset, and requires the key over any non-localhost host. Upstream error text is
redacted before it reaches the logs or the client. Never commit `.env`.

Because `ALLOWED_MODELS` defaults to Kilo's free tier and `FREE_MODELS_ONLY` is
on, the proxy will not forward a request to a paid model you have not
explicitly approved. See [SECURITY.md](./SECURITY.md) for the cost-control
angle.

## License

MIT — see [LICENSE](./LICENSE).
