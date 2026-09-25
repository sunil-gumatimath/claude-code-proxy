# Setup Guide

Step-by-step instructions to run **claude-code-proxy** and use **Kilo Code models inside Claude Code**.

```
Claude Code  →  claude-code-proxy (localhost:4181)  →  Kilo Gateway
```

---

## Prerequisites

Install these before starting:

| Tool | Why | Install |
|------|-----|---------|
| **Bun** ≥ 1.1 | Runs the proxy | [bun.sh](https://bun.sh) |
| **Git** | Clone the repo | [git-scm.com](https://git-scm.com) |
| **Claude Code CLI** | Client that talks to the proxy | [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code) |
| **Kilo API key** | Upstream auth | [kilo.ai](https://kilo.ai) |
| **QwenCloud API key** | Optional second upstream (paid) | [home.qwencloud.com](https://home.qwencloud.com/api-keys) |

Pick at least one. With a Kilo key alone you get the whole free tier; a
QwenCloud key adds paid models but must be allowlisted (see
`ALLOWED_MODELS` in [Optional settings](#optional-settings)).

### Install Bun

**Windows (PowerShell):**

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash
```

Verify:

```bash
bun --version
```

---

## 1. Get the project

```bash
git clone https://github.com/sunil-gumatimath/claude-code-proxy.git
cd claude-code-proxy
```

Or download the ZIP from GitHub and open that folder.

Install dev tooling (types / tests; optional for just running):

```bash
bun install
```

---

## 2. Configure environment

```bash
# macOS / Linux / Git Bash
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Edit `.env` and set your key:

```env
KILO_API_KEY=your-real-kilo-api-key-here
```

### Optional settings

Every setting is documented inline in [`.env.example`](./.env.example). The
README has the full reference table; this is the "when would I change this"
subset.

| Variable | Default | When to change |
|----------|---------|----------------|
| `PROXY_PORT` | `4181` | Port already in use |
| `PROXY_HOST` | `127.0.0.1` | LAN access (see security below) |
| `PROXY_API_KEY` | *(unset)* | **Any non-loopback bind.** `POST /v1/messages` is not loopback-restricted |
| `KILO_BASE_URL` | Kilo gateway URL | Other OpenAI-compatible APIs |
| `MODEL_PREFIX` | *(empty)* | Add only when your gateway requires a model prefix |
| `DEFAULT_MODEL` | `kilo/stealth/space-bunny-alpha` | Pick a different primary model |
| `FALLBACK_MODELS` | Nemotron Ultra → North Mini → Step 3.7 → Nemotron Nano → Auto Free | Control fallback order after upstream failures |
| `ALLOWED_MODELS` | every free Kilo model | Narrow the approval list, or opt in a paid model |
| `FREE_MODELS_ONLY` | `true` | Set `false` to allow paid models that are allowlisted |
| `VISION_MODEL` | `kilo/stealth/space-bunny-alpha` | Your primary cannot read images |
| `REASONING_EFFORT` | *(empty)* | Force upstream reasoning; leave empty unless a model feels too slow |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Raise for a genuinely slow model; lower to fail over sooner |
| `MAX_CONCURRENT_REQUESTS` | `4` | Raise if Claude Code parallelises more than four turns |
| `MAX_QUEUED_REQUESTS` | `20` | Set `0` to fail fast with `429` instead of queueing |
| `MODEL_COOLDOWN_MS` | `30000` | How long a failing model is skipped |
| `MAX_BODY_BYTES` | `20971520` | Raise for very large images or file attachments |
| `MODEL_ALIASES` | haiku/sonnet/opus → Space Bunny | Route bare `claude-*` names yourself |
| `SMART_ROUTING` | `true` | Set `false` to disable alias and vision rerouting entirely |
| `UPSTREAM_CA_FILE` | *(empty)* | Corporate HTTPS inspection (preferred over disabling verification) |
| `CORS_ALLOWED_ORIGINS` | *(empty)* | Only if a browser calls the proxy; Claude Code does not |
| `DEBUG` | `false` | `true` when troubleshooting |

> **Booleans fail closed.** A value that is not one of `1`/`true`/`yes`/`y`/`on`
> or `0`/`false`/`no`/`n`/`off` keeps the default. `FREE_MODELS_ONLY=ture`
> leaves the paid-model gate **on** rather than silently disabling it.

> **Model ids are canonicalised.** Names in `DEFAULT_MODEL`, `VISION_MODEL`,
> `FALLBACK_MODELS`, `ALLOWED_MODELS`, and `MODEL_ALIASES` go through the same
> resolver as a client's request, and a bare name resolves to Kilo. So
> `ALLOWED_MODELS=my-model` and `ALLOWED_MODELS=kilo/my-model` are equivalent,
> and `dashscope/qwen3-max` matches `qwen/qwen3-max`. There is no spelling that
> approves a different model than it reads as.

> **QwenCloud is not a free tier.** DashScope gives new accounts a promotional
> 70M-token quota and then bills per token, so `isFreeTarget` treats every Qwen
> model as paid. To use one, add it to `ALLOWED_MODELS`:
>
> ```env
> QWEN_API_KEY=sk-...
> ALLOWED_MODELS=kilo/stealth/space-bunny-alpha,qwen/qwen3.7-max,qwen/qwen3-coder-plus
> ```

> **Never commit `.env`.** It is gitignored. Only share `.env.example`.

---

## 3. Start the proxy

```bash
bun run start
```

Hot reload while developing:

```bash
bun run dev
```

You should see something like:

```
  ⚡ claude-code-proxy v1.0.0

  Listen:        http://127.0.0.1:4181
  Target:        https://api.kilo.ai/api/gateway
  Model prefix:  ""
  API key:       ✓ from KILO_API_KEY
  Upstream TO:   120000ms
  Max body:      20MB
  Debug:         off

  Bound localhost-only (set PROXY_HOST=0.0.0.0 to change)
  Ready → http://127.0.0.1:4181/v1/messages
```

Two lines are worth reading rather than skimming:

- **`API key: ⚠ from request headers`** means `KILO_API_KEY` is unset, so the
  proxy is relying on whatever credential the client sends. That is fine for
  Claude Code with `ANTHROPIC_AUTH_TOKEN` set, but it means the proxy has no key
  of its own to fall back on.
- **`Bound localhost-only`** is the safe default. If you set a non-loopback
  `PROXY_HOST`, that line is replaced by a `⚠ Non-loopback bind` warning plus an
  explicit note that `POST /v1/messages` is reachable from the network and
  **unauthenticated** unless you also set `PROXY_API_KEY`.

### Check that it is up

**PowerShell:**

```powershell
Invoke-RestMethod http://127.0.0.1:4181/health
```

**curl:**

```bash
curl http://127.0.0.1:4181/health
```

Expected JSON includes `"status":"ok"`.

Keep this terminal open while you use Claude Code.

---

## 4. Configure Claude Code

Claude Code must send requests to the **proxy**, not to Anthropic.

### Option A — Current terminal only

**PowerShell:**

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:4181"
$env:ANTHROPIC_AUTH_TOKEN = "your-kilo-api-key" # or PROXY_API_KEY when configured
$env:ANTHROPIC_API_KEY = ""
```

**Bash / Zsh:**

```bash
export ANTHROPIC_BASE_URL="http://localhost:4181"
export ANTHROPIC_AUTH_TOKEN="your-kilo-api-key" # or PROXY_API_KEY when configured
export ANTHROPIC_API_KEY=""
```

### Option B — Persist in your shell profile

**PowerShell** (`notepad $PROFILE`):

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:4181"
$env:ANTHROPIC_AUTH_TOKEN = "your-kilo-api-key"
$env:ANTHROPIC_API_KEY = ""
```

**Bash** (`~/.bashrc` or `~/.bash_profile`):

```bash
export ANTHROPIC_BASE_URL="http://localhost:4181"
export ANTHROPIC_AUTH_TOKEN="your-kilo-api-key"
export ANTHROPIC_API_KEY=""
```

**Zsh** (`~/.zshrc`):

```bash
export ANTHROPIC_BASE_URL="http://localhost:4181"
export ANTHROPIC_AUTH_TOKEN="your-kilo-api-key"
export ANTHROPIC_API_KEY=""
```

Reload the profile (or open a new terminal), then:

```bash
claude /logout
claude
```

### Option C — `~/.claude/settings.json` (recommended)

Persistent, and the only option that survives a new shell without touching your
profile. Create `~/.claude/settings.json` if it does not exist:

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

| Key | Why |
|-----|-----|
| `ANTHROPIC_MODEL` | Must be provider-qualified (`kilo/…` or `qwen/…`) or a `claude-*` name the alias table can route |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | The model's real window. Without it Claude Code assumes 200K for unrecognized ids and auto-compacts early. Space Bunny Alpha and Nemotron Ultra are `1000000`; Laguna S 2.1 is `262144` |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Matches the proxy's hard `max_tokens` cap of `16384` |
| `ANTHROPIC_API_KEY` | Set to `""` if present, so Claude Code cannot call real Anthropic |

Merge into an existing file rather than overwriting it — `settings.json` often
already holds `tui`, `permissions`, `statusLine`, or plugins. Back it up first:

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak
```

On Windows the file is `%USERPROFILE%\.claude\settings.json`. Restart with
`claude /logout && claude`.

### Auth notes

- `ANTHROPIC_AUTH_TOKEN` is what Claude Code sends to the proxy. If you set
  `PROXY_API_KEY`, it must contain that proxy key; keep the upstream Kilo key in
  `KILO_API_KEY` instead.
- If `KILO_API_KEY` is set in `.env`, the proxy can use that and still accept header keys.
- Clear `ANTHROPIC_API_KEY` so Claude Code does not call real Anthropic by mistake.

---

## 5. Reasoning effort and thinking

`REASONING_EFFORT` in `.env` decides how hard the upstream model thinks:

| Value | Effect |
|-------|--------|
| *(empty, default)* | Derive effort from Claude Code's `thinking.budget_tokens` |
| `low` / `medium` / `high` / `xhigh` / `max` | Force that effort on every turn, whether or not the client asked for thinking |

`high` is a good fit for Space Bunny Alpha, which advertises `reasoning_effort`
support directly. Leaving it empty is the conservative choice if a model feels
slow.

Some upstreams accept only a subset of these spellings. Tencent Hy3, for
example, takes only `no_think`, `low`, and `high`, and rejects anything else
with a `400`. The proxy knows each model's vocabulary and **clamps** the request
to the strongest effort that model actually accepts — so `xhigh`/`max` become
`high`, and `medium` becomes `low`, rather than failing the turn. Nothing to
configure: this happens automatically for any model whose id matches a
restricted vocabulary in `src/providers.ts`.

Restart the proxy after changing it — the setting is read once at startup.

---

## 6. Verify end-to-end

1. Proxy running (`bun run start`)
2. Env vars set in the Claude Code terminal
3. Run `claude` and send a simple message
4. Proxy logs should show `→` request and `←` response lines

Or check the proxy directly, without Claude Code:

```bash
# Liveness (operational endpoint: loopback-only without PROXY_API_KEY)
curl http://127.0.0.1:4181/health

# A real upstream round trip
curl -s http://127.0.0.1:4181/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"kilo/stealth/space-bunny-alpha","max_tokens":64,
       "messages":[{"role":"user","content":"Reply with the single word: OK"}]}'

# Token accounting (local estimate, never touches upstream)
curl -s http://127.0.0.1:4181/v1/messages/count_tokens \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello world"}]}'

# Live counters
curl http://127.0.0.1:4181/metrics
```

`/metrics` is the fastest way to see whether the proxy is healthy: watch
`kilo_proxy_streams_active`, `kilo_proxy_queued_requests`,
`kilo_proxy_upstream_errors_total`, `kilo_proxy_rate_limits_total`, and
`kilo_proxy_fallbacks_total`. A rising `kilo_proxy_fallbacks_total` means the
primary model is failing and the chain is quietly carrying the load. Average
latency is `rate(kilo_proxy_request_duration_ms_sum[5m]) /
rate(kilo_proxy_request_duration_ms_count[5m])`. `/dashboard` renders the same
numbers in a browser.

If Claude errors immediately, check [Troubleshooting](#troubleshooting).

---

## Maintaining the free model list

Kilo's free tier rotates as providers start and end promotions, and retired
models are removed from the catalog entirely. To see what is free right now:

```bash
curl -s https://api.kilo.ai/api/gateway/models \
  | grep -o '"id":"[^"]*:free"'
```

When a promoted model disappears, requests to it start failing with `404`. The
proxy handles this on its own — a `404` marks the model as cooling down and the
next candidate in `FALLBACK_MODELS` takes over — so the practical fix is
occasional tidying: drop retired ids from `ALLOWED_MODELS` and add new ones.
`ALLOWED_MODELS` is an allowlist, so a retired entry is harmless (it 404s and
fails over) but noisy in `/v1/models`.

`ALLOWED_MODELS` **defaults to every model marked `free: true` in the
`CAPABILITIES` table in `src/providers.ts`**, so in the normal case you only need
to edit that one table: add the new id, and the default allowlist follows. Set
`ALLOWED_MODELS` explicitly only when you want a *narrower* set than the whole
free tier.

Note that a model being listed as free does not mean it is *usable* here: the
proxy filters candidates by tool and vision support, because Claude Code always
sends tools. Check the `CAPABILITIES` table in `src/providers.ts` — an unknown
model is assumed to support neither, so it is never chosen for a Claude Code
turn.

---

## Other OpenAI-compatible backends

You can point the proxy at any OpenAI-style `/chat/completions` API.

**Ollama example:**

```env
# .env
KILO_BASE_URL=http://localhost:11434/v1
MODEL_PREFIX=
KILO_API_KEY=ollama
ALLOWED_MODELS=qwen3-coder:30b
FREE_MODELS_ONLY=false
```

```bash
bun run start
```

Two things to know:

- **You must relax the model gate.** `ALLOWED_MODELS` defaults to Kilo's free
  tier and `FREE_MODELS_ONLY` defaults to `true`, so a local model is otherwise
  rejected with `Model is not permitted by this free-only proxy`.
- **Names are canonicalised, so prefixes are optional.** Configured ids go
  through the same resolver as a client's request, and a bare name resolves to
  Kilo. `ALLOWED_MODELS=qwen3-coder:30b` and `ALLOWED_MODELS=kilo/qwen3-coder:30b`
  are equivalent, and both match a client asking for `qwen3-coder:30b`. Add the
  `kilo/` prefix if you prefer it explicit — it costs nothing.

> **Tools and images need a capability entry.** Unknown models are assumed to
> support neither, so they are never selected for a Claude Code turn (which
> always sends tools). To use a local model for real work, add it to the
> `CAPABILITIES` table in `src/providers.ts`:
>
> ```ts
> "kilo/qwen3-coder:30b": { tools: true, vision: false, free: false },
> ```
>
> Without that, a request carrying tools gets
> `No enabled model supports this request's required capabilities`.

---

## Daily workflow checklist

1. Start proxy: `bun run start`
2. Open a terminal with Claude env vars set
3. Run `claude`
4. When done: stop Claude, then stop the proxy (`Ctrl+C`)

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| `bun: command not found` | Reinstall Bun; restart terminal; ensure PATH includes Bun |
| Port already in use | Set `PROXY_PORT=4182` (or another free port) and match `ANTHROPIC_BASE_URL` |
| `No API key` | Set `KILO_API_KEY` in `.env` **or** `ANTHROPIC_AUTH_TOKEN` for Claude |
| Health works, Claude fails | Confirm `ANTHROPIC_BASE_URL` points at the proxy; run `claude /logout` |
| Upstream 401 / 403 | Invalid Kilo key — regenerate at kilo.ai |
| Upstream timeout | Increase `UPSTREAM_TIMEOUT_MS` (e.g. `300000`) |
| Model not found | Check `MODEL_PREFIX` and model name Kilo expects. Kilo's free tier rotates — re-check the catalog (see [Maintaining the free model list](#maintaining-the-free-model-list)) |
| `Model is not permitted by this free-only proxy` | The model is not in `ALLOWED_MODELS` (or is a paid Qwen model) — add it explicitly |
| `No enabled model supports this request's required capabilities` | The model is unknown to the capability table, so it is assumed to support neither tools nor images. Add it to `CAPABILITIES` in `src/providers.ts` |
| Claude Code stuck or `429` from the proxy | All `MAX_CONCURRENT_REQUESTS` slots are held; check `/metrics` for `kilo_proxy_streams_active` and `kilo_proxy_queued_requests` |
| `Upstream stream stalled for more than Nms` | The upstream stopped sending mid-stream. Raise `UPSTREAM_TIMEOUT_MS` if your model is genuinely slow between chunks; the stalled slot is released automatically, so this is not a hang |
| `Upstream timed out after Nms while reading the response body` | Same idea for a non-streaming request. The slot is released and the model is put in cooldown, so the next request prefers a different one |
| Response cuts off mid-answer | `max_tokens` is capped at `16384`. Set `CLAUDE_CODE_MAX_OUTPUT_TOKENS` to `16384` so Claude Code budgets against the real ceiling. The proxy logs `clamped max_tokens` when it applies the cap |
| `Upstream returned 400: tools[0].function.name must be a non-empty string` | A tool reached the gateway with no name — usually a hand-rolled request using the OpenAI tool shape. The Anthropic Messages API expects `{name, description, input_schema}`; the proxy translates to the OpenAI shape for you |
| Feels slow | Clear `REASONING_EFFORT` in `.env` (forced high reasoning slows every request); switch to a faster model |
| "not a model this version of Claude Code recognizes" | Set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the model's real window so auto-compact doesn't assume 200K |
| `405` and an `Allow` header | The path exists under a different HTTP verb |
| Need more logs | Set `DEBUG=true` in `.env` and restart proxy |

### Enable debug mode

```env
DEBUG=true
```

Restart the proxy. Logs will include request shapes (secrets/base64 partially redacted).

### Confirm env vars (Claude terminal)

**PowerShell:**

```powershell
echo $env:ANTHROPIC_BASE_URL
echo $env:ANTHROPIC_AUTH_TOKEN
```

**Bash / Zsh:**

```bash
echo $ANTHROPIC_BASE_URL
echo $ANTHROPIC_AUTH_TOKEN
```

---

## Security reminders

- Default bind is **localhost only** (`127.0.0.1`).
- All operational endpoints (including `/health` and `/metrics`) are
  loopback-only unless you set `PROXY_API_KEY`.
- **`POST /v1/messages` is *not* loopback-restricted.** It is the data plane,
  and the proxy is a single-user local adapter, so gating it would break every
  documented setup. If you bind to anything other than loopback, set
  `PROXY_API_KEY` — otherwise anyone who can reach the port can spend your
  upstream key. The proxy warns at startup and again on the first remote
  request.
- `FREE_MODELS_ONLY` (default `true`) plus an explicit `ALLOWED_MODELS` list
  means the proxy will not forward to a paid model you have not approved. A
  promotional token quota is not a free tier — QwenCloud models count as paid.
- Booleans fail closed: a typo in a boolean keeps its secure default.
- Do not commit or share your `.env` / API keys.
- See [SECURITY.md](./SECURITY.md) for the full threat model and for reporting
  issues.

---

## Next steps

- [README.md](./README.md) — features, full settings reference, endpoints
- [SECURITY.md](./SECURITY.md) — security policy and threat model

```bash
bun run check      # format + lint + typecheck + test, exactly as CI runs it
bun test           # tests only
bun run typecheck  # TypeScript check
bun run format     # rewrite formatting
```
