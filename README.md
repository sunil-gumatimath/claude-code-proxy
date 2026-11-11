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
- **Fail-fast on unsafe exposure** — a non-loopback bind without `PROXY_API_KEY`
  is refused at startup (explicit `ALLOW_UNAUTHENTICATED_REMOTE=true` opt-in only)

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
    "ANTHROPIC_MODEL": "kilo/nvidia/nemotron-3.5-super-vl:free",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1048576",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "131072"
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
ANTHROPIC_MODEL=kilo/nvidia/nemotron-3.5-super-vl:free, and
CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 — back the file up first and do not
overwrite existing keys. Prefer UPSTREAM_CA_FILE for TLS problems; use
UPSTREAM_TLS_REJECT_UNAUTHORIZED=false only after explaining the risk. Confirm
one small /v1/messages request succeeds and report anything I still need to do.
```

## Recommended free model

```env
DEFAULT_MODEL=kilo/nvidia/nemotron-3.5-super-vl:free
REASONING_EFFORT=medium
```

Nemotron 3.5 Super VL (free) is the default primary: NVIDIA's open multimodal
MoE (120B total, 12B active) on Kilo's free tier with **1M-token context**,
function calling, structured outputs, streaming, and up to 131K output tokens.
It is also the highest-ranked free model on Kilo's own leaderboard — **#6 on the
Code agent** with a *Recommended* badge, and 34% of Kilo's coding traffic — so it
leads here on real usage rather than a vendor benchmark. As with every current
Kilo free-tier model, prompts are retained for training; that is the price of
the $0 tier. It is already multimodal (text, image, *and video*), so
`VISION_MODEL` only matters if you point `DEFAULT_MODEL` at a text-only model.

`DEFAULT_MODEL` is the strongest free coder, and `FALLBACK_MODELS` holds the
rest of the free tier in ranked order, so a fallback only runs when the primary
actually failed — **ERNIE 5.5 Flash** (1M ctx, **921K out**, the
largest output budget on the free tier), **Glyph Cluster** (stealth reasoning
model for coding and long-context analysis, 256K in/out), **Inkling 2 Small**
(1.05M ctx, text+image, 131K out), Nemotron Ultra (1M, 550B MoE), Nemotron
Lightning (fast), North Mini Code (code-specialised), Dots 3 Note (vision,
460K out), Nemotron Nano Omni (omni), LFM3 1.7B (compact), OpenRouter Free, and
finally `kilo/kilo-auto/free` — Kilo's own free router, kept last because it
resolves server-side. Every entry in the default chain supports tool calling,
and the head of the list has the biggest context/output budgets because Claude
Code sends large prompts and large file rewrites.

`MODEL_ALIASES` tiers the bare `claude-*` names: Opus routes to the 550B
Nemotron Ultra, Sonnet to Nemotron 3.5 Super VL, and Haiku to the fast Nemotron
3.5 Lightning.

`REASONING_EFFORT=high` forces high reasoning on every turn. Clear it to derive
effort from Claude Code's thinking budget instead.

### Current free models

Verified against the live Kilo catalog on **2026-11-11** — every model below
carries the gateway's own `isFree: true` flag and bills `$0` at check time.
Kilo's $0 tier rotates (Beam and Crouton Alpha were both retired during
2026-11), and some stealth/alpha models can change terms, so re-check when a
model 404s or 429s.

| Model | Context | Input | Tools | Role |
| --- | --- | --- | --- | --- |
| `kilo/nvidia/nemotron-3.5-super-vl:free` | 1M | text, image, video | ✓ | **default primary + vision** — Code agent #6 on Kilo's leaderboard, 131K output |
| `kilo/baidu/ernie-5.5-flash-preview:free` | 1M | text | ✓ | **largest output on the free tier** — 921K, coding/agentic |
| `kilo/stealth/glyph-cluster` | 256K | text | ✓ | stealth reasoning model for coding + long-context analysis, 256K output |
| `kilo/thinkingmachines/inkling-2-small:free` | 1.05M | text, image | ✓ | 594B MoE (17B active), multimodal reasoning, 131K output |
| `kilo/nvidia/nemotron-3-ultra-550b-a55b:free` | 1M | text | ✓ | 550B MoE (55B active), orchestration — the `opus` alias target |
| `kilo/nvidia/nemotron-3.5-lightning:free` | 1M | text | ✓ | fast — the `haiku` alias target |
| `kilo/cohere/north-mini-code:free` | 256K | text | ✓ | code-specialised |
| `kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256K | text, image, audio, video | ✓ | omni |
| `kilo/dots-studio/dots-3-note-preview:free` | 512K | text, image | ✓ | preview (terms may change), 460K output |
| `kilo/liquid/lfm-3-1.7b:free` | 262K | text | ✓ | compact 1.7B, 8K output — agent/tool-capable |
| `kilo/openrouter/free` | 200K | text, image | ✓ | OpenRouter free router |
| `kilo/kilo-auto/free` | 256K | text | ✓ | Kilo's own free router |

