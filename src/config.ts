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
type Env = Record<string, string | undefined>;

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
 * unexplained "Model is not permitted" rejection.
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
	/** Wide-event output (evlog): "file" writes NDJSON under evlogDir; "" is off. */
	evlogDrain: "file" | "";
	evlogDir: string;
	evlogMaxFiles: number;
	/** Render each wide event as a styled block in the terminal instead of silence. */
	evlogPretty: boolean;
	/** Upstream fetch timeout (ms), also used as the per-read SSE stream deadline. */
	upstreamTimeoutMs: number;
	/** Verify the TLS certificate supplied by the upstream (keep enabled normally). */
	upstreamTlsRejectUnauthorized: boolean;
	upstreamCaFile: string;
	/** Max JSON body size (bytes) */
	maxBodyBytes: number;
	/** Comma-separated browser origins permitted to call this proxy. */
	corsAllowedOrigins: string[];
	/**
	 * Explicit opt-in to the one dangerous configuration: a non-loopback bind
	 * with no PROXY_API_KEY. Default false (fail-closed) so an accidental
	 * PROXY_HOST=0.0.0.0 cannot publish an unauthenticated relay on your
	 * upstream key.
	 */
	allowUnauthenticatedRemote: boolean;
}

/**
 * Default failover chain: every free model *except* the primary, strongest
 * first, routers last.
 *
 * `DEFAULT_MODEL` is the best free coder and is deliberately absent here, so a
 * fallback is only reached when the primary actually failed rather than
 * re-trying the same model under a second name. Ordering rationale — every
 * entry must support tool calling, and the head of the list carries the
 * largest context/output budgets because Claude Code sends big prompts and
 * large file rewrites (verified against the live Kilo catalog 2026-11-11,
 * using the gateway's own `isFree` flag):
 *
 *   primary  Nemotron 3.5 Super VL  1M ctx, 131K out, vision+video, Code #6
 *   1. ERNIE 5.5 Flash        1M ctx, 921K out, the largest free output budget
 *   2. Glyph Cluster          256K ctx, 256K out, stealth coding/reasoning
 *   3. Beam                   1M ctx, 131K out, reflection/agentic
 *   4. Particle 1             1M ctx, 131K out, agentic coding, vision
 *   5. Nemotron 3 Ultra       1M ctx, 65K out, 550B MoE (`opus` alias target)
 *   6. Nemotron 3.5 Lightning 1M ctx, 65K out, fast (`haiku` alias target)
 *   7. North Mini Code        256K ctx, 64K out, code-specialised
 *   8. Dots 3 Note            512K ctx, 460K out, vision
 *   9. Nemotron Nano Omni     256K ctx, 65K out, omni (text/image/audio/video)
 *  10. LFM3 1.7B              262K ctx, 8K out, compact/agent-capable
 *  11. OpenRouter Free        router — resolves server-side
 *  12. Auto Free              router — kept last, resolves to a smaller model
 *
 * The free tier rotates — Inkling 2 Small went paid during 2026-11 (it now
 * bills per token, so it is deliberately absent here), and Beam returned to the
 * $0 tier. Re-check GET {KILO_BASE_URL}/models (its `isFree` flag is
 * authoritative) and update the CAPABILITIES table in providers.ts (the
 * default allowlist follows it).
 */
const DEFAULT_FALLBACK_MODELS = [
	"kilo/baidu/ernie-5.5-flash-preview:free",
	"kilo/stealth/glyph-cluster",
	"kilo/reflection/beam-free",
	"kilo/particle-ai/particle-1:free",
	"kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
	"kilo/nvidia/nemotron-3.5-lightning:free",
	"kilo/cohere/north-mini-code:free",
	"kilo/dots-studio/dots-3-note-preview:free",
	"kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
	"kilo/liquid/lfm-3-1.7b:free",
	"kilo/openrouter/free",
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
			envStr(env, "DEFAULT_MODEL", "kilo/nvidia/nemotron-3.5-super-vl:free"),
		),
		fallbackModels: envList(env, "FALLBACK_MODELS", DEFAULT_FALLBACK_MODELS),
		allowedModels: envList(env, "ALLOWED_MODELS", defaultAllowedModels()),
		freeModelsOnly: envBool(env, "FREE_MODELS_ONLY", true),
		visionModel: canonicalEntry(
			envStr(env, "VISION_MODEL", "kilo/nvidia/nemotron-3.5-super-vl:free"),
		),
		modelAliases: parseAliases(
			env.MODEL_ALIASES ??
				"*haiku*=kilo/nvidia/nemotron-3.5-lightning:free,*sonnet*=kilo/nvidia/nemotron-3.5-super-vl:free,*opus*=kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
		),
		reasoningEffort: parseReasoningEffort(env.REASONING_EFFORT ?? ""),
		smartRouting: envBool(env, "SMART_ROUTING", true),
		maxConcurrentRequests: envInt(env, "MAX_CONCURRENT_REQUESTS", 4),
		// 0 is meaningful here: it disables queueing so a saturated proxy fails
		// fast with 429 instead of holding requests open.
		maxQueuedRequests: envInt(env, "MAX_QUEUED_REQUESTS", 20, 0),
		modelCooldownMs: envInt(env, "MODEL_COOLDOWN_MS", 30_000, 0),
		debug: envBool(env, "DEBUG", false),
		evlogDrain: parseEvlogDrain(env.EVLOG_DRAIN),
		evlogDir: envStr(env, "EVLOG_DIR", ".evlog/logs"),
		evlogMaxFiles: envInt(env, "EVLOG_MAX_FILES", 14),
		evlogPretty: envBool(env, "EVLOG_PRETTY", false),
		upstreamTimeoutMs: envInt(env, "UPSTREAM_TIMEOUT_MS", 120_000),
		upstreamTlsRejectUnauthorized: envBool(env, "UPSTREAM_TLS_REJECT_UNAUTHORIZED", true),
		upstreamCaFile: envStr(env, "UPSTREAM_CA_FILE", ""),
		maxBodyBytes: envInt(env, "MAX_BODY_BYTES", 20 * 1024 * 1024),
		corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? "")
			.split(",")
			.map((origin) => origin.trim())
			.filter(Boolean),
		allowUnauthenticatedRemote: envBool(env, "ALLOW_UNAUTHENTICATED_REMOTE", false),
	};
}

/**
 * Wide-event drain selector. Deliberately narrow: only `file` is implemented,
 * and anything unrecognised stays off rather than guessing a destination for
 * request metadata the operator did not ask to persist.
 */
export function parseEvlogDrain(raw: string | undefined): "file" | "" {
	const v = (raw ?? "").trim().toLowerCase();
	return v === "file" || v === "fs" ? "file" : "";
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
