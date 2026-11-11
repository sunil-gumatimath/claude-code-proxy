// ============================================================================
// providers.ts — upstream providers, model capabilities, and id translation
// ============================================================================

import type { Config } from "./config";

/**
 * Canonical upstream providers. `dashscope` is an accepted alias for `qwen`
 * and is collapsed at parse time so capability/free-tier data can never drift
 * between two names for the same upstream.
 */
export type ProviderName = "kilo" | "qwen";

const PROVIDER_PREFIXES: Record<string, ProviderName> = {
	kilo: "kilo",
	qwen: "qwen",
	dashscope: "qwen",
};

export interface UpstreamTarget {
	provider: ProviderName;
	model: string;
}

interface ModelCapabilities {
	tools: boolean;
	vision: boolean;
	/**
	 * Whether the model may be used while FREE_MODELS_ONLY is enabled.
	 * Providers with no free tier (Qwen/DashScope bills per token even on a
	 * promotional quota) must declare `free: false` and be opted in explicitly
	 * through ALLOWED_MODELS.
	 */
	free: boolean;
	/** Advertised context window in tokens, when the catalog publishes one. */
	contextLength?: number;
	/** Largest output budget the model advertises, in tokens. */
	maxOutput?: number;
	/**
	 * Upstream `reasoning_effort` values this model accepts, listed in
	 * ascending order of strength (same order as `ANY_REASONING_EFFORT`).
	 * Omitted means "pass the client's effort through unchanged". Declaring a
	 * vocabulary lets `normalizeReasoningEffort` clamp instead of 400-ing on
	 * an unsupported spelling.
	 */
	reasoningEfforts?: readonly string[];
}

/** Sentinel for "accept whatever the client asked for". */
export const ANY_REASONING_EFFORT: readonly string[] = [
	"no_think",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Kilo's free tier. Verified against the live gateway catalog
 * (GET {KILO_BASE_URL}/models, `isFree: true`) on 2026-11-11.
 *
 * `free: true` means the upstream charges $0 today. The tier rotates as
 * providers end promotions and some $0 "stealth/alpha" models change terms —
 * retired or repriced ids disappear or start billing, so re-check the catalog
 * when a model starts returning 404 (retired) or sustained 429 (capacity
 * withdrawn). Free-tier prompts/completions may be retained for training; that
 * is the price of the $0 tier.
 *
 * This table is the single source of truth for the free catalog: the default
 * ALLOWED_MODELS list in config.ts is derived from it, so a model cannot be
 * added to one and forgotten in the other.
 */
const CAPABILITIES: Record<string, ModelCapabilities> = {
	// Routers — no fixed underlying model, so behaviour can change server-side.
	"kilo/kilo-auto/free": {
		tools: true,
		vision: false,
		free: true,
		contextLength: 256_000,
		maxOutput: 32_768,
	},
	"kilo/openrouter/free": {
		tools: true,
		vision: true,
		free: true,
		contextLength: 200_000,
		// The router publishes no output ceiling; the default cap applies.
	},

	// NVIDIA Nemotron — strong free tier for long-context agentic work.
	"kilo/nvidia/nemotron-3.5-super-vl:free": {
		tools: true,
		vision: true,
		free: true,
		contextLength: 1_000_000,
		maxOutput: 131_072,
	},
	"kilo/nvidia/nemotron-3-ultra-550b-a55b:free": {
		tools: true,
		vision: false,
		free: true,
		contextLength: 1_000_000,
		maxOutput: 65_536,
	},
	"kilo/nvidia/nemotron-3.5-lightning:free": {
		tools: true,
		vision: false,
		free: true,
		contextLength: 1_000_000,
		maxOutput: 65_536,
	},
	"kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {
		tools: true,
		vision: true,
		free: true,
		contextLength: 256_000,
		maxOutput: 65_536,
	},

	// Stealth — reasoning models served at $0 during their stealth period.
	"kilo/stealth/glyph-cluster": {
		tools: true,
		vision: false,
		free: true,
		contextLength: 256_000,
		maxOutput: 256_000,
	},

	// Baidu / Thinking Machines — newest $0 entrants, with the biggest budgets.
	"kilo/baidu/ernie-5.5-flash-preview:free": {
		tools: true,
		vision: false,
		free: true,
		contextLength: 1_024_000,
		maxOutput: 921_600,
	},
	"kilo/thinkingmachines/inkling-2-small:free": {
		tools: true,
		vision: true,
		free: true,
		contextLength: 1_048_576,
		maxOutput: 131_072,
	},

	// Other $0 models (catalog-verified 2026-11-11).
	"kilo/dots-studio/dots-3-note-preview:free": {
		tools: true,
		vision: true,
		free: true,
		contextLength: 512_000,
		maxOutput: 460_800,
	},
	"kilo/cohere/north-mini-code:free": {
		tools: true,
		vision: false,
		free: true,
		contextLength: 256_000,
		maxOutput: 64_000,
	},
	"kilo/liquid/lfm-3-1.7b:free": {
		tools: true,
		vision: false,
		free: true,
		contextLength: 262_144,
		maxOutput: 8_192,
	},

	// ── Qwen / DashScope (Alibaba Cloud Model Studio) ───────────────────────
	// No free model tier: these bill per token once the promotional quota is
	// spent. They are usable only when the operator allowlists them
	// (ALLOWED_MODELS) or turns FREE_MODELS_ONLY off.
	"qwen/qwen3.8-max": { tools: true, vision: true, free: false },
	"qwen/qwen3.8-max-0902": { tools: true, vision: true, free: false },
	"qwen/qwen3.8-flash": { tools: true, vision: true, free: false },
	"qwen/qwen3.8-27b": { tools: true, vision: true, free: false },
	"qwen/qwen3.8-omni-flash": { tools: true, vision: true, free: false },
	"qwen/qwen3.7-max": { tools: true, vision: true, free: false },
	"qwen/qwen3.7-plus": { tools: true, vision: true, free: false },
	"qwen/qwen3.7-flash": { tools: true, vision: true, free: false },
	"qwen/qwen3.6-plus": { tools: true, vision: true, free: false },
	"qwen/qwen3.6-flash": { tools: true, vision: true, free: false },
	"qwen/qwen3.5-plus": { tools: true, vision: true, free: false },
	"qwen/qwen3.5-flash": { tools: true, vision: true, free: false },
	"qwen/qwen3-coder-plus": { tools: true, vision: true, free: false },
	"qwen/qwen3-coder-flash": { tools: true, vision: false, free: false },
	"qwen/qwen3-coder-next": { tools: true, vision: false, free: false },
	"qwen/deepseek-v4-pro": { tools: true, vision: false, free: false },
	"qwen/deepseek-v4.1-flash": { tools: true, vision: true, free: false },
	"qwen/deepseek-v4-flash": { tools: true, vision: false, free: false },
	"qwen/kimi-k2.7-code": { tools: true, vision: false, free: false },
	"qwen/kimi-k2.6": { tools: true, vision: false, free: false },
	"qwen/kimi-k3": { tools: true, vision: true, free: false },
	"qwen/qwen3-max": { tools: true, vision: false, free: false },
	"qwen/qwen-plus": { tools: true, vision: false, free: false },
	"qwen/qwen-flash": { tools: true, vision: false, free: false },
	"qwen/qwen-turbo": { tools: true, vision: false, free: false },
	"qwen/qwen-vl-plus": { tools: true, vision: true, free: false },
	"qwen/qwen-vl-max": { tools: true, vision: true, free: false },
};