Kilo's $0 tier rotates as providers end promotions, and the proxy already
fails over and cools down dead models automatically. To re-check what is $0
right now (note: some $0 models, like `stealth/*`, do not have `free` in the id):

```bash
curl -s https://api.kilo.ai/api/gateway/models
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
    "ANTHROPIC_MODEL": "kilo/nvidia/nemotron-3.5-super-vl:free",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "131072",
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
  provider-qualified ID (e.g. `kilo/nvidia/nemotron-3.5-super-vl:free`) to bypass the
  alias table, or a `claude-*` name to let `MODEL_ALIASES` route it.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` tells Claude Code the model's real window so
  auto-compact doesn't assume 200K for unrecognized model IDs — set it to the
  context size of whichever model you actually run (1048576 for Nemotron 3.5
  Super VL, Inkling 2 Small, Nemotron Ultra, or Nemotron Lightning; 1024000 for
  ERNIE 5.5 Flash; 512000 for Dots 3 Note; 262144 for LFM3 1.7B; 256000 for
  Glyph Cluster or North Mini Code).
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` should match the output ceiling of the model
  you run, so Claude Code budgets against what it can actually get. Ceilings are
  per model — `131072` for Nemotron 3.5 Super VL, `921600` for ERNIE 5.5 Flash,
  `16384` for any model the catalog does not describe — and a request above the
  ceiling of the candidate actually used is clamped and logged.
- Prompt caching is forwarded: `cache_control` breakpoints on system blocks
  reach the Kilo gateway, which reports the hit back as `cached_tokens`, so a
  stable system prompt is re-used instead of re-processed on every turn. The
  markers are dropped when any fallback candidate is a different provider, since
  a gateway that rejects unknown keys would 400 the turn.
- Restart Claude Code (or run `claude /logout`, then `claude`) after editing.

Shell-export equivalents (PowerShell, bash, zsh) are in
[SETUP.md](./SETUP.md#4-configure-claude-code).

## Settings

Every setting lives in `.env`. Copy [`.env.example`](./.env.example) and edit
that; it documents each one inline.

### Network and auth

| Setting | Default | Purpose |
| --- | --- | --- |
| `PROXY_HOST` | `127.0.0.1` | Bind address. Non-loopback binds require `PROXY_API_KEY` (or explicit opt-in) |
| `PROXY_PORT` | `4181` | Local listen port |
| `PROXY_API_KEY` | unset | Shared secret clients must present. When set, required on *every* request including loopback |
| `ALLOW_UNAUTHENTICATED_REMOTE` | `false` | Explicit opt-in to a non-loopback bind with no `PROXY_API_KEY` (trusted networks only). Fails closed |
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
| `DEFAULT_MODEL` | `kilo/nvidia/nemotron-3.5-super-vl:free` | Model used when the client omits one |
| `FALLBACK_MODELS` | built-in list | Tried in order after a temporary upstream failure |
| `ALLOWED_MODELS` | every `free: true` model | Explicit approval list — anything else is rejected |
| `FREE_MODELS_ONLY` | `true` | Also reject paid models. Set `false` to allow allowlisted paid models |
| `VISION_MODEL` | `kilo/nvidia/nemotron-3.5-super-vl:free` | Model used for image requests when smart routing applies |
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
| `EVLOG_DRAIN` | *(off)* | `file` writes one [evlog](https://www.evlog.dev/) wide event per turn as NDJSON. Console output is unchanged |
| `EVLOG_PRETTY` | `false` | Render each turn as a styled block in the terminal, alongside the existing log lines |
| `EVLOG_DIR` | `.evlog/logs` | Directory for the NDJSON drain, one dated file per day |
| `EVLOG_MAX_FILES` | `14` | Dated files kept before the oldest is deleted |

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

#### Wide events

Counters answer "how many", not "what happened on that turn". With
`EVLOG_DRAIN=file` the proxy writes one JSON object per completed turn to
`.evlog/logs/YYYY-MM-DD.jsonl` — no traffic needed to set it up, and no change
to what you see in the terminal (the logger runs silent and only owns the file):

```json
{"requestId":"req_8f2k","method":"POST","path":"/v1/messages",
 "requestModel":"claude-sonnet-4-6","stream":true,
 "routedModel":"kilo/nvidia/nemotron-3.5-lightning:free",
 "status":200,"outcome":"complete","inputTokens":1200,"outputTokens":34,
 "latencyMs":812,"duration":"812ms","level":"info","timestamp":"2026-11-11T15:53:32.182Z"}
