import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { handleCountTokens, handleMessages } from "../src/handlers/messages";
import { resetRuntimeForTests } from "../src/runtime";
import { createServer } from "../src/server";
import {
	collectStream,
	jsonResponse,
	messagesRequest,
	simpleBody,
	sseResponse,
	stallingSseResponse,
	testConfig,
	textResponse,
} from "./fixtures";

let originalFetch: typeof fetch;

beforeEach(() => {
	resetRuntimeForTests();
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** Point upstream fetch at a stub and return a call counter. */
function stubUpstream(impl: (call: number) => Response | Promise<Response>) {
	let calls = 0;
	globalThis.fetch = mock(async () => impl(++calls)) as unknown as typeof fetch;
	return () => calls;
}

/** Capture the JSON body of each upstream call, in order. */
function captureBodies(): string[] {
	const bodies: string[] = [];
	const inner = globalThis.fetch;
	globalThis.fetch = mock(async (url: any, init: any) => {
		bodies.push(init.body);
		return inner(url, init);
	}) as unknown as typeof fetch;
	return bodies;
}

const okBody = (text: string, id = "chatcmpl-1") =>
	jsonResponse({
		id,
		choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 5, completion_tokens: 2 },
	});

// ── Non-streaming ────────────────────────────────────────────────────────────

describe("handleMessages — sync", () => {
	test("translates a sync request into an Anthropic-shaped response", async () => {
		stubUpstream(() => okBody("Hello"));
		const res = await handleMessages(messagesRequest(simpleBody()), testConfig());
		expect(res.status).toBe(200);
		const json = (await res.json()) as Record<string, any>;
		expect(json.type).toBe("message");
		expect(json.content[0]).toEqual({ type: "text", text: "Hello" });
		expect(json.stop_reason).toBe("end_turn");
		expect(json.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
	});

	test("surfaces a 200-with-error-body as 502 instead of an empty completion", async () => {
		stubUpstream(() => jsonResponse({ error: { message: "model overloaded" } }, 200));
		const res = await handleMessages(messagesRequest(simpleBody()), testConfig());
		expect(res.status).toBe(502);
		const json = (await res.json()) as { error: { type: string; message: string } };
		expect(json.error.type).toBe("api_error");
		expect(json.error.message).toContain("model overloaded");
	});

	test("echoes a safe inbound x-request-id so client and proxy logs line up", async () => {
		stubUpstream(() => okBody("ok"));
		const res = await handleMessages(
			messagesRequest(simpleBody(), { "x-request-id": "client-abc.123" }),
			testConfig(),
		);
		expect(res.headers.get("x-request-id")).toBe("client-abc.123");
	});

	test("mints its own id when the inbound one is unusable", async () => {
		stubUpstream(() => okBody("ok"));
		for (const bad of ["", "has space", "a".repeat(200), "<script>"]) {
			const res = await handleMessages(
				messagesRequest(simpleBody(), { "x-request-id": bad }),
				testConfig(),
			);
			// A hostile value must never be reflected verbatim.
			expect(res.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{16}$/);
		}
	});

	test("clamps max_tokens to the documented ceiling", async () => {
		stubUpstream(() => okBody("ok"));
		const bodies = captureBodies();
		await handleMessages(
			messagesRequest(simpleBody({ max_tokens: 64_000 })),
			testConfig(),
		);
		expect(JSON.parse(bodies[0]).max_tokens).toBe(16384);
	});

	test("leaves max_tokens alone when it is already under the ceiling", async () => {
		stubUpstream(() => okBody("ok"));
		const bodies = captureBodies();
		await handleMessages(messagesRequest(simpleBody({ max_tokens: 512 })), testConfig());
		expect(JSON.parse(bodies[0]).max_tokens).toBe(512);
	});
});

// ── Body deadline (P0) ───────────────────────────────────────────────────────

describe("handleMessages — sync body deadline", () => {
	test("a stalled sync body times out and does not pin the slot", async () => {
		// Regression: `fetch` resolves on headers, so the header-level timeout was
		// already cleared when the body was read. A non-streaming upstream that
		// stalled mid-body held its concurrency slot forever, and four of those
		// wedged the whole proxy with no way to recover.
		const cfg = testConfig({
			upstreamTimeoutMs: 120,
			maxConcurrentRequests: 1,
			maxQueuedRequests: 0,
			fallbackModels: [],
		});

		// Headers immediately, body never.
		globalThis.fetch = mock(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start() {
							/* never enqueue, never close */
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const started = performance.now();
		const res = await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(performance.now() - started).toBeLessThan(3000);
		expect(res.status).toBe(504);

		// The slot must be back: a fresh request succeeds instead of 429.
		stubUpstream(() => okBody("recovered", "chatcmpl-after"));
		const after = await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(after.status).toBe(200);
	});

	test("a stalled sync body marks the model as cooling down", async () => {
		const cfg = testConfig({ upstreamTimeoutMs: 80, fallbackModels: [] });
		globalThis.fetch = mock(
			async () =>
				new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
		) as unknown as typeof fetch;
		const res = await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(res.status).toBe(504);
		// The next request should not pick the same dead model first.
		const calls = stubUpstream(() => okBody("second"));
		await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(calls()).toBeGreaterThan(0);
	});

	test("a sync response that arrives in time is unaffected", async () => {
		const cfg = testConfig({ upstreamTimeoutMs: 5000 });
		stubUpstream(() => okBody("fast enough"));
		const res = await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(res.status).toBe(200);
	});
});

// ── Fallback and cooldown ────────────────────────────────────────────────────

describe("handleMessages — fallback", () => {
	test("falls back to the next candidate after a 429", async () => {
		const calls = stubUpstream((call) =>
			call === 1
				? textResponse("rate limited", 429)
				: okBody("fallback ok", "chatcmpl-2"),
		);
		const res = await handleMessages(messagesRequest(simpleBody()), testConfig());
		expect(res.status).toBe(200);
		expect(calls()).toBe(2);
		expect(((await res.json()) as any).content[0].text).toBe("fallback ok");
	});

	test("passes the upstream Retry-After through to the client", async () => {
		const cfg = testConfig({ fallbackModels: [] });
		stubUpstream(() => textResponse("slow down", 429, { "retry-after": "42" }));
		const res = await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("42");
	});

	test("retries across providers, applying the right key to each", async () => {
		// Kilo fails, so the chain falls through to the allowlisted Qwen model.
		// Each provider must receive its own credential, never the other's.
		const cfg = testConfig({
			defaultModel: "kilo/stealth/space-bunny-alpha",
			fallbackModels: ["qwen/qwen3-max"],
			allowedModels: ["kilo/stealth/space-bunny-alpha", "qwen/qwen3-max"],
		});
		const auths: string[] = [];
		let call = 0;
		globalThis.fetch = mock(async (_url: any, init: any) => {
			auths.push(init.headers.Authorization);
			return ++call === 1 ? textResponse("nope", 500) : okBody("via qwen");
		}) as unknown as typeof fetch;

		const res = await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(res.status).toBe(200);
		expect(auths[0]).toBe("Bearer kilo-key");
		expect(auths[1]).toBe("Bearer qwen-key");
	});

	test("a model in cooldown is skipped on the next request", async () => {
		const cfg = testConfig({ fallbackModels: ["kilo/poolside/laguna-s-2.1:free"] });
		// The primary 404s (retired) and the fallback answers, so only the
		// primary is left cooling afterwards.
		const first = stubUpstream((call) =>
			call === 1 ? textResponse("gone", 404) : okBody("via fallback", "chatcmpl-2"),
		);
		const ok = await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(ok.status).toBe(200);
		expect(first()).toBe(2);

		// Next request: the primary is cooling, so the fallback leads instead of
		// paying for a guaranteed-failing call first.
		const models: string[] = [];
		globalThis.fetch = mock(async (_url: any, init: any) => {
			models.push(JSON.parse(init.body).model);
			return okBody("x");
		}) as unknown as typeof fetch;
		await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(models).toEqual(["poolside/laguna-s-2.1:free"]);
	});

	test("when every candidate is cooling they are all retried anyway", async () => {
		// Deliberate fail-open: refusing the request because every model happens
		// to be in cooldown would be worse than trying one that may have
		// recovered, since the cooldown may not have been earned recently.
		const cfg = testConfig({ fallbackModels: ["kilo/poolside/laguna-s-2.1:free"] });
		stubUpstream((call) =>
			call === 1 ? textResponse("gone", 404) : okBody("ok", "chatcmpl-2"),
		);
		await handleMessages(messagesRequest(simpleBody()), cfg);

		// Now cool *both* models, then confirm the next request still tries.
		const { getRuntime } = await import("../src/runtime");
		const { cooldowns } = getRuntime(cfg);
		cooldowns.fail("kilo/stealth/space-bunny-alpha");
		cooldowns.fail("kilo/poolside/laguna-s-2.1:free");
		expect(cooldowns.isCooling("kilo/stealth/space-bunny-alpha")).toBe(true);

		const models: string[] = [];
		globalThis.fetch = mock(async (_url: any, init: any) => {
			models.push(JSON.parse(init.body).model);
			return okBody("x");
		}) as unknown as typeof fetch;
		const res = await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(res.status).toBe(200);
		expect(models[0]).toBe("stealth/space-bunny-alpha");
	});

	test("a 400 is returned to the client without burning the fallback chain", async () => {
		const calls = stubUpstream(() => textResponse("bad request", 400));
		const res = await handleMessages(messagesRequest(simpleBody()), testConfig());
		expect(res.status).toBe(400);
		expect(calls()).toBe(1);
	});
});

// ── Streaming ────────────────────────────────────────────────────────────────

describe("handleMessages — streaming", () => {
	test("streams Anthropic SSE for a successful upstream stream", async () => {
		stubUpstream(() =>
			sseResponse([
				'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const res = await handleMessages(
			messagesRequest(simpleBody({ stream: true })),
			testConfig(),
		);
		expect(res.status).toBe(200);
		const out = await collectStream(res);
		expect(out).toContain("message_start");
		expect(out).toContain("text_delta");
		expect(out).toContain("Hi");
		expect(out).toContain("message_stop");
		expect(out).toContain("end_turn");
	});

	test("emits an SSE error when the upstream stream carries an error object", async () => {
		stubUpstream(() => sseResponse(['data: {"error":{"message":"stream boom"}}\n\n']));
		const res = await handleMessages(
			messagesRequest(simpleBody({ stream: true })),
			testConfig(),
		);
		const out = await collectStream(res);
		expect(out).toContain("event: error");
		expect(out).toContain("stream boom");
	});

	test("a streamed tool-calling turn reports stop_reason tool_use", async () => {
		// Regression: the handler used to finalize with a hardcoded "stop",
		// discarding the upstream's finish_reason. Every streamed turn came back
		// end_turn, so Claude Code never dispatched the tool.
		stubUpstream(() =>
			sseResponse([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]},"index":0}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Paris\\"}"}}]},"index":0}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}],"usage":{"prompt_tokens":9,"completion_tokens":7}}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const res = await handleMessages(
			messagesRequest(
				simpleBody({
					stream: true,
					tools: [
						{ name: "get_weather", input_schema: { type: "object", properties: {} } },
					],
				}),
			),
			testConfig(),
		);
		const out = await collectStream(res);
		expect(out).toContain('"type":"tool_use"');
		expect(out).toContain('"name":"get_weather"');
		expect(out).toContain('"stop_reason":"tool_use"');
		expect(out).not.toContain('"stop_reason":"end_turn"');
		expect(out).toContain('"output_tokens":7');
	});

	test("no event is emitted after message_stop", async () => {
		// A gateway that sends a trailing chunk after [DONE] used to open a new
		// content block *after* message_stop, which is a protocol violation.
		stubUpstream(() =>
			sseResponse([
				'data: {"choices":[{"delta":{"content":"real"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				"data: [DONE]\n\n",
				'data: {"choices":[{"delta":{"content":"GHOST"}}]}\n\n',
			]),
		);
		const res = await handleMessages(
			messagesRequest(simpleBody({ stream: true })),
			testConfig(),
		);
		const out = await collectStream(res);
		expect(out).toContain("real");
		expect(out).not.toContain("GHOST");
		// message_stop must appear exactly once, at the very end of the stream.
		expect(out.split("message_stop").length - 1).toBe(2); // once in `event:`, once in `data:`
		expect(out.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
	});
});

