// ============================================================================
// handlers/upstream.ts — the upstream call, cooldown, and fallback loop
// ============================================================================

import type { Config } from "../config";
import { anthropicError, mapUpstreamErrorType, truncate } from "../errors";
import { colors, error, log, redact } from "../log";
import {
	displayTarget,
	getProvider,
	maxOutputTokens,
	normalizeReasoningEffort,
	type ProviderName,
	qualifyModel,
	type UpstreamTarget,
} from "../providers";
import {
	getRuntime,
	modelHealthPenalty,
	recordFallback,
	recordModelFailure,
	recordModelRequest,
	recordModelSuccess,
	recordUpstreamError,
	recordUpstreamTimeout,
} from "../runtime";
import type { OpenAIChatRequest } from "../types";

const { green, yellow, dim } = colors;

/** Abort detection that also covers Bun's string abort reasons. */
export function isAbortError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (err instanceof Error && err.name === "AbortError") || /abort/i.test(msg);
}

/**
 * Parse Retry-After as a cooldown hint. Supports delay-seconds and HTTP-date.
 * Result is clamped to a sane upper bound so a misbehaving upstream cannot
 * quarantine a model for hours.
 */
export function retryAfterMs(
	header: string | null | undefined,
	now = Date.now(),
): number | undefined {
	if (!header) return undefined;
	const value = header.trim();
	if (!value) return undefined;
	const maxMs = 5 * 60_000;
	if (/^\d+$/.test(value)) {
		return Math.min(maxMs, Math.max(0, Number(value) * 1000));
	}
	const date = Date.parse(value);
	if (!Number.isNaN(date)) {
		return Math.min(maxMs, Math.max(0, date - now));
	}
	return undefined;
}

/**
 * Whether an upstream status says something about the *model or provider*
 * rather than about the request.
 *
 * 404 = model retired/renamed, 403/402 = quota exhausted or free tier blocked,
 * 429 = rate limit, 408 = gateway timeout, 5xx = server error. A 400 is the
 * client's fault and would fail identically on every candidate, so treating it
 * as transient would only multiply the latency of a doomed request.
 *
 * This is the single definition of "transient", shared by the two decisions
 * that depend on it: retry on the next candidate, and cool the model down. They
 * were two hand-written lists of the same six statuses, free to drift apart and
 * skip a cooldown for a status that was still being retried.
 */
export function isTransientStatus(status: number): boolean {
	return (
		status === 404 ||
		status === 408 ||
		status === 429 ||
		status === 403 ||
		status === 402 ||
		status >= 500
	);
}

/** Whether a failed status is worth retrying on the next candidate. */
export function canFallback(
	status: number,
	attempt: number,
	totalAttempts: number,
): boolean {
	return attempt < totalAttempts - 1 && isTransientStatus(status);
}

type UpstreamOutcome =
	| {
			ok: true;
			response: Response;
			/** Still governs the body, since `fetch` resolved on headers only. */
			controller: AbortController;
			target: UpstreamTarget;
			/**
			 * Detaches the client-abort listener this call registered. The caller
			 * owns it from here: it must invoke `detach` once the body has been
			 * consumed (or abandoned), or the listener outlives the request.
			 */
			detach: () => void;
	  }
	| { ok: false; response: Response };

interface UpstreamCall {
	config: Config;
	/** Aborted when the client disconnects; forwarded to every attempt. */
	signal: AbortSignal;
	/** Ordered, already-filtered candidates. The first is the requested model. */
	targets: UpstreamTarget[];
	/** Translated request body; `model` is rewritten per attempt. */
	body: OpenAIChatRequest;
	/** Client-supplied key, used only when no provider key is configured. */
	requestApiKey: string;
	requestedProvider: ProviderName;
	requestId: string;
}

/**
 * Try each candidate in order until one answers, applying per-model cooldowns,
 * and return the first success together with the AbortController that still
 * governs its body.
 *
 * The controller is handed back deliberately: `fetch` resolves on *headers*,
 * so the caller needs a live handle to bound the body read. Both the streaming
 * and the non-streaming path depend on this, and losing the handle is what used
 * to let a stalled upstream pin a concurrency slot forever.
 */
