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
not intend, and (b) an accidental run-up of upstream cost. Most hardening effort
below targets those two.

## Cost control

The proxy is a credential-bearing forwarder, so the most likely way to lose
money is to let a request reach a model that bills per token.

- `FREE_MODELS_ONLY` (default `true`) rejects any model that is not on Kilo's
  free tier.
- `ALLOWED_MODELS` is an **allowlist**. Even free-tier models must be listed;
  an empty `ALLOWED_MODELS` permits *all* free models, so leave it populated
  unless you mean it.
- **A promotional token quota is not a free tier.** QwenCloud/DashScope gives
  new accounts 70M tokens and then bills per token. `isFreeTarget` treats every
  Qwen model as paid, so a Qwen key alone cannot start billing traffic — the
  models must be allowlisted explicitly. Treat adding a Qwen model to
  `ALLOWED_MODELS` as a spending decision.
- `MODEL_PREFIX` and `ALLOWED_MODELS` are checked against the *same* canonical
  provider-qualified id that is sent upstream, so an alias cannot be used to
  smuggle a different model past the gate.
- Review `kilo_proxy_model_requests_total` in `/metrics` to see which models
  actually received traffic, not just which ones were allowed.

## Network exposure

- Default bind is **`127.0.0.1`** (localhost only). Do not set
  `PROXY_HOST=0.0.0.0` unless you have network controls and understand the risk.
- When `PROXY_API_KEY` is unset, every **operational** endpoint (`/`,
  `/health`, `/healthz`, `/version`, `/v1/models`, `/metrics`, `/dashboard`,
  `/dashboard.json`) is restricted to loopback. The check reads the real socket
  peer address, not the `Host` header, and a request URL that fails to parse is
  denied rather than treated as local.
- When `PROXY_API_KEY` **is** set, it is required on every request including
  from loopback, and the comparison is constant-time over SHA-256 digests. It is
  sent via `x-proxy-api-key`, `x-api-key`, or `Authorization: Bearer`.
- With a proxy key configured, the client token is never forwarded upstream as
  a provider key.
- CORS is opt-in and allowlist-based (`CORS_ALLOWED_ORIGINS`). With no
  configured origins no browser origin is reflected at all.

## Data handling

- **Never commit `.env`** or API keys. It is gitignored; only share
  `.env.example`.
- `DEBUG=true` logs request and response shapes. Secrets, bearer tokens and
  long base64 payloads are redacted, and `log.ts` truncates long strings — but
  this is best-effort, not a guarantee. Avoid it on shared machines.
- Upstream error text is passed through a redaction filter before it reaches
  the logs, so an upstream that echoes your key back does not write it to disk.
- Request bodies are bounded by `MAX_BODY_BYTES` (20 MB default) and streaming
  responses by a per-read deadline, so neither an oversized upload nor a stalled
  upstream can exhaust memory or pin capacity indefinitely.
- Claude Code's prompts and any code you send pass through the proxy to the
  upstream provider in cleartext. That is inherent to the setup, not a bug —
  pick a provider whose data terms you accept.