// ── Streaming stall ──────────────────────────────────────────────────────────

describe("handleMessages — stream idle deadline", () => {
	test("a stalled upstream stream is aborted and releases its slot", async () => {
		// Regression: the header-level timeout is cleared once fetch resolves, so
		// nothing bounded the body. A stalled stream pinned its slot forever.
		const cfg = testConfig({
			upstreamTimeoutMs: 150,
			maxConcurrentRequests: 1,
			maxQueuedRequests: 0,
			fallbackModels: [],
		});
		const stalling = stallingSseResponse();
		globalThis.fetch = mock(async () => stalling.response) as unknown as typeof fetch;

		const stalled = await handleMessages(
			messagesRequest(simpleBody({ stream: true })),
			cfg,
		);
		expect(stalled.status).toBe(200);

		const out = await Promise.race([collectStream(stalled), Bun.sleep(3000)]);
		stalling.release();
		expect(out).toContain("event: error");
		expect(out).toContain("stalled");

		stubUpstream(() => okBody("recovered", "chatcmpl-after"));
		const after = await handleMessages(messagesRequest(simpleBody()), cfg);
		expect(after.status).toBe(200);
	});
});

// ── count_tokens ─────────────────────────────────────────────────────────────

describe("count_tokens", () => {
	test("does not consume upstream capacity", async () => {
		// Regression: count_tokens shared the limiter, so a busy proxy answered
		// Claude Code's own context accounting with 429.
		const cfg = testConfig({
			maxConcurrentRequests: 1,
			maxQueuedRequests: 0,
			fallbackModels: [],
		});
		let stalling!: ReturnType<typeof stallingSseResponse>;
		globalThis.fetch = mock(async () => {
			stalling = stallingSseResponse("x");
			return stalling.response;
		}) as unknown as typeof fetch;

		const inflight = await handleMessages(
			messagesRequest(simpleBody({ stream: true })),
			cfg,
		);
		expect(inflight.status).toBe(200);

		const counted = await handleCountTokens(
			messagesRequest(
				{ messages: [{ role: "user", content: "hello world" }] },
				{},
				"http://127.0.0.1:4181/v1/messages/count_tokens",
			),
			cfg,
		);
		expect(counted.status).toBe(200);
		expect(
			((await counted.json()) as { input_tokens: number }).input_tokens,
		).toBeGreaterThan(0);

		await inflight.body?.cancel().catch(() => {});
		stalling.release();
	});

	test("never returns a zero-token estimate", async () => {
		// Claude Code divides by this figure, so 0 would be a divide-by-zero.
		const counted = await handleCountTokens(
			messagesRequest({}, {}, "http://127.0.0.1:4181/v1/messages/count_tokens"),
			testConfig(),
		);
		expect(((await counted.json()) as { input_tokens: number }).input_tokens).toBe(1);
	});

	test("rejects an oversized body and invalid JSON", async () => {
		const tooBig = await handleCountTokens(
			messagesRequest(
				{ messages: [] },
				{},
				"http://127.0.0.1:4181/v1/messages/count_tokens",
			),
			testConfig({ maxBodyBytes: 4 }),
		);
		expect(tooBig.status).toBe(413);

		const bad = await handleCountTokens(
			new Request("http://127.0.0.1:4181/v1/messages/count_tokens", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{not json",
			}),
			testConfig(),
		);
		expect(bad.status).toBe(400);
	});

	test("requires the proxy key when one is configured", async () => {
		const res = await handleCountTokens(
			messagesRequest({}, {}, "http://127.0.0.1:4181/v1/messages/count_tokens"),
			testConfig({ proxyApiKey: "s3cret" }),
		);
		expect(res.status).toBe(401);
	});
});

