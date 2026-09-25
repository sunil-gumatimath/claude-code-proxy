import { describe, expect, test } from "bun:test";
import {
	isLoopbackHost,
	loadConfig,
	parseAliases,
	parseReasoningEffort,
} from "../src/config";
import { freeModelIds, parseTarget } from "../src/providers";

describe("loadConfig defaults", () => {
	test("the default allowlist is exactly the free capability set", () => {
		// The two used to be hand-maintained in separate files, so a model added
		// to one and forgotten in the other was rejected with a message that
		// pointed at the wrong table.
		const cfg = loadConfig({});
		expect(new Set(cfg.allowedModels)).toEqual(new Set(freeModelIds()));
	});

	test("the default primary and vision model are allowlisted", () => {
		const cfg = loadConfig({});
		expect(cfg.allowedModels).toContain(cfg.defaultModel);
		expect(cfg.allowedModels).toContain(cfg.visionModel);
	});

	test("every default fallback is allowlisted", () => {
		// Otherwise the documented fallback chain silently stops at the first
		// retired id, which is exactly when the chain is needed.
		const cfg = loadConfig({});
		for (const model of cfg.fallbackModels) {
			expect(cfg.allowedModels).toContain(model);
		}
	});

	test("the free-only gate is on and the allowlist is populated by default", () => {
		const cfg = loadConfig({});
		expect(cfg.freeModelsOnly).toBe(true);
		expect(cfg.allowedModels.length).toBeGreaterThan(0);
	});

	test("binds to loopback with the documented port", () => {
		const cfg = loadConfig({});
		expect(cfg.host).toBe("127.0.0.1");
		expect(cfg.port).toBe(4181);
		expect(isLoopbackHost(cfg.host)).toBe(true);
	});

	test("an explicit ALLOWED_MODELS replaces the derived default", () => {
		const cfg = loadConfig({ ALLOWED_MODELS: "kilo/foo:free, dashscope/qwen3-max" });
		expect(cfg.allowedModels).toEqual(["kilo/foo:free", "qwen/qwen3-max"]);
	});

	// A bare configured id must canonicalise the same way a bare *request* does.
	// Routing resolves an unqualified name to Kilo, so an allowlist entry left
	// bare would never match the target it was meant to approve — which surfaced
	// as an unexplained "Model is not permitted by this free-only proxy".
	test("a bare allowlist entry resolves to the kilo/ form the gate compares", () => {
		const cfg = loadConfig({ ALLOWED_MODELS: "my-local-model" });
		expect(cfg.allowedModels).toEqual(["kilo/my-local-model"]);
		// That it also *matches* a request for the bare name is asserted in
		// routing.test.ts, where the gate itself lives.
		expect(parseTarget("my-local-model")).toEqual({
			provider: "kilo",
			model: "my-local-model",
		});
	});

	test("configured model ids canonicalise the same way as request ids", () => {
		// Every config surface goes through the same resolution, so none of them
		// can drift from what the gate checks.
		const cfg = loadConfig({
			DEFAULT_MODEL: "my-local-model",
			VISION_MODEL: "dashscope/qwen3-max",
			FALLBACK_MODELS: "my-local-model,qwen3-max",
			ALLOWED_MODELS: "my-local-model,qwen3-max",
			MODEL_ALIASES: "*haiku*=my-local-model",
		});
		expect(cfg.defaultModel).toBe("kilo/my-local-model");
		expect(cfg.visionModel).toBe("qwen/qwen3-max");
		expect(cfg.fallbackModels).toEqual(["kilo/my-local-model", "kilo/qwen3-max"]);
		expect(cfg.allowedModels).toEqual(["kilo/my-local-model", "kilo/qwen3-max"]);
		expect(cfg.modelAliases[0].model).toBe("kilo/my-local-model");
	});

	test("an unknown prefix is kept as part of the model name, under kilo/", () => {
		// parseTarget does not recognise `openai` as a provider, so the whole
		// string is the model — and the canonical form is kilo/openai/gpt-4.
		const cfg = loadConfig({ ALLOWED_MODELS: "openai/gpt-4" });
		expect(cfg.allowedModels).toEqual(["kilo/openai/gpt-4"]);
		expect(parseTarget("openai/gpt-4")).toEqual({
			provider: "kilo",
			model: "openai/gpt-4",
		});
	});

	test("MODEL_PREFIX is read through envStr, so an empty value means none", () => {
		expect(loadConfig({ MODEL_PREFIX: "" }).modelPrefix).toBe("");
		expect(loadConfig({ MODEL_PREFIX: "anthropic/" }).modelPrefix).toBe("anthropic/");
	});

	test("trailing slashes are stripped from base URLs", () => {
		const cfg = loadConfig({ KILO_BASE_URL: "https://example.test/v1///" });
		expect(cfg.kiloBaseUrl).toBe("https://example.test/v1");
	});

	test("DASHSCOPE_* are accepted as aliases for the Qwen settings", () => {
		const cfg = loadConfig({
			DASHSCOPE_API_KEY: "dk",
			DASHSCOPE_BASE_URL: "https://d.test",
		});
		expect(cfg.qwenApiKey).toBe("dk");
		expect(cfg.qwenBaseUrl).toBe("https://d.test");
	});

	test("QWEN_* wins over the DASHSCOPE_ aliases", () => {
		const cfg = loadConfig({ QWEN_API_KEY: "qk", DASHSCOPE_API_KEY: "dk" });
		expect(cfg.qwenApiKey).toBe("qk");
	});
});