/**
 * Models with a restricted reasoning-effort vocabulary, matched on an id
 * fragment. Each vocabulary is listed weakest-first, like ANY_REASONING_EFFORT.
 */
const REASONING_VOCABULARIES: ReadonlyArray<{
	match: RegExp;
	efforts: readonly string[];
}> = [
	// Tencent Hy3 strictly accepts only "no_think", "low", or "high"; anything
	// else is a 400 rather than a silent downgrade.
	{ match: /hy3/i, efforts: ["no_think", "low", "high"] },
];

/**
 * Every provider-qualified id the capability table marks `free: true`. Used to
 * derive the default ALLOWED_MODELS so the two cannot drift apart.
 */
export function freeModelIds(): string[] {
	return Object.entries(CAPABILITIES)
		.filter(([, caps]) => caps.free)
		.map(([id]) => id);
}

/** Resolve a provider prefix to its canonical name, or undefined if unknown. */
function canonicalProvider(prefix: string): ProviderName | undefined {
	return PROVIDER_PREFIXES[prefix.toLowerCase()];
}

/**
 * Rewrite a provider-qualified model id so alias prefixes become canonical
 * ("dashscope/qwen3-max" → "qwen/qwen3-max"). Used when reading operator
 * configuration so ALLOWED_MODELS / FALLBACK_MODELS entries written with an
 * alias still match routing decisions.
 */
export function canonicalizeModelId(value: string): string {
	const slash = value.indexOf("/");
	if (slash <= 0) return value;
	const canonical = canonicalProvider(value.slice(0, slash));
	if (!canonical) return value;
	const model = value.slice(slash + 1);
	return model.toLowerCase().startsWith(`${canonical}/`)
		? value
		: `${canonical}/${model}`;
}

export function parseTarget(
	value: string,
	fallbackProvider: ProviderName = "kilo",
): UpstreamTarget {
	const slash = value.indexOf("/");
	if (slash > 0) {
		const provider = canonicalProvider(value.slice(0, slash));
		if (provider) return { provider, model: value.slice(slash + 1) };
	}
	return { provider: fallbackProvider, model: value };
}

