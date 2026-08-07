// ============================================================================
// config.ts — Environment configuration (validated, immutable)
// ============================================================================

import type { ReasoningEffort } from "./types";

function envBool(key: string, fallback = false): boolean {
  const v = Bun.env[key];
  if (v == null || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function envInt(key: string, fallback: number): number {
  const raw = Bun.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envStr(key: string, fallback: string): string {
  const v = Bun.env[key];
  return v == null || v === "" ? fallback : v;
}

export interface Config {
  /** Bind address — default 127.0.0.1 (local-only) */
  host: string;
  port: number;
  kiloApiKey: string;
  opencodeApiKey: string;
  opencodeBaseUrl: string;
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
  modelAliases: Array<{ pattern: string; model: string }>;
  /** Forced upstream reasoning effort; "" derives it from the thinking budget. */
  reasoningEffort: ReasoningEffort;
  smartRouting: boolean;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  modelCooldownMs: number;
  debug: boolean;
  /** Upstream fetch timeout (ms) */
  upstreamTimeoutMs: number;
  /** Verify the TLS certificate supplied by the upstream (keep enabled normally). */
  upstreamTlsRejectUnauthorized: boolean;
  upstreamCaFile: string;
  /** Max JSON body size (bytes) */
  maxBodyBytes: number;
  /** Comma-separated browser origins permitted to call this proxy. */
  corsAllowedOrigins: string[];
}

export function loadConfig(): Config {
  return {
    host: envStr("PROXY_HOST", "127.0.0.1"),
    port: envInt("PROXY_PORT", 4181),
    kiloApiKey: envStr("KILO_API_KEY", ""),
    opencodeApiKey: envStr("OPENCODE_API_KEY", ""),
    opencodeBaseUrl: envStr(
      "OPENCODE_BASE_URL",
      "https://opencode.ai/zen/v1"
    ).replace(/\/+$/, ""),
    proxyApiKey: envStr("PROXY_API_KEY", ""),
    kiloBaseUrl: envStr(
      "KILO_BASE_URL",
      "https://api.kilo.ai/api/gateway"
    ).replace(/\/+$/, ""),
    // Preserve Claude Code's requested model name unless the gateway requires a prefix.
    modelPrefix: Bun.env.MODEL_PREFIX ?? "",
    defaultModel: envStr("DEFAULT_MODEL", "claude-sonnet-4-20250514"),
    fallbackModels: (Bun.env.FALLBACK_MODELS ??
      "kilo/poolside/laguna-s-2.1:free,kilo/cohere/north-mini-code:free,kilo/stepfun/step-3.7-flash:free,opencode/deepseek-v4-flash-free,opencode/longcat-2.0-free,opencode/laguna-s-2.1-free")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
    allowedModels: (Bun.env.ALLOWED_MODELS ??
      "opencode/deepseek-v4-flash-free,opencode/ling-3.0-flash-free,opencode/mimo-v2.5-free,opencode/north-mini-code-free,opencode/nemotron-3-ultra-free,opencode/laguna-s-2.1-free,opencode/longcat-2.0-free,kilo/stepfun/step-3.7-flash:free,kilo/poolside/laguna-s-2.1:free,kilo/cohere/north-mini-code:free")
      .split(",").map((model) => model.trim()).filter(Boolean),
    freeModelsOnly: envBool("FREE_MODELS_ONLY", true),
    modelAliases: parseAliases(
      Bun.env.MODEL_ALIASES ??
        "*haiku*=kilo/stepfun/step-3.7-flash:free,*sonnet*=opencode/deepseek-v4-flash-free,*opus*=kilo/poolside/laguna-s-2.1:free"
    ),
    reasoningEffort: parseReasoningEffort(Bun.env.REASONING_EFFORT ?? ""),
    smartRouting: envBool("SMART_ROUTING", true),
    maxConcurrentRequests: envInt("MAX_CONCURRENT_REQUESTS", 4),
    maxQueuedRequests: envInt("MAX_QUEUED_REQUESTS", 20),
    modelCooldownMs: envInt("MODEL_COOLDOWN_MS", 30_000),
    debug: envBool("DEBUG", false),
    upstreamTimeoutMs: envInt("UPSTREAM_TIMEOUT_MS", 120_000),
    upstreamTlsRejectUnauthorized: envBool("UPSTREAM_TLS_REJECT_UNAUTHORIZED", true),
    upstreamCaFile: envStr("UPSTREAM_CA_FILE", ""),
    maxBodyBytes: envInt("MAX_BODY_BYTES", 20 * 1024 * 1024), // 20 MB
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
};

function parseReasoningEffort(raw: string): ReasoningEffort {
  const v = raw.trim().toLowerCase();
  return (REASONING_EFFORTS[v] ? v : "") as ReasoningEffort;
}

function parseAliases(raw: string): Array<{ pattern: string; model: string }> {
  return raw.split(",").flatMap((entry) => {
    const [pattern, model] = entry.split("=").map((part) => part.trim());
    return pattern && model ? [{ pattern: pattern.toLowerCase(), model }] : [];
  });
}

export type { Config as AppConfig };
