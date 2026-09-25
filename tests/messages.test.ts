import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import {
	buildCandidateTargets,
	canFallback,
	globMatches,
	isAuthorized,
	isTargetAllowed,
	resolveTarget,
} from "../src/handlers/messages";
import type { AnthropicMessagesRequest } from "../src/types";
import { qualifyModel, getCapabilities, isFreeTarget } from "../src/providers";
import {
	RequestLimiter,
	prometheusMetrics,
	recordModelRequest,
} from "../src/runtime";

// ── Fixtures ────────────────────────────────────────────────────────────────

const defaultConfig: Config = {
	host: "127.0.0.1",
	port: 4181,
	kiloApiKey: "kilo-key",
	qwenApiKey: "qwen-key",
	qwenBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
	proxyApiKey: "",
	kiloBaseUrl: "https://api.kilo.ai/api/gateway",
	modelPrefix: "",
	defaultModel: "claude-sonnet-4-20250514",
	fallbackModels: [
		"kilo/poolside/laguna-s-2.1:free",
		"kilo/cohere/north-mini-code:free",
		"kilo/stepfun/step-3.7-flash:free",
		"kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
	],
	allowedModels: [
		"kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
		"kilo/poolside/laguna-s-2.1:free",
		"kilo/cohere/north-mini-code:free",
		"kilo/stepfun/step-3.7-flash:free",
		"kilo/stealth/space-bunny-alpha",
	],
	freeModelsOnly: true,
	visionModel: "kilo/stepfun/step-3.7-flash:free",
	modelAliases: [
		{ pattern: "*haiku*", model: "kilo/stepfun/step-3.7-flash:free" },
		{ pattern: "*sonnet*", model: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free" },
		{ pattern: "*opus*", model: "kilo/poolside/laguna-s-2.1:free" },
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
};

function request(options?: Partial<Config>): Config {
	return { ...defaultConfig, ...options };
}

// ── isAuthorized ────────────────────────────────────────────────────────────

describe("isAuthorized", () => {
	test("no expected key → grants access", () => {
		const req = new Request("http://localhost");
		expect(isAuthorized(req, "")).toBe(true);
	});

	test("correct x-proxy-api-key → grants access", () => {
		const req = new Request("http://localhost", {
			headers: { "x-proxy-api-key": "secret-123" },
		});
		expect(isAuthorized(req, "secret-123")).toBe(true);
	});

	test("correct x-api-key → grants access", () => {
		const req = new Request("http://localhost", {
			headers: { "x-api-key": "secret-456" },
		});
		expect(isAuthorized(req, "secret-456")).toBe(true);
	});

	test("correct Bearer token → grants access", () => {
		const req = new Request("http://localhost", {
			headers: { authorization: "Bearer secret-789" },
		});
		expect(isAuthorized(req, "secret-789")).toBe(true);
	});

	test("wrong key → rejects", () => {
		const req = new Request("http://localhost", {
			headers: { "x-api-key": "wrong-key" },
		});
		expect(isAuthorized(req, "correct-key")).toBe(false);
	});

	test("wrong length key → rejects (fast path)", () => {
		const req = new Request("http://localhost", {
			headers: { "x-api-key": "short" },
		});
		expect(isAuthorized(req, "a-very-long-secret-key")).toBe(false);
	});

	test("timing-safe: close match with one differing char → rejects", () => {
		const req = new Request("http://localhost", {
			headers: { "x-api-key": "secret-abc" },
		});
		expect(isAuthorized(req, "secret-abd")).toBe(false);
	});
});

// ── canFallback ─────────────────────────────────────────────────────────────

describe("canFallback", () => {
	test("429 with remaining attempts → true", () => {
		expect(canFallback(429, 0, 2)).toBe(true);
	});

	test("503 with remaining attempts → true", () => {
		expect(canFallback(503, 0, 2)).toBe(true);
	});

	test("408 with remaining attempts → true", () => {
		expect(canFallback(408, 0, 2)).toBe(true);
	});

	test("404 with remaining attempts → true (retired model)", () => {
		expect(canFallback(404, 0, 2)).toBe(true);
	});

	test("400 with remaining attempts → false", () => {
		expect(canFallback(400, 0, 2)).toBe(false);
	});

	test("last attempt even with 429 → false", () => {
		expect(canFallback(429, 1, 1)).toBe(false);
	});

	test("5xx on final attempt → false", () => {
		expect(canFallback(502, 2, 2)).toBe(false);
	});

	test("single-target fallback list (no retry) → false", () => {
		expect(canFallback(429, 0, 1)).toBe(false);
	});
});

// ── globMatches ─────────────────────────────────────────────────────────────

describe("globMatches", () => {
	test("exact match", () => {
		expect(globMatches("claude-sonnet-4", "claude-sonnet-4")).toBe(true);
	});

	test("wildcard prefix pattern", () => {
		expect(globMatches("*sonnet*", "claude-sonnet-4-20250514")).toBe(true);
	});

	test("wildcard suffix pattern", () => {
		expect(globMatches("claude-*", "claude-sonnet-4")).toBe(true);
	});

	test("case-insensitive match", () => {
		expect(globMatches("*SONNET*", "claude-sonnet-4")).toBe(true);
	});

	test("no match returns false", () => {
		expect(globMatches("*haiku*", "claude-sonnet-4")).toBe(false);
	});

	test("special regex chars in pattern are escaped", () => {
		expect(globMatches("claude+sonnet", "claude+sonnet")).toBe(true);
		expect(globMatches("claude.sonnet", "claudeXsonnet")).toBe(false);
	});
});

// ── isTargetAllowed ─────────────────────────────────────────────────────────

describe("isTargetAllowed", () => {
	const cfg = request();

	test("free model in allowed list → true", () => {
		expect(
			isTargetAllowed(
				{ provider: "kilo", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
				cfg,
			),
		).toBe(true);
		expect(
			isTargetAllowed(
				{ provider: "kilo", model: "poolside/laguna-s-2.1:free" },
				cfg,
			),
		).toBe(true);
		expect(
			isTargetAllowed(
				{ provider: "kilo", model: "stealth/space-bunny-alpha" },
				cfg,
			),
		).toBe(true);
	});

	test("paid model with freeModelsOnly → false", () => {
		expect(
			isTargetAllowed({ provider: "kilo", model: "some-paid-model" }, cfg),
		).toBe(false);
	});

	test("freeModelsOnly=false permits any free model even if not in list", () => {
		const cfgLax = request({ freeModelsOnly: false, allowedModels: [] });
		expect(
			isTargetAllowed(
				{ provider: "kilo", model: "some-unknown-free" },
				cfgLax,
			),
		).toBe(true);
	});

	test("model not in allowedModels list → false", () => {
		const cfgRestricted = request({
			allowedModels: ["kilo/nvidia/nemotron-3-ultra-550b-a55b:free"],
		});
		expect(
			isTargetAllowed(
				{ provider: "kilo", model: "poolside/laguna-s-2.1:free" },
				cfgRestricted,
			),
		).toBe(false);
	});

	test("explicitly allowlisted paid model passes freeModelsOnly", () => {
		const cfgPaid = request({
			allowedModels: ["qwen/qwen3-max"],
		});
		expect(
			isTargetAllowed({ provider: "qwen", model: "qwen3-max" }, cfgPaid),
		).toBe(true);
	});

	test("paid model not allowlisted rejected under freeModelsOnly", () => {
		expect(
			isTargetAllowed({ provider: "kilo", model: "nvidia/nemotron-paid" }, request()),
		).toBe(false);
	});

	test("empty allowedModels permits all free models", () => {
		const cfgPermissive = request({ allowedModels: [] });
		expect(
			isTargetAllowed(
				{ provider: "kilo", model: "openrouter/free" },
				cfgPermissive,
			),
		).toBe(true);
	});

	// Regression: Qwen/DashScope has a promotional token quota but no free
	// model tier, so it must never slip through the free-only gate.
	test("qwen model is rejected by freeModelsOnly even with no allowlist", () => {
		const cfgOpen = request({ allowedModels: [] });
		expect(isTargetAllowed({ provider: "qwen", model: "qwen3-max" }, cfgOpen)).toBe(false);
		expect(isTargetAllowed({ provider: "qwen", model: "qwen3.8-max" }, cfgOpen)).toBe(false);
		expect(isFreeTarget({ provider: "qwen", model: "qwen3-max" })).toBe(false);
	});

	test("unknown qwen model fails closed under freeModelsOnly", () => {
		const cfgOpen = request({ allowedModels: [] });
		expect(isTargetAllowed({ provider: "qwen", model: "brand-new-model" }, cfgOpen)).toBe(false);
	});
});

// ── resolveTarget ───────────────────────────────────────────────────────────

describe("resolveTarget", () => {
	test("provider-qualified model returns that target", () => {
		const target = resolveTarget("qwen/qwen3.7-max", {}, request());
		expect(target.provider).toBe("qwen");
		expect(target.model).toBe("qwen3.7-max");
	});

	test("dashscope prefix is canonicalized to qwen", () => {
		const target = resolveTarget("dashscope/qwen3.7-max", {}, request());
		expect(target.provider).toBe("qwen");
		expect(target.model).toBe("qwen3.7-max");
	});

	test("explicit qwen model skips smart routing", () => {
		const target = resolveTarget("qwen/qwen3.7-max", {}, request());
		expect(target.provider).toBe("qwen");
	});

	test("claude model with image and smart routing → Kilo Stepfun", () => {
		const body: AnthropicMessagesRequest = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
						{ type: "text", text: "what is this?" },
					],
				},
			],
		};
		const target = resolveTarget("claude-sonnet-4-20250514", body, request());
		expect(target.provider).toBe("kilo");
		expect(target.model).toBe("stepfun/step-3.7-flash:free");
	});

	test("claude model with image honours a custom VISION_MODEL", () => {
		const body: AnthropicMessagesRequest = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
					],
				},
			],
		};
		const target = resolveTarget(
			"claude-sonnet-4-20250514",
			body,
			request({ visionModel: "kilo/openrouter/free" }),
		);
		expect(target.provider).toBe("kilo");
		expect(target.model).toBe("openrouter/free");
	});

	test("claude model with alias match → aliased target", () => {
		const target = resolveTarget("claude-sonnet-4-20250514", { messages: [{ role: "user", content: "hi" }] }, request());
		expect(target.provider).toBe("kilo");
		expect(target.model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
	});

	test("claude model without matching alias → explicit target", () => {
		const target = resolveTarget(
			"claude-unknown-model",
			{ messages: [{ role: "user", content: "hi" }] },
			request(),
		);
		// Falls through parseTarget — no provider prefix, so fallback to kilo
		expect(target.provider).toBe("kilo");
		expect(target.model).toBe("claude-unknown-model");
	});

	test("smartRouting disabled returns explicit target", () => {
		const cfgNoRouting = request({ smartRouting: false });
		const target = resolveTarget("claude-sonnet-4", { messages: [{ role: "user", content: "hi" }] }, cfgNoRouting);
		expect(target.provider).toBe("kilo");
		expect(target.model).toBe("claude-sonnet-4");
	});

	test("non-claude model skips smart routing", () => {
		const target = resolveTarget("gpt-4", { messages: [{ role: "user", content: "hi" }] }, request());
		expect(target.provider).toBe("kilo");
		expect(target.model).toBe("gpt-4");
	});
});

