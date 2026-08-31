// ============================================================================
// handlers/messages.ts — POST /v1/messages
// ============================================================================
import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "../config";
import { extractApiKey } from "../auth";
import {
	anthropicError,
	anthropicErrorSse,
	extractErrorMessage,
	mapUpstreamErrorType,
	truncate,
} from "../errors";
import { colors, debug, error, log } from "../log";
import {
	beginRequest,
	getRuntime,
	recordFallback,
	recordModelRequest,
	recordUpstreamError,
} from "../runtime";
import {
	StreamTranslator,
	translateRequest,
	translateResponse,
	uid,
} from "../translate";
import type { AnthropicMessagesRequest, OpenAIChatResponse } from "../types";
import {
	displayTarget,
	getCapabilities,
	getProvider,
	isFreeTarget,
	normalizeReasoningEffort,
	parseTarget,
	providerEnabled,
	qualifyModel,
	type UpstreamTarget,
} from "../providers";

const { cyan, green, bold, dim } = colors;

export async function handleMessages(
	req: Request,
	config: Config,
): Promise<Response> {
	const startTime = performance.now();
	const requestId = `req_${uid()}`;
	let releaseSlot: (() => void) | undefined;
	let finishRequest: (() => void) | undefined;

	try {
		if (!isAuthorized(req, config.proxyApiKey)) {
			return anthropicError(401, "authentication_error", "Invalid proxy API key.");
		}

		const bodyText = await readBodyLimited(req, config.maxBodyBytes);
		let body: AnthropicMessagesRequest;
		try {
			const parsed: unknown = JSON.parse(bodyText);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("INVALID_BODY");
			}
			body = parsed as AnthropicMessagesRequest;
			if (body.messages !== undefined && !Array.isArray(body.messages)) {
				throw new Error("INVALID_BODY");
			}
			if (body.model !== undefined && typeof body.model !== "string") {
				throw new Error("INVALID_BODY");
			}
		} catch {
			return anthropicError(
				400,
				"invalid_request_error",
				"Request body must be valid JSON.",
			);
		}

		const originalModel = body.model || config.defaultModel;
		const isStream = body.stream === true;
		finishRequest = beginRequest(isStream);

		log(
			`${cyan("→")} ${isStream ? "stream" : "  sync"} ${bold(originalModel)} ${dim(requestId)}`,
		);
		debug("Anthropic request body", body);

		const requestedTarget = resolveTarget(
			body.model || config.defaultModel,
			body,
			config,
		);
		if (!isTargetAllowed(requestedTarget, config)) {
			return anthropicError(
				400,
				"invalid_request_error",
				`Model is not permitted by this free-only proxy: ${displayTarget(requestedTarget)}`,
			);
		}
		const openaiBody = translateRequest(
			body,
			config.defaultModel,
			config.reasoningEffort,
		);
		// MODEL_PREFIX is applied here — the single place the upstream model
		// name is finalized — so translateRequest stays prefix-free.
		openaiBody.model = qualifyModel(requestedTarget, config);
		debug("Translated OpenAI body", openaiBody);

		// When proxy authentication is configured, the client token is the proxy
		// secret and must never be forwarded as an upstream provider key.
		const requestApiKey = config.proxyApiKey ? "" : extractApiKey(req);
		const enabledTargets = buildCandidateTargets(
			requestedTarget,
			body,
			config,
			requestApiKey,
		);
		if (!enabledTargets.length) {
			return anthropicError(
				400,
				"invalid_request_error",
				"No enabled free model supports this request's required capabilities.",
			);
		}
		debug(`Upstream candidates: ${enabledTargets.map(displayTarget).join(", ")}`);

		let controller!: AbortController;
		let abortUpstream!: () => void;
		const runtime = getRuntime(config);
		if (req.signal.aborted) {
			return anthropicError(499, "api_error", "Client disconnected.");
		}
		releaseSlot = await runtime.limiter.acquire(req.signal);
		if (!releaseSlot) {
			if (req.signal.aborted) {
				return anthropicError(499, "api_error", "Client disconnected.");
			}
			return anthropicError(
				429,
				"rate_limit_error",
				"Proxy is busy; try again shortly.",
			);
		}
		if (req.signal.aborted) {
			releaseSlot();
			releaseSlot = undefined;
			return anthropicError(499, "api_error", "Client disconnected.");
		}

		const cooled = enabledTargets.filter(
			(target) => !runtime.cooldowns.isCooling(displayTarget(target)),
		);
		const targets = cooled.length ? cooled : enabledTargets;
		let upstreamRes: Response | undefined;

		for (let attempt = 0; attempt < targets.length; attempt++) {
			const target = targets[attempt];
			const provider = getProvider(config, target.provider);
			const apiKey =
				provider.apiKey ||
				(target.provider === requestedTarget.provider ? requestApiKey : "");
			openaiBody.model = qualifyModel(target, config);
			const targetEffort = normalizeReasoningEffort(
				target,
				openaiBody.reasoning_effort,
			);
			const payload = {
				...openaiBody,
				...(targetEffort ? { reasoning_effort: targetEffort } : {}),
			};
			if (!targetEffort && "reasoning_effort" in payload) {
				delete (payload as { reasoning_effort?: unknown }).reasoning_effort;
			}
			recordModelRequest(displayTarget(target));
			controller = new AbortController();
			abortUpstream = () => controller.abort("Client disconnected");
			req.signal.addEventListener("abort", abortUpstream, { once: true });
			const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

			try {
				const response = await fetch(`${provider.baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify(payload),
					signal: controller.signal,
					tls:
						config.upstreamTlsRejectUnauthorized && !config.upstreamCaFile
							? undefined
							: {
									rejectUnauthorized: config.upstreamTlsRejectUnauthorized,
									...(config.upstreamCaFile
										? { ca: [Bun.file(config.upstreamCaFile)] }
										: {}),
								},
				});

				if (response.ok) {
					upstreamRes = response;
					runtime.cooldowns.succeed(displayTarget(target));
					if (attempt > 0) {
						recordFallback();
						log(
							`${green("↳")} fallback ${dim(displayTarget(target))} ${dim(requestId)}`,
						);
					}
					break;
				}

				const errText = await response.text();
				recordUpstreamError(response.status);
				if (
					response.status === 429 ||
					response.status === 404 ||
					response.status >= 500
				)
					runtime.cooldowns.fail(displayTarget(target));
				if (canFallback(response.status, attempt, targets.length)) {
					log(
						`${colors.yellow("↳")} upstream ${response.status} for ${dim(displayTarget(target))}; trying ${dim(displayTarget(targets[attempt + 1]))} ${dim(requestId)}`,
					);
					req.signal.removeEventListener("abort", abortUpstream);
					continue;
				}
				req.signal.removeEventListener("abort", abortUpstream);
				error(`Upstream ${response.status}: ${errText.slice(0, 200)}`);
				return anthropicError(
					response.status >= 400 && response.status < 600 ? response.status : 502,
					mapUpstreamErrorType(response.status),
					`Upstream returned ${response.status}: ${truncate(errText, 2000)}`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const isAbort =
					(err instanceof Error && err.name === "AbortError") || /abort/i.test(msg);
				if (isAbort && req.signal.aborted) {
					req.signal.removeEventListener("abort", abortUpstream);
					return anthropicError(
						504,
						"api_error",
						req.signal.aborted
							? "Client disconnected."
							: `Upstream timeout after ${config.upstreamTimeoutMs}ms`,
					);
				}
				if (isAbort) {
					recordUpstreamError(504);
					runtime.cooldowns.fail(displayTarget(target));
					if (attempt < targets.length - 1) {
						log(
							`${colors.yellow("↳")} upstream timeout for ${dim(displayTarget(target))}; trying ${dim(displayTarget(targets[attempt + 1]))} ${dim(requestId)}`,
						);
						req.signal.removeEventListener("abort", abortUpstream);
						continue;
					}
					req.signal.removeEventListener("abort", abortUpstream);
					return anthropicError(
						504,
						"api_error",
						`Upstream timeout after ${config.upstreamTimeoutMs}ms`,
					);
				}
				recordUpstreamError();
				runtime.cooldowns.fail(displayTarget(target));
				if (attempt < targets.length - 1) {
					log(
						`${colors.yellow("↳")} upstream connection failed for ${dim(displayTarget(target))}; trying ${dim(displayTarget(targets[attempt + 1]))} ${dim(requestId)}`,
					);
					req.signal.removeEventListener("abort", abortUpstream);
					continue;
				}
				req.signal.removeEventListener("abort", abortUpstream);
				return anthropicError(502, "api_error", `Failed to reach upstream: ${msg}`);
			} finally {
				clearTimeout(timer);
			}
		}

		if (!upstreamRes) {
			req.signal.removeEventListener("abort", abortUpstream);
			return anthropicError(502, "api_error", "No upstream model was available.");
		}

		if (isStream) {
			const streamRelease = releaseSlot;
			const streamFinish = finishRequest;
			releaseSlot = undefined;
			finishRequest = undefined;
			return handleStream(
				upstreamRes,
				originalModel,
				startTime,
				requestId,
				controller,
				() => {
					req.signal.removeEventListener("abort", abortUpstream);
					streamRelease?.();
					streamFinish?.();
				},
				config.maxBodyBytes,
			);
		}
		try {
			return await handleSync(upstreamRes, originalModel, startTime, requestId);
		} finally {
			req.signal.removeEventListener("abort", abortUpstream);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg === "BODY_TOO_LARGE") {
			return anthropicError(
				413,
				"invalid_request_error",
				`Request body exceeds MAX_BODY_BYTES (${config.maxBodyBytes}).`,
			);
		}
		error(`Proxy error: ${msg}`);
		return anthropicError(500, "api_error", msg);
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
 */
export async function handleCountTokens(
	req: Request,
	config: Config,
): Promise<Response> {
	if (!isAuthorized(req, config.proxyApiKey)) {
		return anthropicError(401, "authentication_error", "Invalid proxy API key.");
	}
	const runtime = getRuntime(config);
	if (req.signal.aborted) {
		return anthropicError(499, "api_error", "Client disconnected.");
	}
	const releaseSlot = await runtime.limiter.acquire(req.signal);
	if (!releaseSlot) {
		if (req.signal.aborted) {
			return anthropicError(499, "api_error", "Client disconnected.");
		}
		return anthropicError(
			429,
			"rate_limit_error",
			"Proxy is busy; try again shortly.",
		);
	}
	try {
		let bodyText: string;
		try {
			bodyText = await readBodyLimited(req, config.maxBodyBytes);
		} catch (err) {
			if (err instanceof Error && err.message === "BODY_TOO_LARGE") {
				return anthropicError(
					413,
					"invalid_request_error",
					`Request body exceeds MAX_BODY_BYTES (${config.maxBodyBytes}).`,
				);
			}
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
		const inputTokens = Math.max(1, Math.ceil(bodyText.length / 4));
		return Response.json(
			{ input_tokens: inputTokens },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} finally {
		releaseSlot();
	}
}

async function handleSync(
	kiloRes: Response,
	model: string,
	startTime: number,
	requestId: string,
): Promise<Response> {
	const openaiResult = (await kiloRes.json()) as OpenAIChatResponse & {
		error?: { message?: unknown };
	};
	debug("OpenAI response", openaiResult);

	// Some gateways answer HTTP 200 with an error object in the body. Without
	// this check the proxy would forward a fabricated empty completion.
	const upstreamErr = openaiResult.error;
	if (upstreamErr) {
		const errMsg = extractErrorMessage(upstreamErr, "Upstream returned an error");
		error(`Upstream error: ${errMsg.slice(0, 200)}`);
		return anthropicError(
			502,
			"api_error",
			`Upstream error: ${truncate(errMsg, 2000)}`,
		);
	}

	const anthropicResult = translateResponse(openaiResult, model);
	const elapsed = (performance.now() - startTime).toFixed(0);

	log(
		`${green("←")}   sync ${dim(model)} ` +
			`stop=${anthropicResult.stop_reason} ` +
			`in=${anthropicResult.usage.input_tokens} out=${anthropicResult.usage.output_tokens} ` +
			`${dim(elapsed + "ms")} ${dim(requestId)}`,
	);

	return Response.json(anthropicResult, {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"x-request-id": requestId,
		},
	});
}

function handleStream(
	kiloRes: Response,
	model: string,
	startTime: number,
	requestId: string,
	upstreamController: AbortController,
	cleanup: () => void,
	maxBodyBytes = 20 * 1024 * 1024,
): Response {
	const translator = new StreamTranslator(model);
	const encoder = new TextEncoder();

	// Web standard plus Bun's extra methods (readMany etc.).
	// We only use read() and cancel(), so a narrow interface avoids coupling to Bun's augmented type.
	interface StreamReader {
		read(): Promise<{ done: boolean; value: Uint8Array }>;
		cancel(reason?: unknown): Promise<void>;
	}
	let reader: StreamReader | undefined;
	let cleaned = false;
	const onceCleanup = () => {
		if (cleaned) return;
		cleaned = true;
		cleanup();
	};
	let canceled = false;

	const safeEnqueue = (
		controller: ReadableStreamDefaultController,
		data: Uint8Array,
	) => {
		if (canceled) return;
		try {
			controller.enqueue(data);
		} catch (e) {
			canceled = true;
		}
	};

	const safeClose = (controller: ReadableStreamDefaultController) => {
		if (canceled) return;
		canceled = true;
		try {
			controller.close();
		} catch (e) {
			// ignore
		}
	};

	const readable = new ReadableStream({
		async start(controller) {
			reader = kiloRes.body?.getReader();
			if (!reader) {
				for (const ev of translator.finalize("stop")) {
					safeEnqueue(controller, encoder.encode(ev));
				}
				safeClose(controller);
				onceCleanup();
				return;
			}

			const decoder = new TextDecoder();
			let buffer = "";

			try {
				while (!canceled) {
					const { done, value } = await reader.read();
					if (done || canceled) break;

					buffer += decoder.decode(value, { stream: true });
					if (buffer.length > maxBodyBytes) {
						throw new Error(`SSE stream chunk buffer exceeded maximum size of ${maxBodyBytes} bytes`);
					}
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (canceled) break;
						const trimmed = line.trim();
						if (!trimmed || trimmed.startsWith(":")) continue;

						if (trimmed.startsWith("data:")) {
							const data = trimmed.startsWith("data: ")
								? trimmed.slice(6)
								: trimmed.slice(5).trimStart();
							const events = translator.processChunk(data);
							for (const ev of events) {
								safeEnqueue(controller, encoder.encode(ev));
							}
						}
					}
				}

				if (!canceled && buffer.trim().startsWith("data:")) {
					const trimmed = buffer.trim();
					const data = trimmed.startsWith("data: ")
						? trimmed.slice(6)
						: trimmed.slice(5).trimStart();
					for (const ev of translator.processChunk(data)) {
						safeEnqueue(controller, encoder.encode(ev));
					}
				}

				// Always close Anthropic stream cleanly
				if (!canceled) {
					for (const ev of translator.finalize("stop")) {
						safeEnqueue(controller, encoder.encode(ev));
					}
				}

				const elapsed = (performance.now() - startTime).toFixed(0);
				log(
					`${green("←")} stream ${dim(model)} complete ${dim(elapsed + "ms")} ${dim(requestId)}`,
				);
				safeClose(controller);
			} catch (err) {
				if (canceled) return;
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes("Controller is already closed")) {
					error(`Stream error: ${msg}`);
				}
				safeEnqueue(
					controller,
					encoder.encode(anthropicErrorSse("api_error", msg)),
				);
				safeClose(controller);
			} finally {
				onceCleanup();
			}
		},
		async cancel() {
			canceled = true;
			upstreamController.abort("Client stopped reading stream");
			onceCleanup();
		},
	});

	return new Response(readable, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"x-request-id": requestId,
			"X-Accel-Buffering": "no",
		},
	});
}

/** When PROXY_API_KEY is unset the local proxy retains its existing behaviour. */
export function isAuthorized(req: Request, expectedKey: string): boolean {
	if (!expectedKey) return true;
	const supplied = req.headers.get("x-proxy-api-key") || extractApiKey(req);
	if (!supplied) return false;
	const suppliedHash = createHash("sha256").update(supplied, "utf8").digest();
	const expectedHash = createHash("sha256").update(expectedKey, "utf8").digest();
	return timingSafeEqual(suppliedHash, expectedHash);
}

export function canFallback(
	status: number,
	attempt: number,
	totalAttempts: number,
): boolean {
	return (
		attempt < totalAttempts - 1 &&
		// 404 = model retired/renamed (common as free pools rotate); try the
		// next candidate instead of failing the whole request.
		(status === 404 || status === 408 || status === 429 || status >= 500)
	);
}

export function resolveTarget(
	requestedModel: string,
	body: AnthropicMessagesRequest,
	config: Config,
): UpstreamTarget {
	const explicit = parseTarget(requestedModel);
	if (
		explicit.provider === "opencode" ||
		!config.smartRouting ||
		!requestedModel.toLowerCase().startsWith("claude-")
	) {
		return explicit;
	}
	const requested = requestedModel.toLowerCase();
	const hasImage = body.messages?.some(
		(message) =>
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "image"),
	);
	if (hasImage) return parseTarget("kilo/stepfun/step-3.7-flash:free");
	const alias = config.modelAliases.find(({ pattern }) =>
		globMatches(pattern, requested),
	);
	return alias ? parseTarget(alias.model) : explicit;
}

export function buildCandidateTargets(
	first: UpstreamTarget,
	body: AnthropicMessagesRequest,
	config: Config,
	requestApiKey = "",
): UpstreamTarget[] {
	const needsTools = Boolean(body.tools?.length);
	const needsVision =
		body.messages?.some(
			(message) =>
				Array.isArray(message.content) &&
				message.content.some((block) => block.type === "image"),
		) ?? false;
	const targets = [
		first,
		...config.fallbackModels.map((model) => parseTarget(model)),
	];
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
						(!needsTools || capabilities.tools) &&
						(!needsVision || capabilities.vision)
					);
				})
				.map((target) => [displayTarget(target), target]),
		).values(),
	];
}

export function isTargetAllowed(
	target: UpstreamTarget,
	config: Config,
): boolean {
	const id = displayTarget(target);
	const explicitlyAllowed = config.allowedModels.includes(id);
	// FREE_MODELS_ONLY rejects paid models unless the operator has explicitly
	// allowlisted them (ALLOWED_MODELS is an explicit approval list).
	if (config.freeModelsOnly && !isFreeTarget(target) && !explicitlyAllowed)
		return false;
	return !config.allowedModels.length || explicitlyAllowed;
}

export function globMatches(pattern: string, value: string): boolean {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\?]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}

async function readBodyLimited(
	req: Request,
	maxBytes: number,
): Promise<string> {
	const cl = req.headers.get("content-length");
	if (cl && Number(cl) > maxBytes) {
		throw new Error("BODY_TOO_LARGE");
	}

	const reader = req.body?.getReader();
	if (!reader) return "";

	const chunks: Uint8Array[] = [];
	let total = 0;
	const decoder = new TextDecoder();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			try {
				reader.cancel();
			} catch {
				/* ignore */
			}
			throw new Error("BODY_TOO_LARGE");
		}
		chunks.push(value);
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		merged.set(c, offset);
		offset += c.byteLength;
	}
	return decoder.decode(merged);
}