export async function callUpstream(call: UpstreamCall): Promise<UpstreamOutcome> {
	const { config, signal, targets, body, requestApiKey, requestedProvider, requestId } =
		call;

	if (!targets.length) {
		return {
			ok: false,
			response: anthropicError(502, "api_error", "No upstream model was available."),
		};
	}

	const { cooldowns } = getRuntime(config);

	// Prefer candidates that are not cooling down, but never give up entirely:
	// if every candidate is in cooldown, trying them anyway beats refusing the
	// request outright.
	const fresh = targets.filter((t) => !cooldowns.isCooling(displayTarget(t)));
	const base = fresh.length ? fresh : targets;
	// Secondary health-aware ordering: keep the original/requested candidate in
	// front when it is eligible at the head, and otherwise prefer healthier
	// candidates among those with equal eligibility.
	const ordered = (() => {
		if (base.length <= 1) return base;
		const penalty = (t: UpstreamTarget) => modelHealthPenalty(displayTarget(t));
		if (base[0] === targets[0]) {
			return [base[0], ...base.slice(1).sort((a, b) => penalty(a) - penalty(b))];
		}
		return [...base].sort((a, b) => penalty(a) - penalty(b));
	})();

	for (let attempt = 0; attempt < ordered.length; attempt++) {
		const target = ordered[attempt];
		const provider = getProvider(config, target.provider);
		// A request-supplied key is only ever applied to the provider the client
		// addressed; forwarding it to a different upstream would leak it.
		const apiKey =
			provider.apiKey || (target.provider === requestedProvider ? requestApiKey : "");

		const next: OpenAIChatRequest = { ...body, model: qualifyModel(target, config) };
		// Clamp against *this* candidate: the chain spans models with 8K to 921K
		// output budgets, so a ceiling chosen before routing would be wrong for
		// every candidate but one. Logged once, on the first attempt, so a
		// fallback turn does not repeat the same line.
		const requestedMax = next.max_tokens;
		const cap = maxOutputTokens(target);
		if (requestedMax != null && requestedMax > cap) {
			next.max_tokens = cap;
			if (attempt === 0) {
				log(`${dim("clamped max_tokens")} ${requestedMax} → ${cap} ${dim(requestId)}`);
			}
		}
		const effort = normalizeReasoningEffort(target, next.reasoning_effort);
		if (effort) {
			next.reasoning_effort = effort as OpenAIChatRequest["reasoning_effort"];
		} else {
			delete (next as { reasoning_effort?: unknown }).reasoning_effort;
		}

		recordModelRequest(displayTarget(target));
		const attemptStarted = performance.now();
		const controller = new AbortController();
		const abortUpstream = () => controller.abort("Client disconnected");
		signal.addEventListener("abort", abortUpstream, { once: true });
		// Bounds the *header* phase only. The body gets its own deadline, because
		// fetch() has already resolved by the time this is cleared.
		const headerTimer = setTimeout(
			() => controller.abort("upstream header timeout"),
			config.upstreamTimeoutMs,
		);

		try {
			const response = await fetch(`${provider.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(next),
				signal: controller.signal,
				tls: tlsOptions(config),
			});

			if (response.ok) {
				cooldowns.succeed(displayTarget(target));
				recordModelSuccess(displayTarget(target), performance.now() - attemptStarted);
				clearTimeout(headerTimer);
				if (attempt > 0) {
					recordFallback();
					log(`${green("↳")} fallback ${dim(displayTarget(target))} ${dim(requestId)}`);
				}
				// Ownership of the abort listener transfers to the caller, which
				// must call `detach` once the body has been consumed.
				return {
					ok: true,
					response,
					controller,
					target,
					detach: () => signal.removeEventListener("abort", abortUpstream),
				};
			}

			const errText = await response.text();
			recordUpstreamError(response.status);
			if (isTransientStatus(response.status)) {
				cooldowns.fail(
					displayTarget(target),
					retryAfterMs(response.headers.get("retry-after")),
				);
			}
			clearTimeout(headerTimer);
			signal.removeEventListener("abort", abortUpstream);

			if (canFallback(response.status, attempt, ordered.length)) {
				log(
					`${yellow("↳")} upstream ${response.status} for ${dim(displayTarget(target))}; trying ${dim(displayTarget(ordered[attempt + 1]))} ${dim(requestId)}`,
				);
				continue;
			}
			error(`Upstream ${response.status}: ${redact(errText).slice(0, 200)}`);
			return { ok: false, response: upstreamStatusResponse(response, errText) };
		} catch (err) {
			clearTimeout(headerTimer);
			signal.removeEventListener("abort", abortUpstream);

			// Distinguish "the client went away" from "the upstream gave up":
			// the first must not cool a healthy model down, the second must.
			if (signal.aborted && isAbortError(err)) {
				return {
					ok: false,
					response: anthropicError(499, "api_error", "Client disconnected."),
				};
			}
			if (isAbortError(err)) {
				recordUpstreamTimeout();
				recordModelFailure(displayTarget(target));
				cooldowns.fail(displayTarget(target));
				if (attempt < ordered.length - 1) {
					log(
						`${yellow("↳")} upstream timeout for ${dim(displayTarget(target))}; trying ${dim(displayTarget(ordered[attempt + 1]))} ${dim(requestId)}`,
					);
					continue;
				}
				return {
					ok: false,
					response: anthropicError(
						504,
						"api_error",
						`Upstream timeout after ${config.upstreamTimeoutMs}ms`,
					),
				};
			}

			recordUpstreamError();
			recordModelFailure(displayTarget(target));
			cooldowns.fail(displayTarget(target));
			if (attempt < ordered.length - 1) {
				log(
					`${yellow("↳")} upstream connection failed for ${dim(displayTarget(target))}; trying ${dim(displayTarget(ordered[attempt + 1]))} ${dim(requestId)}`,
				);
				continue;
			}
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				response: anthropicError(
					502,
					"api_error",
					`Failed to reach upstream: ${redact(msg)}`,
				),
			};
		}
	}

	return {
		ok: false,
		response: anthropicError(502, "api_error", "No upstream model was available."),
	};
}

/** Mirror a non-2xx upstream response, preserving its Retry-After hint. */
function upstreamStatusResponse(response: Response, errText: string): Response {
	const retryAfter = response.headers.get("retry-after");
	return anthropicError(
		response.status >= 400 && response.status < 600 ? response.status : 502,
		mapUpstreamErrorType(response.status),
		`Upstream returned ${response.status}: ${truncate(redact(errText), 2000)}`,
		retryAfter ? { "retry-after": retryAfter } : undefined,
	);
}

/**
 * Bun's fetch TLS options. Omitted entirely when verification is on and no
 * extra CA is configured, so the secure default really is the default.
 */
function tlsOptions(config: Config): BunFetchRequestInitTLS | undefined {
	if (config.upstreamTlsRejectUnauthorized && !config.upstreamCaFile) return undefined;
	return {
		rejectUnauthorized: config.upstreamTlsRejectUnauthorized,
		...(config.upstreamCaFile ? { ca: [Bun.file(config.upstreamCaFile)] } : {}),
	};
}