export function getProvider(config: Config, provider: ProviderName) {
	if (provider === "qwen") {
		return {
			name: provider,
			baseUrl: config.qwenBaseUrl,
			apiKey: config.qwenApiKey,
		};
	}
	return {
		name: provider,
		baseUrl: config.kiloBaseUrl,
		apiKey: config.kiloApiKey,
	};
}

/** A provider is enabled when a key exists in config OR arrives with the request. */
export function providerEnabled(
	config: Config,
	provider: ProviderName,
	requestApiKey = "",
): boolean {
	return Boolean(getProvider(config, provider).apiKey || requestApiKey);
}

export function displayTarget(target: UpstreamTarget): string {
	return `${target.provider}/${target.model}`;
}

/**
 * Whether a model is usable under FREE_MODELS_ONLY. Fails closed: only models
 * explicitly marked `free: true` (or Kilo's syntactic ":free"/"-free" tier
 * markers) qualify. A promotional token quota is not a free tier, so Qwen
 * models require an explicit ALLOWED_MODELS opt-in.
 */
export function isFreeTarget(target: UpstreamTarget): boolean {
	const entry = CAPABILITIES[displayTarget(target)];
	if (entry) return entry.free;
	if (target.provider === "kilo") {
		// Unknown-but-syntactically-free ids (new models not yet in the table).
		return target.model.endsWith(":free") || target.model.endsWith("-free");
	}
	return false;
}

/**
 * Apply the gateway model prefix (MODEL_PREFIX) to a kilo target. Qwen models
 * are never prefixed.
 *
 * Prefixing lives here — the single place the upstream model name is decided —
 * so translateRequest stays prefix-free. Note that the allowlist gate checks
 * the *unprefixed* provider-qualified id (see routing.isTargetAllowed), so
 * MODEL_PREFIX is trusted operator configuration, not a client-controlled
 * value, and is never used to widen what a client may reach.
 */
export function qualifyModel(target: UpstreamTarget, config: Config): string {
	if (target.provider !== "kilo" || !config.modelPrefix) return target.model;
	return target.model.startsWith(config.modelPrefix)
		? target.model
		: config.modelPrefix + target.model;
}

export function getCapabilities(target: UpstreamTarget): ModelCapabilities {
	// Unknown models are allowed for text-only requests, but never assumed to
	// support Claude Code tools or image input.
	return (
		CAPABILITIES[displayTarget(target)] ?? { tools: false, vision: false, free: false }
	);
}

/** Output ceiling used when the model's own budget is unknown. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Largest `max_tokens` this model is known to emit.
 *
 * The ceiling has to be per model: the free tier spans 8K (LFM3 1.7B) to 921K
 * (ERNIE 5.5 Flash), so a single global cap either truncates a model built for
 * large rewrites or promises output a small one cannot deliver. Unknown models
 * keep the conservative default.
 */
export function maxOutputTokens(target: UpstreamTarget): number {
	return CAPABILITIES[displayTarget(target)]?.maxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * The reasoning-effort vocabulary a target accepts, or `ANY_REASONING_EFFORT`
 * when the upstream takes whatever the client asked for.
 */
export function reasoningVocabulary(target: UpstreamTarget): readonly string[] {
	const declared = CAPABILITIES[displayTarget(target)]?.reasoningEfforts;
	if (declared) return declared;
	for (const entry of REASONING_VOCABULARIES) {
		if (entry.match.test(target.model)) return entry.efforts;
	}
	return ANY_REASONING_EFFORT;
}

/**
 * Clamp `reasoning_effort` to what the target actually accepts.
 *
 * Restricted upstreams (e.g. Tencent Hy3: no_think | low | high) reject the
 * OpenAI-standard spellings outright, so an unadapted value costs the whole
 * turn with a 400. Clamping picks the strongest supported effort that is not
 * stronger than the one requested, so the model never thinks *less* than the
 * caller asked for. This reproduces the previous hand-written Hy3 mapping
 * (max/xhigh/high → high, medium/low → low, no_think → no_think) from data
 * rather than from a model-name substring check.
 */
export function normalizeReasoningEffort(
	target: UpstreamTarget,
	effort?: string,
): string | undefined {
	if (!effort) return undefined;
	const vocabulary = reasoningVocabulary(target);
	if (vocabulary === ANY_REASONING_EFFORT) return effort;
	if (vocabulary.includes(effort)) return effort;

	const requestedIndex = ANY_REASONING_EFFORT.indexOf(effort);
	// An unrecognised effort has no position on the scale; fall back to the
	// strongest the upstream accepts, matching the old hardcoded "high".
	if (requestedIndex === -1) return vocabulary[vocabulary.length - 1];
	for (let i = requestedIndex; i >= 0; i--) {
		const candidate = ANY_REASONING_EFFORT[i];
		if (vocabulary.includes(candidate)) return candidate;
	}
	return vocabulary[0];
}
