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
	isFreeTarget,
	parseTarget,
	providerEnabled,
	type UpstreamTarget,
} from "./providers";
import type { AnthropicMessagesRequest } from "./types";

/** True when any user message carries an `image` content block. */
export function requestNeedsVision(body: AnthropicMessagesRequest): boolean {
	return (
		body.messages?.some(
			(message) =>
				Array.isArray(message.content) &&
				message.content.some((block) => block.type === "image"),
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
	const id = displayTarget(target);
	const explicitlyAllowed = config.allowedModels.includes(id);
	// FREE_MODELS_ONLY rejects paid models unless the operator has explicitly
	// allowlisted them (ALLOWED_MODELS is an explicit approval list).
	if (config.freeModelsOnly && !isFreeTarget(target) && !explicitlyAllowed) return false;
	return !config.allowedModels.length || explicitlyAllowed;
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
	const needsTools = Boolean(body.tools?.length);
	const needsVision = requestNeedsVision(body);
	const targets = [first, ...config.fallbackModels.map((model) => parseTarget(model))];
	return [
		...new Map(
			targets
				.filter((target) => isTargetAllowed(target, config))
				.filter((target) =>
					providerEnabled(
						config,
						target.provider,
						target.provider === first.provider ? requestApiKey : "",
					),
				)
				.filter((target) => {
					const capabilities = getCapabilities(target);
					return (
						(!needsTools || capabilities.tools) && (!needsVision || capabilities.vision)
					);
				})
				.map((target) => [displayTarget(target), target]),
		).values(),
	];
}