// ── buildCandidateTargets ───────────────────────────────────────────────────

describe("buildCandidateTargets", () => {
	test("first target + fallbacks deduped by displayTarget", () => {
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
			{ messages: [{ role: "user", content: "hi" }] },
			request(),
		);
		// First entry should be the requested target
		expect(targets[0]).toMatchObject({
			provider: "kilo",
			model: "nvidia/nemotron-3-ultra-550b-a55b:free",
		});
		// At least one fallback present
		expect(targets.length).toBeGreaterThan(1);
	});

	test("dedup removes duplicate entries", () => {
		const cfgDuplicates = request({
			fallbackModels: [
				"kilo/nvidia/nemotron-3-ultra-550b-a55b:free", // same as first target
				"kilo/poolside/laguna-m.1:free",
				"kilo/poolside/laguna-m.1:free", // explicit dup
			],
		});
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
			{ messages: [{ role: "user", content: "hi" }] },
			cfgDuplicates,
		);
		const ids = targets.map((t) => `${t.provider}/${t.model}`);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("explicitly allowlisted paid model survives freeModelsOnly", () => {
		const cfgPaid = request({
			allowedModels: ["kilo/paid-model", "kilo/nvidia/nemotron-3-ultra-550b-a55b:free"],
			fallbackModels: ["kilo/paid-model"],
		});
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "paid-model" },
			{ messages: [{ role: "user", content: "hi" }] },
			cfgPaid,
		);
		// ALLOWED_MODELS is an explicit approval list — the operator opted in
		expect(targets.length).toBe(1);
	});

	test("unapproved paid model filtered out under freeModelsOnly", () => {
		const cfgPaid = request({
			allowedModels: ["kilo/nvidia/nemotron-3-ultra-550b-a55b:free"],
			fallbackModels: ["kilo/paid-model"],
		});
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "paid-model" },
			{ messages: [{ role: "user", content: "hi" }] },
			cfgPaid,
		);
		expect(targets.length).toBe(0);
	});

	// Regression: with no allowlist, a paid Qwen model must not become a
	// candidate merely because a QWEN_API_KEY happens to be configured.
	test("paid qwen model is not a candidate without an explicit opt-in", () => {
		const cfgOpen = request({ allowedModels: [] });
		const targets = buildCandidateTargets(
			{ provider: "qwen", model: "qwen3-max" },
			{ messages: [{ role: "user", content: "hi" }] },
			cfgOpen,
		);
		const ids = targets.map((t) => `${t.provider}/${t.model}`);
		expect(ids).not.toContain("qwen/qwen3-max");
		// The free Kilo fallbacks are untouched.
		expect(ids).toContain("kilo/nvidia/nemotron-3-ultra-550b-a55b:free");
	});

	test("allowlisted qwen model becomes a candidate", () => {
		const cfgPaid = request({
			allowedModels: ["qwen/qwen3-max"],
			fallbackModels: [],
		});
		const targets = buildCandidateTargets(
			{ provider: "qwen", model: "qwen3-max" },
			{ messages: [{ role: "user", content: "hi" }] },
			cfgPaid,
		);
		expect(targets).toHaveLength(1);
	});

	test("filters out targets lacking tool capability when tools requested", () => {
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
			{
				messages: [{ role: "user", content: "hi" }],
				tools: [{ name: "get_weather", input_schema: {} }],
			},
			request(),
		);
		// kilo/nvidia/nemotron-3-ultra-550b-a55b:free supports tools (true in capabilities)
		expect(targets.length).toBeGreaterThanOrEqual(1);
	});

	test("filters out non-vision targets when the request carries an image", () => {
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
						],
					},
				],
			},
			request(),
		);
		// Nemotron Ultra is text-only, so only vision-capable candidates survive
		expect(targets.every((t) => getCapabilities(t).vision)).toBe(true);
	});

	test("request-supplied API key enables a provider with no config key", () => {
		const cfgNoKeys = request({ kiloApiKey: "", qwenApiKey: "" });
		// Without a request key: no provider enabled → no candidates
		expect(
			buildCandidateTargets(
				{ provider: "kilo", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
				{ messages: [{ role: "user", content: "hi" }] },
				cfgNoKeys,
			),
		).toHaveLength(0);
		// With a request key: candidates are enabled (README header-key mode)
		expect(
			buildCandidateTargets(
				{ provider: "kilo", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
				{ messages: [{ role: "user", content: "hi" }] },
				cfgNoKeys,
				"sk-request-key",
			).length,
		).toBeGreaterThanOrEqual(1);
	});
});

