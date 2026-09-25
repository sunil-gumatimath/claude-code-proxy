// ============================================================================
// handlers/messages.ts — POST /v1/messages and /v1/messages/count_tokens
// ============================================================================

import { extractApiKey, isAuthorized } from "../auth";
import type { Config } from "../config";
import { anthropicError, extractErrorMessage, rateLimited, truncate } from "../errors";
import { colors, debug, error, log, redact } from "../log";
import { displayTarget, qualifyModel } from "../providers";
import { buildCandidateTargets, isTargetAllowed, resolveTarget } from "../routing";
import { beginRequest, getRuntime, recordUpstreamError } from "../runtime";
import { translateRequest, translateResponse, uid } from "../translate";
import type { AnthropicMessagesRequest, OpenAIChatResponse } from "../types";
import { BODY_ABORTED, BODY_TOO_LARGE, isBodyError, readBodyLimited } from "./body";
import { handleStream } from "./stream";
import { callUpstream } from "./upstream";

const { cyan, green, bold, dim } = colors;

/** Hard ceiling on max_tokens, independent of what the client asks for. */
const MAX_OUTPUT_TOKENS = 16384;

const CLIENT_GONE = () => anthropicError(499, "api_error", "Client disconnected.");

export async function handleMessages(req: Request, config: Config): Promise<Response> {
	const startTime = performance.now();
	const requestId = resolveRequestId(req);
	let releaseSlot: (() => void) | undefined;
	let finishRequest: (() => void) | undefined;

	try {
		if (!isAuthorized(req, config.proxyApiKey)) {
			return anthropicError(401, "authentication_error", "Invalid proxy API key.");
		}

		const body = await parseMessagesBody(req, config);
		if (body instanceof Response) return body;

		const originalModel = body.model || config.defaultModel;
		const isStream = body.stream === true;
		finishRequest = beginRequest(isStream);
		log(
			`${cyan("→")} ${isStream ? "stream" : "  sync"} ${bold(originalModel)} ${dim(requestId)}`,
		);
		debug("Anthropic request body", body);

		const requestedTarget = resolveTarget(originalModel, body, config);
		if (!isTargetAllowed(requestedTarget, config)) {
			return anthropicError(
				400,
				"invalid_request_error",
				`Model is not permitted by this free-only proxy: ${displayTarget(requestedTarget)}`,
			);
		}

		// When proxy authentication is configured, the client token is the proxy
		// secret and must never be forwarded as an upstream provider key.
		const requestApiKey = config.proxyApiKey ? "" : extractApiKey(req);
		const targets = buildCandidateTargets(requestedTarget, body, config, requestApiKey);
		if (!targets.length) {
			return anthropicError(
				400,
				"invalid_request_error",
				"No enabled model supports this request's required capabilities.",
			);
		}
		debug(`Upstream candidates: ${targets.map(displayTarget).join(", ")}`);

		const translated = translateRequest(
			body,
			config.defaultModel,
			config.reasoningEffort,
		);
		// MODEL_PREFIX is applied in callUpstream, at the single point where the
		// upstream model name is finalized, so translateRequest stays prefix-free.
		translated.model = qualifyModel(requestedTarget, config);
		if (body.max_tokens != null && body.max_tokens > MAX_OUTPUT_TOKENS) {
			// Silently truncating is how a client ends up with mysteriously short
			// answers; say so in the log where the operator will actually see it.
			log(
				`${dim("clamped max_tokens")} ${body.max_tokens} → ${MAX_OUTPUT_TOKENS} ${dim(requestId)}`,
			);
		}
		debug("Translated OpenAI body", translated);

		if (req.signal.aborted) return CLIENT_GONE();
		const runtime = getRuntime(config);
		releaseSlot = await runtime.limiter.acquire(req.signal);
		if (!releaseSlot) {
			return req.signal.aborted
				? CLIENT_GONE()
				: rateLimited("Proxy is busy; try again shortly.");
		}
		if (req.signal.aborted) {
			releaseSlot();
			releaseSlot = undefined;
			return CLIENT_GONE();
		}

		const outcome = await callUpstream({
			config,
			signal: req.signal,
			targets,
			body: translated,
			requestApiKey,
			requestedProvider: requestedTarget.provider,
			requestId,
		});

		if (!outcome.ok) return outcome.response;

		// `detach` removes the client-abort listener that callUpstream registered.
		// It must run on every exit path, or the listener outlives the request.
		const { response: upstream, controller, detach } = outcome;

		if (isStream) {
			const streamRelease = releaseSlot;
			const streamFinish = finishRequest;
			releaseSlot = undefined;
			finishRequest = undefined;
			return handleStream(upstream, {
				model: originalModel,
				requestId,
				startTime,
				upstreamController: controller,
				cleanup: () => {
					detach();
					streamRelease?.();
					streamFinish?.();
				},
				maxBufferBytes: config.maxBodyBytes,
				idleTimeoutMs: config.upstreamTimeoutMs,
			});
		}

		try {
			return await handleSync({
				upstream,
				model: originalModel,
				startTime,
				requestId,
			});
		} finally {
			detach();
		}
	} catch (err) {
		return proxyFailure(err, config);
	} finally {
		releaseSlot?.();
		finishRequest?.();
	}
}

