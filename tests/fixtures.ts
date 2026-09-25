// ============================================================================
// tests/fixtures.ts — shared test configuration and request builders
// ============================================================================

import type { Config } from "../src/config";

/** A representative config: one primary, three fallbacks, all free Kilo models. */
export function testConfig(overrides: Partial<Config> = {}): Config {
	return {
		host: "127.0.0.1",
		port: 0,
		kiloApiKey: "kilo-key",
		qwenApiKey: "qwen-key",
		qwenBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		proxyApiKey: "",
		kiloBaseUrl: "https://api.kilo.ai/api/gateway",
		modelPrefix: "",
		defaultModel: "kilo/stealth/space-bunny-alpha",
		fallbackModels: [
			"kilo/poolside/laguna-s-2.1:free",
			"kilo/cohere/north-mini-code:free",
			"kilo/stepfun/step-3.7-flash:free",
		],
		allowedModels: [
			"kilo/stealth/space-bunny-alpha",
			"kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
			"kilo/poolside/laguna-s-2.1:free",
			"kilo/cohere/north-mini-code:free",
			"kilo/stepfun/step-3.7-flash:free",
		],
		freeModelsOnly: true,
		visionModel: "kilo/stealth/space-bunny-alpha",
		modelAliases: [
			{ pattern: "*haiku*", model: "kilo/stealth/space-bunny-alpha" },
			{ pattern: "*sonnet*", model: "kilo/poolside/laguna-s-2.1:free" },
			{ pattern: "*opus*", model: "kilo/cohere/north-mini-code:free" },
		],
		reasoningEffort: "",
		smartRouting: true,
		maxConcurrentRequests: 4,
		maxQueuedRequests: 20,
		modelCooldownMs: 30_000,
		debug: false,
		upstreamTimeoutMs: 120_000,
		upstreamTlsRejectUnauthorized: true,
		upstreamCaFile: "",
		maxBodyBytes: 20 * 1024 * 1024,
		corsAllowedOrigins: [],
		...overrides,
	};
}

export function messagesRequest(
	body: unknown,
	headers: Record<string, string> = {},
	url = "http://127.0.0.1:4181/v1/messages",
): Request {
	return new Request(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

/** A minimal well-formed /v1/messages body. */
export function simpleBody(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		model: "kilo/stealth/space-bunny-alpha",
		max_tokens: 100,
		messages: [{ role: "user", content: "hi" }],
		...overrides,
	};
}

export function jsonResponse(obj: unknown, status = 200): Response {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export function textResponse(
	body: string,
	status: number,
	headers?: Record<string, string>,
): Response {
	return new Response(body, { status, headers });
}

/** Build a streaming response that emits the given chunks, then closes. */
export function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * A streaming response that emits one chunk and then goes silent forever —
 * headers arrive, the body never finishes. This is the shape that used to pin
 * a concurrency slot permanently.
 */
export function stallingSseResponse(first = "hi"): {
	response: Response;
	release: () => void;
} {
	let release!: () => void;
	const stalled = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(
					`data: {"choices":[{"delta":{"content":"${first}"}}]}\n\n`,
				),
			);
			void stalled;
		},
	});
	return {
		response: new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
		release,
	};
}

export async function collectStream(res: Response): Promise<string> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let acc = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		acc += decoder.decode(value, { stream: true });
	}
	return acc;
}