// ── qualifyModel ────────────────────────────────────────────────────────────

describe("qualifyModel", () => {
	test("kilo target with MODEL_PREFIX gets prefixed", () => {
		const cfg = request({ modelPrefix: "anthropic/" });
		expect(
			qualifyModel({ provider: "kilo", model: "claude-sonnet-4" }, cfg),
		).toBe("anthropic/claude-sonnet-4");
	});

	test("kilo target already prefixed is not double-prefixed", () => {
		const cfg = request({ modelPrefix: "anthropic/" });
		expect(
			qualifyModel(
				{ provider: "kilo", model: "anthropic/claude-sonnet-4" },
				cfg,
			),
		).toBe("anthropic/claude-sonnet-4");
	});

	test("qwen target ignores MODEL_PREFIX", () => {
		const cfg = request({ modelPrefix: "anthropic/" });
		expect(
			qualifyModel(
				{ provider: "qwen", model: "qwen3.7-max" },
				cfg,
			),
		).toBe("qwen3.7-max");
	});

	test("no MODEL_PREFIX leaves model untouched", () => {
		expect(
			qualifyModel(
				{ provider: "kilo", model: "stepfun/step-3.7-flash:free" },
				request(),
			),
		).toBe("stepfun/step-3.7-flash:free");
	});
});