/**
 * POST /v1/messages/count_tokens — Claude Code calls this for context
 * accounting. OpenAI-compatible upstreams have no equivalent endpoint, so we
 * return a deterministic character-based estimate (Anthropic's own heuristic
 * is roughly chars/4). The proxy treats it as an estimate only.
 *
 * Deliberately does NOT take a slot from the upstream RequestLimiter: it
 * performs no upstream work and Claude Code calls it constantly, so sharing
 * the limiter meant a busy proxy answered its own context accounting with 429.
 */
export async function handleCountTokens(req: Request, config: Config): Promise<Response> {
	if (!isAuthorized(req, config.proxyApiKey)) {
		return anthropicError(401, "authentication_error", "Invalid proxy API key.");
	}
	if (req.signal.aborted) return CLIENT_GONE();

	let bodyText: string;
	try {
		bodyText = await readBodyLimited(req, config.maxBodyBytes);
	} catch (err) {
		if (isBodyError(err, BODY_TOO_LARGE)) {
			return tooLarge(config);
		}
		if (isBodyError(err, BODY_ABORTED)) return CLIENT_GONE();
		throw err;
	}

	try {
		JSON.parse(bodyText);
	} catch {
		return anthropicError(
			400,
			"invalid_request_error",
			"Request body must be valid JSON.",
		);
	}

	// Always at least 1: an empty conversation is not a zero-token request, and
	// Claude Code divides by this figure.
	const inputTokens = Math.max(1, Math.ceil(bodyText.length / 4));
	return Response.json(
		{ input_tokens: inputTokens },
		{ headers: { "Cache-Control": "no-store", "x-request-id": resolveRequestId(req) } },
	);
}

// ── Request parsing ─────────────────────────────────────────────────────────

function tooLarge(config: Config): Response {
	return anthropicError(
		413,
		"invalid_request_error",
		`Request body exceeds MAX_BODY_BYTES (${config.maxBodyBytes}).`,
	);
}

/** Parse and shape-check the request body, or return the error response. */
async function parseMessagesBody(
	req: Request,
	config: Config,
): Promise<AnthropicMessagesRequest | Response> {
	let bodyText: string;
	try {
		bodyText = await readBodyLimited(req, config.maxBodyBytes);
	} catch (err) {
		if (isBodyError(err, BODY_TOO_LARGE)) return tooLarge(config);
		if (isBodyError(err, BODY_ABORTED)) return CLIENT_GONE();
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return anthropicError(
			400,
			"invalid_request_error",
			"Request body must be valid JSON.",
		);
	}
	// Validate the handful of fields the translator actually dereferences, so a
	// malformed body fails here with a 400 instead of throwing deeper in.
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return anthropicError(
			400,
			"invalid_request_error",
			"Request body must be a JSON object.",
		);
	}
	const body = parsed as AnthropicMessagesRequest;
	if (body.messages !== undefined && !Array.isArray(body.messages)) {
		return anthropicError(400, "invalid_request_error", "`messages` must be an array.");
	}
	if (body.model !== undefined && typeof body.model !== "string") {
		return anthropicError(400, "invalid_request_error", "`model` must be a string.");
	}
	return body;
}

/**
 * Reuse the client's request id when it is safe to echo, so proxy logs line up
 * with the client's own trace; otherwise mint one. Sanitising to a strict
 * character set also makes header injection impossible.
 */
function resolveRequestId(req: Request): string {
	const inbound = req.headers.get("x-request-id")?.trim();
	if (inbound && /^[A-Za-z0-9._-]{1,128}$/.test(inbound)) return inbound;
	return `req_${uid()}`;
}

// ── Non-streaming response ──────────────────────────────────────────────────

interface SyncArgs {
	upstream: Response;
	model: string;
	startTime: number;
	requestId: string;
}

async function handleSync(args: SyncArgs): Promise<Response> {
	const { upstream, model, startTime, requestId } = args;
	const parsed = (await upstream.json()) as OpenAIChatResponse & {
		error?: { message?: unknown };
	};
	debug("OpenAI response", parsed);

	// Some gateways answer HTTP 200 with an error object in the body. Without
	// this check the proxy would forward a fabricated empty completion.
	if (parsed.error) {
		const msg = extractErrorMessage(parsed.error, "Upstream returned an error");
		// Counted so a gateway that fails this way shows up in
		// kilo_proxy_upstream_errors_total rather than looking like success.
		recordUpstreamError(200);
		error(`Upstream error: ${redact(msg).slice(0, 200)}`);
		return anthropicError(502, "api_error", `Upstream error: ${truncate(msg, 2000)}`, {
			"x-request-id": requestId,
		});
	}

	const result = translateResponse(parsed, model);
	const elapsed = (performance.now() - startTime).toFixed(0);
	log(
		`${green("←")}   sync ${dim(model)} stop=${result.stop_reason} ` +
			`in=${result.usage.input_tokens} out=${result.usage.output_tokens} ` +
			`${dim(`${elapsed}ms`)} ${dim(requestId)}`,
	);
	return Response.json(result, {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"x-request-id": requestId,
		},
	});
}

// ── Failure mapping ─────────────────────────────────────────────────────────

/**
 * Map an unexpected throw onto an Anthropic error. The message is redacted
 * before it leaves the process, so an internal path or an echoed credential
 * cannot reach the client through the 500 body.
 */
function proxyFailure(err: unknown, config: Config): Response {
	if (isBodyError(err, BODY_TOO_LARGE)) return tooLarge(config);
	if (isBodyError(err, BODY_ABORTED)) return CLIENT_GONE();
	const msg = err instanceof Error ? err.message : String(err);
	error(`Proxy error: ${msg}`);
	return anthropicError(500, "api_error", redact(msg) || "Internal server error.");
}