// ── Request validation ───────────────────────────────────────────────────────

describe("handleMessages — validation", () => {
	test("rejects a non-JSON body with 400", async () => {
		const res = await handleMessages(
			new Request("http://127.0.0.1:4181/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{not json",
			}),
			testConfig(),
		);
		expect(res.status).toBe(400);
	});

	test("rejects a JSON array or scalar body", async () => {
		for (const body of ["[]", '"a string"', "42", "null"]) {
			const res = await handleMessages(
				new Request("http://127.0.0.1:4181/v1/messages", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				}),
				testConfig(),
			);
			expect(res.status).toBe(400);
		}
	});

	test("rejects a non-array messages field", async () => {
		const res = await handleMessages(messagesRequest({ messages: "nope" }), testConfig());
		expect(res.status).toBe(400);
	});

	test("rejects a non-string model field", async () => {
		const res = await handleMessages(messagesRequest({ model: 7 }), testConfig());
		expect(res.status).toBe(400);
	});

	test("rejects a model outside the allowlist before touching the upstream", async () => {
		const calls = stubUpstream(() => okBody("should not happen"));
		const res = await handleMessages(
			messagesRequest(simpleBody({ model: "kilo/some-paid-model" })),
			testConfig(),
		);
		expect(res.status).toBe(400);
		expect(calls()).toBe(0);
	});

	test("requires the proxy key when one is configured", async () => {
		const res = await handleMessages(
			messagesRequest(simpleBody()),
			testConfig({ proxyApiKey: "s3cret" }),
		);
		expect(res.status).toBe(401);
	});

	test("does not forward the proxy key upstream as a provider key", async () => {
		let auth = "";
		globalThis.fetch = mock(async (_url: any, init: any) => {
			auth = init.headers.Authorization;
			return okBody("ok");
		}) as unknown as typeof fetch;
		await handleMessages(
			messagesRequest(simpleBody(), { "x-proxy-api-key": "s3cret" }),
			testConfig({ proxyApiKey: "s3cret", kiloApiKey: "kilo-key" }),
		);
		expect(auth).toBe("Bearer kilo-key");
	});

	test("uses the client-supplied key only when no proxy key is configured", async () => {
		let auth = "";
		globalThis.fetch = mock(async (_url: any, init: any) => {
			auth = init.headers.Authorization;
			return okBody("ok");
		}) as unknown as typeof fetch;
		await handleMessages(
			messagesRequest(simpleBody(), { "x-api-key": "client-key" }),
			testConfig({ kiloApiKey: "" }),
		);
		expect(auth).toBe("Bearer client-key");
	});

	test("a request-supplied key is not replayed to a different provider", async () => {
		// The fallback chain crosses providers; the client key authenticates only
		// the one it addressed, so a fallback to Qwen must use the configured
		// Qwen credential (or none) rather than the client's Kilo token.
		const cfg = testConfig({
			kiloApiKey: "",
			qwenApiKey: "qwen-key",
			defaultModel: "kilo/stealth/space-bunny-alpha",
			fallbackModels: ["qwen/qwen3-max"],
			allowedModels: ["kilo/stealth/space-bunny-alpha", "qwen/qwen3-max"],
		});
		const auths: string[] = [];
		let call = 0;
		globalThis.fetch = mock(async (_url: any, init: any) => {
			auths.push(init.headers.Authorization);
			return ++call === 1 ? textResponse("kilo down", 500) : okBody("via qwen");
		}) as unknown as typeof fetch;

		const res = await handleMessages(
			messagesRequest(simpleBody(), { "x-api-key": "client-key" }),
			cfg,
		);
		expect(res.status).toBe(200);
		expect(auths[0]).toBe("Bearer client-key");
		expect(auths[1]).toBe("Bearer qwen-key");
	});

	test("the client-abort listener is detached once the response is done", async () => {
		// Regression: the handler removed a *different* closure than the one the
		// upstream call registered, so the listener survived the request and
		// accumulated on every call.
		const controller = new AbortController();
		let added = 0;
		let removed = 0;
		const signal = controller.signal;
		const originalAdd = signal.addEventListener.bind(signal);
		const originalRemove = signal.removeEventListener.bind(signal);
		signal.addEventListener = ((...args: any[]) => {
			added++;
			return originalAdd(...(args as [string, EventListener]));
		}) as typeof signal.addEventListener;
		signal.removeEventListener = ((...args: any[]) => {
			removed++;
			return originalRemove(...(args as [string, EventListener]));
		}) as typeof signal.removeEventListener;

		stubUpstream(() => okBody("ok"));
		const req = messagesRequest(simpleBody());
		Object.defineProperty(req, "signal", { value: signal });
		await handleMessages(req, testConfig());

		expect(added).toBeGreaterThan(0);
		expect(removed).toBe(added);
	});
});

