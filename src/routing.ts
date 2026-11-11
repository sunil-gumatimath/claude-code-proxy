// ============================================================================
// routing.ts — model resolution, capability filtering, and the cost gate
//
// Pure functions only: no I/O, no request state. Kept separate from the
// message handler so the security-critical allowlist logic can be read (and
// tested) without wading through the SSE pump.
// ============================================================================

import type { Config } from "./config";
import {
	displayTarget,
	getCapabilities,
	getProvider,
	isFreeTarget,
	parseTarget,
	providerEnabled,
	type UpstreamTarget,
} from "./providers";
import type { AnthropicContentBlock, AnthropicMessagesRequest } from "./types";

/**
 * Whether a content block needs a multimodal model: an `image`, an image
 * nested inside a `tool_result`, or a binary `document` (PDF) attachment.
 *
 * Tool output is a common source of images (a browser screenshot, Read on a
 * PNG), and a text-only model sent one either errors or silently ignores it.
 * A `document` with a *text* source is flattened to text by the translator, so
 * it deliberately does not count here.
 */
function blockHasImage(block: AnthropicContentBlock): boolean {
	if (block.type === "image") return true;
	if (block.type === "document") {
		const source = (block as { source?: { type?: string } }).source;
		return source?.type === "base64";
	}
	if (block.type !== "tool_result") return false;
	const content = (block as { content?: unknown }).content;
	return (
		Array.isArray(content) &&
		content.some(
			(part) =>
				part && typeof part === "object" && (part as { type?: string }).type === "image",
		)
	);
}

/** True when any message carries a block only a multimodal model can read. */
export function requestNeedsVision(body: AnthropicMessagesRequest): boolean {
	return (
		body.messages?.some(
			(message) => Array.isArray(message.content) && message.content.some(blockHasImage),
		) ?? false
	);
}

/**
 * Map a glob pattern to a matcher. `*` is the only metacharacter; everything
 * else is escaped so a pattern like `claude+sonnet` matches literally.
 */
function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

export function globMatches(pattern: string, value: string): boolean {
	return globToRegExp(pattern).test(value);
}

/**
 * Decide which upstream model a request should actually go to.
 *
 * Smart routing only rewrites bare `claude-*` names through the alias table.
 * A provider-qualified id is already an explicit choice and is left alone, so
 * a client that names `kilo/…` or `qwen/…` always gets exactly that model.
 */
export function resolveTarget(
	requestedModel: string,
	body: AnthropicMessagesRequest,
	config: Config,
): UpstreamTarget {
	const explicit = parseTarget(requestedModel);
	if (!config.smartRouting || !requestedModel.toLowerCase().startsWith("claude-")) {
		return explicit;
	}
	const requested = requestedModel.toLowerCase();
	if (requestNeedsVision(body)) return parseTarget(config.visionModel);
	const alias = config.modelAliases.find(({ pattern }) =>
		globMatches(pattern, requested),
	);
	return alias ? parseTarget(alias.model) : explicit;
}

/**
 * The cost-control gate. Returns true only for a model the operator has
 * explicitly approved, and (while FREE_MODELS_ONLY is on) only if it is on a
 * genuine free tier.
 *
 * Deliberately checked against the *unprefixed* provider-qualified id, which
 * is also what MODEL_ALIASES / ALLOWED_MODELS are written in. MODEL_PREFIX is
 * applied later, at the wire boundary, and is trusted operator configuration —
 * it can never widen what a client is allowed to reach.
 */
export function isTargetAllowed(target: UpstreamTarget, config: Config): boolean {
	return !explainAllowlistRejection(target, config);
}

/** Why the cost/allowlist gate rejects a target, or undefined if allowed. */
export function explainAllowlistRejection(
	target: UpstreamTarget,
	config: Config,
): string | undefined {
	const id = displayTarget(target);
	const explicitlyAllowed = config.allowedModels.includes(id);
	if (config.freeModelsOnly && !isFreeTarget(target) && !explicitlyAllowed) {
		return "blocked by FREE_MODELS_ONLY (not a recognized free-tier model and not explicitly allowlisted)";
	}
	if (config.allowedModels.length && !explicitlyAllowed) {
		return "not in ALLOWED_MODELS";
	}
	return undefined;
}

