// ============================================================================
// config.ts — Environment configuration (validated, immutable)
// ============================================================================

import type { ReasoningEffort } from "./types";
// Value import: providers.ts only imports the `Config` *type* from this module,
// so there is no runtime cycle back into config.ts.
import { canonicalizeModelId } from "./providers";

/**
 * Read a positive integer. `min` allows 0 where the setting is a meaningful
 * value of its own (queue depth, cooldown) rather than a required magnitude.
 */
function envInt(key: string, fallback: number, min = 1): number {
  const raw = Bun.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function envBool(key: string, fallback = false): boolean {
  const v = Bun.env[key];
  if (v == null || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function envStr(key: string, fallback: string): string {
  const v = Bun.env[key];
  return v == null || v === "" ? fallback : v;
}

function envList(key: string, fallback: string): string[] {
  return (Bun.env[key] ?? fallback)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(canonicalizeModelId);
}

export interface Config {
  /** Bind address — default 127.0.0.1 (local-only) */
  host: string;
  port: number;
  kiloApiKey: string;
  /** QwenCloud / DashScope (Alibaba) — OpenAI-compatible via compatible-mode/v1 */
  qwenApiKey: string;
  qwenBaseUrl: string;
  /** Optional shared secret required from clients before requests are forwarded. */
  proxyApiKey: string;
  kiloBaseUrl: string;
  modelPrefix: string;
  defaultModel: string;
  fallbackModels: string[];
  /** Provider-qualified models that may be used by this proxy. Empty permits all free models. */
  allowedModels: string[];
  /** Reject paid and unapproved models instead of forwarding them upstream. */
  freeModelsOnly: boolean;
  /** Vision-capable model used for image requests when smart routing applies. */
  visionModel: string;
  modelAliases: Array<{ pattern: string; model: string }>;
  /** Forced upstream reasoning effort; "" derives it from the thinking budget. */
  reasoningEffort: ReasoningEffort;
  smartRouting: boolean;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  modelCooldownMs: number;
  debug: boolean;
  /** Upstream fetch timeout (ms), also used as the per-read SSE stream deadline. */
  upstreamTimeoutMs: number;
  /** Verify the TLS certificate supplied by the upstream (keep enabled normally). */
  upstreamTlsRejectUnauthorized: boolean;
  upstreamCaFile: string;
  /** Max JSON body size (bytes) */
  maxBodyBytes: number;
  /** Comma-separated browser origins permitted to call this proxy. */
  corsAllowedOrigins: string[];
}

const DEFAULT_FALLBACK_MODELS = [
  "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
  "kilo/cohere/north-mini-code:free",
  "kilo/stepfun/step-3.7-flash:free",
  "kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "kilo/kilo-auto/free",
].join(",");

/**
 * Default approval list. A non-empty ALLOWED_MODELS is an explicit opt-in, so
 * defaulting to "all free models" would hand the client the whole Kilo catalog
 * and stop FREE_MODELS_ONLY from meaning anything.
 */
const DEFAULT_ALLOWED_MODELS = [
  "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
  "kilo/nvidia/nemotron-3.5-lightning:free",
  "kilo/nvidia/nemotron-3-super-120b-a12b:free",
  "kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "kilo/thinkingmachines/inkling-small:free",
  "kilo/stealth/space-bunny-alpha",
  "kilo/stepfun/step-3.7-flash:free",
  "kilo/qwen/qwen3.8-27b:free",
  "kilo/dots-studio/dots-3-note-preview:free",
  "kilo/poolside/laguna-s-2.1:free",
  "kilo/poolside/laguna-xs-2.1:free",
  "kilo/cohere/north-mini-code:free",
  "kilo/inclusionai/ling-3.0-flash-sante:free",
  "kilo/inclusionai/ling-3.0-flash-fin:free",
  "kilo/liquid/lfm-2.5-2.6b:free",
  "kilo/openrouter/free",
  "kilo/kilo-auto/free",
].join(",");

export function loadConfig(): Config {
  return {
    host: envStr("PROXY_HOST", "127.0.0.1"),
    port: envInt("PROXY_PORT", 4181),
    kiloApiKey: envStr("KILO_API_KEY", ""),
    qwenApiKey: envStr("QWEN_API_KEY", envStr("DASHSCOPE_API_KEY", "")),
    qwenBaseUrl: envStr(
      "QWEN_BASE_URL",
      envStr(
        "DASHSCOPE_BASE_URL",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      ),
    ).replace(/\/+$/, ""),
    proxyApiKey: envStr("PROXY_API_KEY", ""),
    kiloBaseUrl: envStr(
      "KILO_BASE_URL",
      "https://api.kilo.ai/api/gateway",
    ).replace(/\/+$/, ""),
    // Preserve Claude Code's requested model name unless the gateway requires a prefix.
    modelPrefix: Bun.env.MODEL_PREFIX ?? "",
    defaultModel: canonicalizeModelId(
      envStr("DEFAULT_MODEL", "kilo/stealth/space-bunny-alpha"),
    ),
    fallbackModels: envList("FALLBACK_MODELS", DEFAULT_FALLBACK_MODELS),
    allowedModels: envList("ALLOWED_MODELS", DEFAULT_ALLOWED_MODELS),
    freeModelsOnly: envBool("FREE_MODELS_ONLY", true),
    visionModel: canonicalizeModelId(
      envStr("VISION_MODEL", "kilo/stealth/space-bunny-alpha"),
    ),
    modelAliases: parseAliases(
      Bun.env.MODEL_ALIASES ??
        "*haiku*=kilo/stealth/space-bunny-alpha,*sonnet*=kilo/stealth/space-bunny-alpha,*opus*=kilo/stealth/space-bunny-alpha",
    ),
    reasoningEffort: parseReasoningEffort(Bun.env.REASONING_EFFORT ?? ""),
    smartRouting: envBool("SMART_ROUTING", true),
    maxConcurrentRequests: envInt("MAX_CONCURRENT_REQUESTS", 4),
    // 0 is meaningful here: it disables queueing so a saturated proxy fails
    // fast with 429 instead of holding requests open.
    maxQueuedRequests: envInt("MAX_QUEUED_REQUESTS", 20, 0),
    modelCooldownMs: envInt("MODEL_COOLDOWN_MS", 30_000, 0),
    debug: envBool("DEBUG", false),
    upstreamTimeoutMs: envInt("UPSTREAM_TIMEOUT_MS", 120_000),
    upstreamTlsRejectUnauthorized: envBool(
      "UPSTREAM_TLS_REJECT_UNAUTHORIZED",
      true,
    ),
    upstreamCaFile: envStr("UPSTREAM_CA_FILE", ""),
    maxBodyBytes: envInt("MAX_BODY_BYTES", 20 * 1024 * 1024),
    corsAllowedOrigins: (Bun.env.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

const REASONING_EFFORTS: Record<string, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  no_think: true,
};

function parseReasoningEffort(raw: string): ReasoningEffort {
  const v = raw.trim().toLowerCase();
  return (REASONING_EFFORTS[v] ? v : "") as ReasoningEffort;
}

function parseAliases(raw: string): Array<{ pattern: string; model: string }> {
  return raw.split(",").flatMap((entry) => {
    const [pattern, model] = entry.split("=").map((part) => part.trim());
    return pattern && model
      ? [{ pattern: pattern.toLowerCase(), model: canonicalizeModelId(model) }]
      : [];
  });
}

export type { Config as AppConfig };