// ── isAuthorized & Security ──────────────────────────────────────────────────

describe("isAuthorized", () => {
	test("returns true when expectedKey is empty", () => {
		const req = new Request("http://localhost/v1/messages");
		expect(isAuthorized(req, "")).toBe(true);
	});

	test("authorizes with matching x-proxy-api-key", () => {
		const req = new Request("http://localhost/v1/messages", {
			headers: { "x-proxy-api-key": "secret-123" },
		});
		expect(isAuthorized(req, "secret-123")).toBe(true);
	});

	test("authorizes with matching Authorization: Bearer header", () => {
		const req = new Request("http://localhost/v1/messages", {
			headers: { authorization: "Bearer secret-123" },
		});
		expect(isAuthorized(req, "secret-123")).toBe(true);
	});

	test("rejects mismatched key of same or different length", () => {
		const req1 = new Request("http://localhost/v1/messages", {
			headers: { "x-proxy-api-key": "secret-124" },
		});
		expect(isAuthorized(req1, "secret-123")).toBe(false);

		const req2 = new Request("http://localhost/v1/messages", {
			headers: { "x-proxy-api-key": "short" },
		});
		expect(isAuthorized(req2, "secret-123")).toBe(false);
	});
});

// ── globMatches ─────────────────────────────────────────────────────────────