```

Set `EVLOG_PRETTY=true` for the same event rendered in the terminal — it goes
*alongside* the existing `→ stream …` / `← … complete` lines rather than
replacing them:

```
16:05:43.422 INFO [app] POST /v1/messages 200 in 2.92s
  ├─ requestId: req_pretty2
  ├─ requestModel: claude-sonnet-4-6
  ├─ stream: true
  ├─ routedModel: kilo/nvidia/nemotron-3.5-lightning:free
  ├─ outcome: complete
  ├─ inputTokens: 21
  ├─ outputTokens: 16
  └─ latencyMs: 2917
```

The header duration is the turn, not the log call: the event is opened when the
request arrives and emitted when it ends, so a slow free-tier turn cannot
report itself as `1ms`.

`routedModel` is read when the turn ends, so a turn served by a fallback is
recorded against the model that actually answered. Failures are recorded too:
`outcome` is `complete`, `error`, `timeout`, or `canceled`, with the upstream
reason in `error`. Strings pass through the same credential redaction as `DEBUG`
and are capped at 500 characters, so a key or a whole prompt body cannot end up
in the file.

The line is a plain object, so `jq` reads it directly:

```bash
# every turn that fell back or failed today
jq -c 'select(.outcome != "complete") | {requestId, routedModel, outcome, error}' \
  .evlog/logs/*.jsonl

# p50 latency by routed model
jq -r '[.routedModel, .latencyMs] | @tsv' .evlog/logs/*.jsonl \
  | sort | awk '{a[$1]=a[$1]" "$2} END {for (m in a) print m, a[m]}'
```

Other drains (Axiom, OTLP, Sentry, `evlog/http`) are supported by the library but
are not wired here; `src/wide.ts` is the single place to add one.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/messages` | Anthropic Messages — streaming and sync |
| `POST /v1/messages/count_tokens` | Local token estimate (`chars/4`, minimum 1). Never touches upstream, so it is never capacity-limited |
| `GET /health`, `/healthz` | Liveness only: `{"status":"ok"}` |
| `GET /ready` | Readiness: a provider key is configured and the gateway answers (`ok` / `unauthorized` / `unreachable`). Returns `503` when a turn cannot succeed |
| `GET /` | Liveness plus proxy version, upstream target, and uptime |
| `GET /version` | Name and version |
| `GET /v1/models` | Allowlisted + fallback + alias ids, each with `context_length`, `max_output_tokens`, `supports_tools`, `supports_vision`, `free` |
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
would break every documented setup. To prevent an accidental open relay, the
proxy **refuses to start** on a non-loopback bind when `PROXY_API_KEY` is unset
unless `ALLOW_UNAUTHENTICATED_REMOTE=true` is set explicitly. Set `PROXY_API_KEY`
whenever the bind is not loopback. See [SECURITY.md](./SECURITY.md#network-exposure).

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

**A stream that dies before its first byte is retried transparently.** The
fallback chain is not abandoned once headers arrive. If the body resets, stalls,
or carries an error frame before anything has been written to the client, the
next candidate is tried and the client sees one clean stream — no `error` event,
no second `message_start`. Once a byte *has* been emitted the response is
committed, so a later failure is reported rather than retried, which would splice
two messages together. A stall is also treated as a health signal: the model is
cooled exactly as a `5xx` would be, so the next turn does not lead with it again.

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
bun test          # 283 unit + integration tests
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
| `types.ts` | Shared Anthropic / OpenAI request and response shapes |
| `version.ts` | Name and version, read from `package.json` |
| `index.ts` | Entry point — loads config, starts the server |

## Security

The proxy binds to localhost by default. A non-loopback bind without
`PROXY_API_KEY` is refused at startup (fail-fast) unless
`ALLOW_UNAUTHENTICATED_REMOTE=true` is explicitly set. Every operational endpoint
is loopback-only when `PROXY_API_KEY` is unset, and requires the key over any
non-localhost host. Upstream error text is redacted before it reaches the logs or
the client. Never commit `.env`.

Because `ALLOWED_MODELS` defaults to Kilo's free tier and `FREE_MODELS_ONLY` is
on, the proxy will not forward a request to a paid model you have not
explicitly approved. See [SECURITY.md](./SECURITY.md) for the cost-control
angle.

## License

MIT — see [LICENSE](./LICENSE).