// ── Routing / security ───────────────────────────────────────────────────────

describe("createServer — routing", () => {
	test("404 for an unknown route", async () => {
		const server = createServer(testConfig());
		const res = await server.fetch(new Request("http://127.0.0.1:4181/nope"));
		server.stop(true);
		expect(res.status).toBe(404);
		expect(((await res.json()) as any).error.type).toBe("not_found_error");
	});

	test("405 with Allow for a known path under the wrong verb", async () => {
		const server = createServer(testConfig());
		const res = await server.fetch(
			new Request("http://127.0.0.1:4181/health", { method: "POST" }),
		);
		server.stop(true);
		expect(res.status).toBe(405);
		expect(res.headers.get("allow")).toBe("GET");
	});

	test("a trailing slash routes the same as the bare path", async () => {
		const server = createServer(testConfig());
		const res = await server.fetch(new Request("http://127.0.0.1:4181/health/"));
		server.stop(true);
		expect(res.status).toBe(200);
	});

	test("health is reachable from loopback with no proxy key", async () => {
		const server = createServer(testConfig());
		const res = await server.fetch(new Request("http://127.0.0.1:4181/health"));
		server.stop(true);
		expect(res.status).toBe(200);
		expect(((await res.json()) as any).status).toBe("ok");
	});

	test("every operational endpoint requires the key when one is configured", async () => {
		// Regression: /health echoed the upstream gateway URL and version with no
		// auth at all, so it leaked on any non-localhost bind.
		const server = createServer(testConfig({ proxyApiKey: "s3cret" }));
		const paths = [
			"/",
			"/health",
			"/healthz",
			"/version",
			"/v1/models",
			"/metrics",
			"/dashboard",
			"/dashboard.json",
		];
		for (const path of paths) {
			const anon = await server.fetch(new Request(`http://127.0.0.1:4181${path}`));
			expect(anon.status).toBe(401);
			const authed = await server.fetch(
				new Request(`http://127.0.0.1:4181${path}`, {
					headers: { "x-proxy-api-key": "s3cret" },
				}),
			);
			expect(authed.status).toBe(200);
		}
		server.stop(true);
	});

	test("/v1/models reports a stable created timestamp", async () => {
		const server = createServer(testConfig());
		type ModelsPayload = { data: Array<{ id: string; created: number }> };
		const first = (await (
			await server.fetch(new Request("http://127.0.0.1:4181/v1/models"))
		).json()) as ModelsPayload;
		const second = (await (
			await server.fetch(new Request("http://127.0.0.1:4181/v1/models"))
		).json()) as ModelsPayload;
		server.stop(true);
		expect(first.data.length).toBeGreaterThan(0);
		expect(first.data[0].created).toBe(second.data[0].created);
	});

	test("/metrics is Prometheus text and never reflects a metric as markup", async () => {
		const server = createServer(testConfig());
		const res = await server.fetch(new Request("http://127.0.0.1:4181/metrics"));
		const body = await res.text();
		server.stop(true);
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(body.endsWith("\n")).toBe(true);
	});

	test("the dashboard never injects metric values into markup", async () => {
		const server = createServer(testConfig());
		const res = await server.fetch(new Request("http://127.0.0.1:4181/dashboard"));
		const html = await res.text();
		server.stop(true);
		expect(html).toContain("textContent");
		// innerHTML on interpolated data is the pattern being avoided.
		expect(html).not.toContain("innerHTML");
	});

	test("CORS preflight advertises x-proxy-api-key and x-request-id", async () => {
		const server = createServer(
			testConfig({ corsAllowedOrigins: ["http://localhost:3000"] }),
		);
		const res = await server.fetch(
			new Request("http://127.0.0.1:4181/v1/messages", {
				method: "OPTIONS",
				headers: { origin: "http://localhost:3000" },
			}),
		);
		server.stop(true);
		expect(res.status).toBe(204);
		const allow = res.headers.get("access-control-allow-headers") ?? "";
		expect(allow).toContain("x-proxy-api-key");
		expect(allow).toContain("x-request-id");
	});

	test("an unlisted origin is not reflected", async () => {
		const server = createServer(
			testConfig({ corsAllowedOrigins: ["http://localhost:3000"] }),
		);
		const res = await server.fetch(
			new Request("http://127.0.0.1:4181/health", {
				headers: { origin: "https://evil.example" },
			}),
		);
		server.stop(true);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});