describe("globMatches", () => {
	test("matches standard glob wildcards", () => {
		expect(globMatches("*haiku*", "claude-3-5-haiku-latest")).toBe(true);
		expect(globMatches("*opus*", "claude-3-opus-20240229")).toBe(true);
		expect(globMatches("*sonnet*", "gpt-4o")).toBe(false);
	});

	test("safely handles patterns containing question marks and special regex chars", () => {
		expect(globMatches("model-?-v1", "model-?-v1")).toBe(true);
		expect(globMatches("model+[a-z]*", "model+[a-z]test")).toBe(true);
	});
});

// ── RequestLimiter & AbortSignal ────────────────────────────────────────────

describe("RequestLimiter", () => {
	test("aborts queued item when AbortSignal fires", async () => {
		const limiter = new RequestLimiter(1, 2);
		const release1 = await limiter.acquire();
		expect(release1).toBeDefined();

		const controller = new AbortController();
		const queuePromise = limiter.acquire(controller.signal);

		controller.abort();
		const result = await queuePromise;
		expect(result).toBeUndefined();

		release1?.();
	});
});

// ── Prometheus Metrics ──────────────────────────────────────────────────────

describe("prometheusMetrics", () => {
	test("formats Prometheus metrics with latency and escaped labels", () => {
		recordModelRequest("test\rprovider/test\nmodel");
		const out = prometheusMetrics();
		expect(out).toContain("kilo_proxy_request_duration_ms_total");
		expect(out).toContain("kilo_proxy_requests_total");
		expect(out).not.toContain("\r");
	});
});
