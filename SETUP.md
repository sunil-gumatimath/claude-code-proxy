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
| **Bun** ≥ 1.0 | Runs the proxy | [bun.sh](https://bun.sh) |
| **Git** | Clone the repo | [git-scm.com](https://git-scm.com) |
| **Claude Code CLI** | Client that talks to the proxy | [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code) |
| **Kilo API key** | Upstream auth | [kilo.ai](https://kilo.ai) |

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

| Variable | Default | When to change |
|----------|---------|----------------|
| `PROXY_PORT` | `4181` | Port already in use |
| `PROXY_HOST` | `127.0.0.1` | LAN access (see security) |
| `KILO_BASE_URL` | Kilo gateway URL | Other OpenAI-compatible APIs |
| `MODEL_PREFIX` | *(empty)* | Add only when your gateway requires a model prefix |
| `DEBUG` | `false` | `true` when troubleshooting |

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
  Listen:  http://127.0.0.1:4181
  Ready → http://127.0.0.1:4181/v1/messages
```

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

### Auth notes

- `ANTHROPIC_AUTH_TOKEN` is what Claude Code sends to the proxy. If you set
  `PROXY_API_KEY`, it must contain that proxy key; keep the upstream Kilo key in
  `KILO_API_KEY` instead.
- If `KILO_API_KEY` is set in `.env`, the proxy can use that and still accept header keys.
- Clear `ANTHROPIC_API_KEY` so Claude Code does not call real Anthropic by mistake.

---

## 5. Verify end-to-end

1. Proxy running (`bun run start`)
2. Env vars set in the Claude Code terminal
3. Run `claude` and send a simple message
4. Proxy logs should show `→` request and `←` response lines

If Claude errors immediately, check [Troubleshooting](#troubleshooting).

---

## Other OpenAI-compatible backends

You can point the proxy at any OpenAI-style `/chat/completions` API.

**Ollama example:**

```bash
# .env or inline
KILO_BASE_URL=http://localhost:11434/v1
MODEL_PREFIX=
KILO_API_KEY=ollama
```

```bash
bun run start
```

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
| Model not found | Check `MODEL_PREFIX` and model name Kilo expects |
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
- Do not set `PROXY_HOST=0.0.0.0` on a public machine without extra auth.
- Do not commit or share your `.env` / API keys.
- See [SECURITY.md](./SECURITY.md) for reporting issues.

---

## Next steps

- [README.md](./README.md) — features, config reference, architecture
- [SECURITY.md](./SECURITY.md) — security policy

```bash
bun test          # run unit tests
bun run typecheck # TypeScript check
```
