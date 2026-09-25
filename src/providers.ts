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

export interface ModelCapabilities {
	tools: boolean;
	vision: boolean;
	/**
	 * Whether the model may be used while FREE_MODELS_ONLY is enabled.
	 * Providers with no free tier (Qwen/DashScope bills per token even on a
	 * promotional quota) must declare `free: false` and be opted in explicitly
	 * through ALLOWED_MODELS.
	 */
	free: boolean;
}

/**
 * Kilo's free tier. Verified against the live gateway catalog
 * (GET {KILO_BASE_URL}/models, $0 prompt/completion) plus a live
 * chat/completions tool-use smoke test.
 *
 * `free: true` means the upstream charges $0 today. The tier rotates as
 * providers end promotions, so re-check the catalog when a model starts
 * returning 404 (retired) or sustained 429 (capacity withdrawn).
 */
const CAPABILITIES: Record<string, ModelCapabilities> = {
	// Routers — no fixed underlying model, so behaviour can change server-side.
	"kilo/kilo-auto/free": { tools: true, vision: false, free: true }, // 256K, text only
	"kilo/openrouter/free": { tools: true, vision: true, free: true }, // 200K, text+image

	// NVIDIA Nemotron — the strongest free tier for long-context agentic work.
	"kilo/nvidia/nemotron-3-ultra-550b-a55b:free": {
		tools: true,
		vision: false,
		free: true,
	}, // 1M
	"kilo/nvidia/nemotron-3.5-lightning:free": { tools: true, vision: false, free: true }, // 1M
	"kilo/nvidia/nemotron-3-super-120b-a12b:free": {
		tools: true,
		vision: false,
		free: true,
	}, // 262K
	"kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {
		tools: true,
		vision: true,
		free: true,
	}, // 256K, omni

	"kilo/thinkingmachines/inkling-small:free": { tools: true, vision: true, free: true }, // 1M
	"kilo/stealth/space-bunny-alpha": { tools: true, vision: true, free: true }, // 1M, text+image+video
	"kilo/stepfun/step-3.7-flash:free": { tools: true, vision: true, free: true }, // 262K
	"kilo/qwen/qwen3.8-27b:free": { tools: true, vision: true, free: true }, // 262K
	"kilo/dots-studio/dots-3-note-preview:free": { tools: true, vision: true, free: true }, // 512K
	"kilo/poolside/laguna-s-2.1:free": { tools: true, vision: false, free: true }, // 262K
	"kilo/poolside/laguna-xs-2.1:free": { tools: true, vision: false, free: true }, // 262K
	"kilo/cohere/north-mini-code:free": { tools: true, vision: false, free: true }, // 256K, code-specialised
	"kilo/inclusionai/ling-3.0-flash-sante:free": {
		tools: true,
		vision: false,
		free: true,
	}, // 262K
	"kilo/inclusionai/ling-3.0-flash-fin:free": { tools: true, vision: false, free: true }, // 262K
	"kilo/liquid/lfm-2.5-2.6b:free": { tools: true, vision: false, free: true }, // 65K, too small for real sessions

	// ── Qwen / DashScope (Alibaba Cloud Model Studio) ───────────────────────
	// No free model tier: these bill per token once the promotional quota is
	// spent. They are usable only when the operator allowlists them
	// (ALLOWED_MODELS) or turns FREE_MODELS_ONLY off.
	"qwen/qwen3.8-max": { tools: true, vision: true, free: false },
	"qwen/qwen3.8-flash": { tools: true, vision: true, free: false },
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
	"qwen/deepseek-v4-flash": { tools: true, vision: false, free: false },
	"qwen/kimi-k2.7-code": { tools: true, vision: false, free: false },
	"qwen/kimi-k3": { tools: true, vision: true, free: false },
	"qwen/qwen3-max": { tools: true, vision: false, free: false },
	"qwen/qwen-plus": { tools: true, vision: false, free: false },
	"qwen/qwen-flash": { tools: true, vision: false, free: false },
	"qwen/qwen-turbo": { tools: true, vision: false, free: false },
	"qwen/qwen-vl-plus": { tools: true, vision: true, free: false },
	"qwen/qwen-vl-max": { tools: true, vision: true, free: false },
};

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
 * are never prefixed. Prefixing lives here — the single place the upstream
 * model name is decided — so translateRequest stays prefix-free.
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

/**
 * Adapt reasoning_effort to upstream requirements.
 * Tencent Hy3 strictly accepts only "no_think", "low", or "high".
 */
export function normalizeReasoningEffort(
	target: UpstreamTarget,
	effort?: string,
): string | undefined {
	if (!effort) return undefined;
	const isHy3 = target.model.toLowerCase().includes("hy3");
	if (isHy3) {
		if (effort === "max" || effort === "xhigh" || effort === "high") return "high";
		if (effort === "medium" || effort === "low") return "low";
		if (effort === "no_think") return "no_think";
		return "high";
	}
	return effort;
}