function providerKeyAvailable(
	config: Config,
	target: UpstreamTarget,
	first: UpstreamTarget,
	requestApiKey: string,
): boolean {
	return providerEnabled(
		config,
		target.provider,
		target.provider === first.provider ? requestApiKey : "",
	);
}

/** Why a candidate cannot serve this request, or undefined if usable. */
export function explainCandidateRejection(
	target: UpstreamTarget,
	body: AnthropicMessagesRequest,
	config: Config,
	first: UpstreamTarget,
	requestApiKey = "",
): string | undefined {
	const allow = explainAllowlistRejection(target, config);
	if (allow) return allow;
	if (!providerKeyAvailable(config, target, first, requestApiKey)) {
		const hasConfigured = Boolean(getProvider(config, target.provider).apiKey);
		const crossProviderClientKey =
			!hasConfigured && Boolean(requestApiKey) && target.provider !== first.provider;
		return crossProviderClientKey
			? `no API key configured for provider ${target.provider} (a request-supplied key is only applied to the requested provider)`
			: `no API key configured for provider ${target.provider}`;
	}
	const needsTools = Boolean(body.tools?.length);
	const needsVision = requestNeedsVision(body);
	const capabilities = getCapabilities(target);
	const missing: string[] = [];
	if (needsTools && !capabilities.tools) missing.push("tool calling");
	if (needsVision && !capabilities.vision) missing.push("image/vision input");
	if (missing.length) return `model does not support ${missing.join(" or ")}`;
	return undefined;
}

/**
 * A short, operator-facing diagnosis for "no usable candidates". Mirrors the
 * same filters as buildCandidateTargets so the message explains the real
 * outcome without leaking credentials.
 */
export function diagnoseNoCandidates(
	first: UpstreamTarget,
	body: AnthropicMessagesRequest,
	config: Config,
	requestApiKey = "",
): string {
	const requested = displayTarget(first);
	const requestedReason = explainCandidateRejection(
		first,
		body,
		config,
		first,
		requestApiKey,
	);
	const fallbacks = config.fallbackModels.map((model) => parseTarget(model));
	const reasons = new Set<string>();
	let usableFallbackShape = 0;
	for (const target of fallbacks) {
		if (displayTarget(target) === requested) continue;
		const reason = explainCandidateRejection(target, body, config, first, requestApiKey);
		if (!reason) {
			usableFallbackShape++;
		} else {
			reasons.add(reason);
		}
	}
	const parts = [`Requested model ${requested}: ${requestedReason ?? "not usable"}.`];
	if (!fallbacks.length) {
		parts.push("No FALLBACK_MODELS are configured.");
	} else if (usableFallbackShape === 0) {
		parts.push(
			reasons.size
				? `No fallback candidate was usable (${[...reasons].join("; ")}).`
				: "No fallback candidate was usable.",
		);
	}
	parts.push(
		"Check ALLOWED_MODELS/FREE_MODELS_ONLY, provider API keys, and the model's tool/vision capabilities.",
	);
	return parts.join(" ");
}

/**
 * Ordered upstream candidates: the requested model first, then FALLBACK_MODELS,
 * filtered down to what is allowed, what has a provider key, and what actually
 * supports the request's required capabilities. Deduped by canonical id while
 * preserving first-seen order so the primary stays in front.
 */
export function buildCandidateTargets(
	first: UpstreamTarget,
	body: AnthropicMessagesRequest,
	config: Config,
	requestApiKey = "",
): UpstreamTarget[] {
	const targets = [first, ...config.fallbackModels.map((model) => parseTarget(model))];
	return [
		...new Map(
			targets
				.filter(
					(target) =>
						!explainCandidateRejection(target, body, config, first, requestApiKey),
				)
				.map((target) => [displayTarget(target), target]),
		).values(),
	];
}
