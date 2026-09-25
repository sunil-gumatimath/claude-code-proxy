# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |

## Reporting a vulnerability

Please **do not** open a public issue for security problems that could expose API keys or remote code execution.

Email or privately message the maintainer (**TED**) with:

- Description of the issue
- Steps to reproduce
- Impact assessment

We will acknowledge reports as soon as possible and work on a fix before any public disclosure.

## Threat model in one paragraph

This is a **local adapter** that translates the Anthropic Messages API into
OpenAI Chat Completions for a single trusted user. It is not a public
multi-tenant API gateway, and it is not hardened to be one. Its real risks are
(a) a client on the local machine using your upstream key for traffic you did
not intend, (b) an accidental run-up of upstream cost, and (c) — if you bind
beyond loopback — a client on your network doing the same. Most hardening
effort below targets those three.

## Cost control

The proxy is a credential-bearing forwarder, so the most likely way to lose
money is to let a request reach a model that bills per token.

- `FREE_MODELS_ONLY` (default `true`) rejects any model that is not on Kilo's
  free tier. It **fails closed**: an unrecognised value (`ture`, `2`, `off` by
  typo) keeps the default rather than resolving to `false`.
- `ALLOWED_MODELS` is an **allowlist**. Even free-tier models must be listed;
  an empty `ALLOWED_MODELS` permits *all* free models, so leave it populated
  unless you mean it. Its default is derived from the `free: true` set in
  `CAPABILITIES` (`src/providers.ts`), so the two cannot drift apart.
- An unlisted model is refused with `Model is not permitted by this free-only
  proxy: <provider/model>`, and the message names the resolved target — so a
  typo in a model id is visible in the error rather than silent.
- **A promotional token quota is not a free tier.** QwenCloud/DashScope gives
  new accounts 70M tokens and then bills per token. `isFreeTarget` treats every
  Qwen model as paid, so a Qwen key alone cannot start billing traffic — the
  models must be allowlisted explicitly. Treat adding a Qwen model to
  `ALLOWED_MODELS` as a spending decision.
- The gate compares **canonical provider-qualified ids**, and both sides of the
  comparison are produced by the same resolver. A client's requested id and an
  operator's `ALLOWED_MODELS` entry each pass through `parseTarget`, which maps
  an alias prefix to its canonical provider (`dashscope/` → `qwen/`) and
  resolves a bare name to Kilo. So no spelling of a config entry can approve a
  different target than the one it reads as — an entry either matches the
  resolved target exactly or is rejected.
- `MODEL_PREFIX` is applied *after* the gate, at the wire boundary. It is
  trusted operator configuration read from your own `.env`, never a
  client-supplied value, so it cannot widen what a client may reach — but it
  does mean the string sent upstream is not the string that was allowlisted. If
  you set `MODEL_PREFIX`, confirm the prefixed name is the one your gateway
  expects.
- An inbound `x-api-key` / `Authorization` credential is applied **only** to the
  provider the client addressed. It is never replayed to a different provider
  reached through the fallback chain.
- Review `kilo_proxy_model_requests_total` in `/metrics` to see which models
  actually received traffic, not just which ones were allowed.

## Network exposure

- Default bind is **`127.0.0.1`** (localhost only). Do not set
  `PROXY_HOST=0.0.0.0` unless you have network controls and understand the risk.
- **`POST /v1/messages` is not loopback-restricted.** The operational endpoints
  below are, but the data plane is not: the proxy is a single-user local
  adapter, and gating the endpoint Claude Code calls would break every
  documented setup. The consequence is that `PROXY_HOST=0.0.0.0` without
  `PROXY_API_KEY` publishes an **unauthenticated relay on your upstream key**.
  Set `PROXY_API_KEY` whenever the bind is not loopback. The proxy prints a
  banner warning for any non-loopback address (including a specific interface
  address like `192.168.1.50`, not just the wildcards) and logs again the first
  time a non-loopback peer actually sends a request.
- When `PROXY_API_KEY` is unset, every **operational** endpoint (`/`,
  `/health`, `/healthz`, `/version`, `/v1/models`, `/metrics`, `/dashboard`,
  `/dashboard.json`) is restricted to loopback. The check reads the real socket
  peer address, not the `Host` header, and a request URL that fails to parse is
  denied rather than treated as local.
- When `PROXY_API_KEY` **is** set, it is required on every request including
  from loopback, and the comparison is constant-time over SHA-256 digests. It is
  sent via `x-proxy-api-key`, `x-api-key`, or `Authorization: Bearer`.
- With a proxy key configured, the client token is never forwarded upstream as
  a provider key. Without one, a request-supplied key is applied **only** to the
  provider the client addressed, never to a different provider in the fallback
  chain.
- CORS is opt-in and allowlist-based (`CORS_ALLOWED_ORIGINS`). With no
  configured origins no browser origin is reflected at all.
- An inbound `x-request-id` is echoed back only after being matched against
  `^[A-Za-z0-9._-]{1,128}$`, so a hostile value cannot be reflected into a
  response header or the logs.

## Resource limits

- Request bodies are bounded by `MAX_BODY_BYTES` (20 MB default) *and* by a
  per-chunk read deadline, so neither an oversized upload nor a slow-drip
  client can hold a connection open indefinitely.
- Upstream responses are bounded by `UPSTREAM_TIMEOUT_MS` on **both** paths:
  as a per-read deadline on a streaming body, and as a body deadline on a
  non-streaming response. A stalled upstream therefore always releases its
  concurrency slot. (`fetch` resolves on headers, so bounding only the header
  phase is not sufficient — that was a real bug, and it is now covered by a
  regression test on each path.)
- A single SSE line or frame in an upstream response is bounded by
  `MAX_BODY_BYTES`, measured in bytes rather than UTF-16 units.
- Concurrency is capped by `MAX_CONCURRENT_REQUESTS` with a bounded wait queue
  (`MAX_QUEUED_REQUESTS`); a saturated proxy fails fast with `429` and a
  `Retry-After` rather than accumulating pending work. An abandoned queued
  request is evicted when its client disconnects.
- The per-model cooldown table is bounded, so a rotating model catalog cannot
  grow it without limit.

## Data handling

- **Never commit `.env`** or API keys. It is gitignored; only share
  `.env.example`.
- `DEBUG=true` logs request and response shapes. Secrets, bearer tokens and
  long base64 payloads are redacted, and `log.ts` truncates long strings — but
  this is best-effort, not a guarantee. Avoid it on shared machines.
- Upstream error text passes through a redaction filter before it reaches the
  logs, and error bodies returned to the client are redacted too.
- Claude Code's prompts and any code you send pass through the proxy to the
  upstream provider in cleartext. That is inherent to the setup, not a bug —
  pick a provider whose data terms you accept.
