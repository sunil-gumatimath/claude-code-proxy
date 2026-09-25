// ============================================================================
// config.ts — Environment configuration (validated, immutable)
// ============================================================================

// Value import: providers.ts only imports the `Config` *type* from this module,
// so there is no runtime cycle back into config.ts.
import {
	canonicalizeModelId,
	displayTarget,
	freeModelIds,
	parseTarget,
} from "./providers";
import type { ReasoningEffort } from "./types";

/** The environment slice config reads. Injected so the parsing is testable. */
export type Env = Record<string, string | undefined>;

/**
 * Read a positive integer. `min` allows 0 where the setting is a meaningful
 * value of its own (queue depth, cooldown) rather than a required magnitude.
 */
function envInt(env: Env, key: string, fallback: number, min = 1): number {
	const raw = env[key];
	if (raw == null || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const FALSY = new Set(["0", "false", "no", "n", "off"]);

/**
 * Parse a boolean, **failing closed**: an unrecognised value keeps the default
 * rather than resolving to `false`.
 *
 * This matters because the defaults here are the secure ones. The previous
 * `v === "1" || v === "true" || v === "yes"` treated a typo like
 * `FREE_MODELS_ONLY=ture` as false, silently switching off the paid-model gate
 * on a config the operator believed was still enforcing it.
 */
function envBool(env: Env, key: string, fallback = false): boolean {
	const v = env[key];
	if (v == null || v === "") return fallback;
	const normalized = v.trim().toLowerCase();
	if (TRUTHY.has(normalized)) return true;
	if (FALSY.has(normalized)) return false;
	return fallback;
}

function envStr(env: Env, key: string, fallback: string): string {
	const v = env[key];
	return v == null || v === "" ? fallback : v;
}

/**
 * Resolve a configured model id to the same canonical provider-qualified form
 * that routing produces for a client's request.
 *
 * Both sides of the allowlist check now go through `parseTarget`, so an
 * operator-written entry can never silently fail to match the target it was
 * meant to approve. That matters most for bare names: `parseTarget` resolves an
 * unqualified id to Kilo, so `ALLOWED_MODELS=my-local-model` and a request for
 * `my-local-model` both canonicalise to `kilo/my-local-model` and match.
 * Previously the entry stayed bare and never matched, which surfaced as an
 * unexplained `Model is not permitted by this free-only proxy`.
 */
function canonicalEntry(value: string): string {
	return displayTarget(parseTarget(canonicalizeModelId(value)));
}

function envList(env: Env, key: string, fallback: string): string[] {
	return (env[key] ?? fallback)
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map(canonicalEntry);
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
 * Default approval list, derived from the capability table's `free: true` set.
 *
 * A non-empty ALLOWED_MODELS is an explicit opt-in, so defaulting to "all free
 * models" would hand the client the whole Kilo catalog and stop
 * FREE_MODELS_ONLY from meaning anything. Deriving it from `freeModelIds()`
 * rather than restating the list means a model added to providers.ts is
 * usable out of the box and the two tables can never disagree.
 */
function defaultAllowedModels(): string {
	return freeModelIds().join(",");
}

export function loadConfig(env: Env = Bun.env): Config {
	return {
		host: envStr(env, "PROXY_HOST", "127.0.0.1"),
		port: envInt(env, "PROXY_PORT", 4181),
		kiloApiKey: envStr(env, "KILO_API_KEY", ""),
		qwenApiKey: envStr(env, "QWEN_API_KEY", envStr(env, "DASHSCOPE_API_KEY", "")),
		qwenBaseUrl: envStr(
			env,
			"QWEN_BASE_URL",
			envStr(
				env,
				"DASHSCOPE_BASE_URL",
				"https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			),
		).replace(/\/+$/, ""),
		proxyApiKey: envStr(env, "PROXY_API_KEY", ""),
		kiloBaseUrl: envStr(env, "KILO_BASE_URL", "https://api.kilo.ai/api/gateway").replace(
			/\/+$/,
			"",
		),
		// Preserve Claude Code's requested model name unless the gateway requires a prefix.
		modelPrefix: envStr(env, "MODEL_PREFIX", ""),
		defaultModel: canonicalEntry(
			envStr(env, "DEFAULT_MODEL", "kilo/stealth/space-bunny-alpha"),
		),
		fallbackModels: envList(env, "FALLBACK_MODELS", DEFAULT_FALLBACK_MODELS),
		allowedModels: envList(env, "ALLOWED_MODELS", defaultAllowedModels()),
		freeModelsOnly: envBool(env, "FREE_MODELS_ONLY", true),
		visionModel: canonicalEntry(
			envStr(env, "VISION_MODEL", "kilo/stealth/space-bunny-alpha"),
		),
		modelAliases: parseAliases(
			env.MODEL_ALIASES ??
				"*haiku*=kilo/stealth/space-bunny-alpha,*sonnet*=kilo/stealth/space-bunny-alpha,*opus*=kilo/stealth/space-bunny-alpha",
		),
		reasoningEffort: parseReasoningEffort(env.REASONING_EFFORT ?? ""),
		smartRouting: envBool(env, "SMART_ROUTING", true),
		maxConcurrentRequests: envInt(env, "MAX_CONCURRENT_REQUESTS", 4),
		// 0 is meaningful here: it disables queueing so a saturated proxy fails
		// fast with 429 instead of holding requests open.
		maxQueuedRequests: envInt(env, "MAX_QUEUED_REQUESTS", 20, 0),
		modelCooldownMs: envInt(env, "MODEL_COOLDOWN_MS", 30_000, 0),
		debug: envBool(env, "DEBUG", false),
		upstreamTimeoutMs: envInt(env, "UPSTREAM_TIMEOUT_MS", 120_000),
		upstreamTlsRejectUnauthorized: envBool(env, "UPSTREAM_TLS_REJECT_UNAUTHORIZED", true),
		upstreamCaFile: envStr(env, "UPSTREAM_CA_FILE", ""),
		maxBodyBytes: envInt(env, "MAX_BODY_BYTES", 20 * 1024 * 1024),
		corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? "")
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

export function parseReasoningEffort(raw: string): ReasoningEffort {
	const v = raw.trim().toLowerCase();
	return (REASONING_EFFORTS[v] ? v : "") as ReasoningEffort;
}

export function parseAliases(raw: string): Array<{ pattern: string; model: string }> {
	return raw.split(",").flatMap((entry) => {
		const [pattern, model] = entry.split("=").map((part) => part.trim());
		return pattern && model
			? [{ pattern: pattern.toLowerCase(), model: canonicalEntry(model) }]
			: [];
	});
}

/**
 * Whether a bind address accepts connections from anything other than this
 * host. Covers the wildcard addresses *and* a specific LAN/interface address,
 * which the old `host === "0.0.0.0"` equality check silently let through.
 */
export function isLoopbackHost(host: string): boolean {
	const bare = host
		.replace(/^\[|\]$/g, "")
		.trim()
		.toLowerCase();
	if (!bare) return true; // Bun defaults to loopback when hostname is empty
	if (bare === "localhost") return true;
	if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
	// IPv4 loopback, and IPv4-mapped IPv6 loopback.
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) || bare === "::ffff:127.0.0.1";
}

export type { Config as AppConfig };