describe("envInt / envBool semantics", () => {
	test("a non-numeric or out-of-range value falls back", () => {
		expect(loadConfig({ PROXY_PORT: "abc" }).port).toBe(4181);
		expect(loadConfig({ PROXY_PORT: "0" }).port).toBe(4181);
		expect(loadConfig({ PROXY_PORT: "-1" }).port).toBe(4181);
		expect(loadConfig({ PROXY_PORT: "9999" }).port).toBe(9999);
	});

	test("queue depth and cooldown accept 0 because 0 is meaningful", () => {
		expect(loadConfig({ MAX_QUEUED_REQUESTS: "0" }).maxQueuedRequests).toBe(0);
		expect(loadConfig({ MODEL_COOLDOWN_MS: "0" }).modelCooldownMs).toBe(0);
		// But a required magnitude still rejects 0.
		expect(loadConfig({ MAX_CONCURRENT_REQUESTS: "0" }).maxConcurrentRequests).toBe(4);
	});

	test("booleans accept the usual spellings in any case", () => {
		expect(loadConfig({ FREE_MODELS_ONLY: "true" }).freeModelsOnly).toBe(true);
		expect(loadConfig({ FREE_MODELS_ONLY: "1" }).freeModelsOnly).toBe(true);
		expect(loadConfig({ FREE_MODELS_ONLY: "YES" }).freeModelsOnly).toBe(true);
		expect(loadConfig({ FREE_MODELS_ONLY: "on" }).freeModelsOnly).toBe(true);
		expect(loadConfig({ FREE_MODELS_ONLY: "false" }).freeModelsOnly).toBe(false);
		expect(loadConfig({ FREE_MODELS_ONLY: "0" }).freeModelsOnly).toBe(false);
		expect(loadConfig({ FREE_MODELS_ONLY: "no" }).freeModelsOnly).toBe(false);
	});

	// A typo must not switch off a security gate. FREE_MODELS_ONLY defaults to
	// true, so anything unrecognised has to keep it true.
	test("an unrecognised boolean keeps the secure default rather than failing open", () => {
		for (const typo of ["ture", "flase", "0x1", "2", "enabled", " true extra"]) {
			expect(loadConfig({ FREE_MODELS_ONLY: typo }).freeModelsOnly).toBe(true);
		}
		// And the same for the other opt-in defaults.
		expect(loadConfig({ SMART_ROUTING: "maybe" }).smartRouting).toBe(true);
		expect(loadConfig({ DEBUG: "maybe" }).debug).toBe(false);
		expect(
			loadConfig({ UPSTREAM_TLS_REJECT_UNAUTHORIZED: "maybe" })
				.upstreamTlsRejectUnauthorized,
		).toBe(true);
	});

	test("REASONING_EFFORT only accepts a known value, else it is cleared", () => {
		expect(loadConfig({ REASONING_EFFORT: "HIGH" }).reasoningEffort).toBe("high");
		expect(loadConfig({ REASONING_EFFORT: "no_think" }).reasoningEffort).toBe("no_think");
		expect(loadConfig({ REASONING_EFFORT: "ludicrous" }).reasoningEffort).toBe("");
		expect(parseReasoningEffort("  Medium  ")).toBe("medium");
		expect(parseReasoningEffort("")).toBe("");
	});
});

describe("parseAliases", () => {
	test("parses pattern=model pairs and lowercases patterns", () => {
		expect(parseAliases("*Haiku*=kilo/a:free, *sonnet*=kilo/b:free")).toEqual([
			{ pattern: "*haiku*", model: "kilo/a:free" },
			{ pattern: "*sonnet*", model: "kilo/b:free" },
		]);
	});

	test("drops entries missing either half", () => {
		expect(parseAliases("*haiku*,=kilo/a:free,*opus*=,")).toEqual([]);
	});

	test("canonicalizes the model half", () => {
		expect(parseAliases("*x*=dashscope/qwen3-max")).toEqual([
			{ pattern: "*x*", model: "qwen/qwen3-max" },
		]);
	});
});

describe("isLoopbackHost", () => {
	test("accepts every loopback spelling", () => {
		for (const host of [
			"127.0.0.1",
			"127.0.0.53",
			"localhost",
			"LOCALHOST",
			"::1",
			"[::1]",
			"0:0:0:0:0:0:0:1",
			"::ffff:127.0.0.1",
			"",
		]) {
			expect(isLoopbackHost(host)).toBe(true);
		}
	});

	test("rejects the wildcards and any specific interface address", () => {
		// The previous check compared only against "0.0.0.0" and "::", so
		// PROXY_HOST=192.168.1.50 bound to the LAN with no warning at all.
		for (const host of [
			"0.0.0.0",
			"::",
			"[::]",
			"192.168.1.50",
			"10.0.0.5",
			"example.test",
		]) {
			expect(isLoopbackHost(host)).toBe(false);
		}
	});

	test("does not treat a lookalike address as loopback", () => {
		expect(isLoopbackHost("127.0.0.1.evil.test")).toBe(false);
		expect(isLoopbackHost("1127.0.0.1")).toBe(false);
		expect(isLoopbackHost("localhost.evil.test")).toBe(false);
	});
});
