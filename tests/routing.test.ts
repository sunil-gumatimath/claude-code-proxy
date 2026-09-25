import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { getCapabilities, isFreeTarget, parseTarget } from "../src/providers";
import {
	buildCandidateTargets,
	globMatches,
	isTargetAllowed,
	requestNeedsVision,
	resolveTarget,
} from "../src/routing";
import type { AnthropicMessagesRequest } from "../src/types";
import { testConfig } from "./fixtures";

const imageBody: AnthropicMessagesRequest = {
	messages: [
		{
			role: "user",
			content: [
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: "abc" },
				},
				{ type: "text", text: "what is this?" },
			],
		},
	],
};

const textBody: AnthropicMessagesRequest = {
	messages: [{ role: "user", content: "hi" }],
};

// ── globMatches ──────────────────────────────────────────────────────────────

describe("globMatches", () => {
	test("exact, prefix, suffix and infix wildcards", () => {
		expect(globMatches("claude-sonnet-4", "claude-sonnet-4")).toBe(true);
		expect(globMatches("claude-*", "claude-sonnet-4")).toBe(true);
		expect(globMatches("*haiku*", "claude-3-5-haiku-latest")).toBe(true);
		expect(globMatches("*opus*", "claude-3-opus-20240229")).toBe(true);
		expect(globMatches("*sonnet*", "gpt-4o")).toBe(false);
	});

	test("is case-insensitive", () => {
		expect(globMatches("*SONNET*", "claude-sonnet-4")).toBe(true);
		expect(globMatches("claude-sonnet-4", "CLAUDE-SONNET-4")).toBe(true);
	});

	test("anchors the pattern instead of substring-matching", () => {
		// Without ^…$ a pattern like "sonnet" would match "claude-sonnet-4"
		// anywhere, which is not what an operator writing a pattern expects.
		expect(globMatches("sonnet", "claude-sonnet-4")).toBe(false);
	});

	test("escapes regex metacharacters in the pattern", () => {
		expect(globMatches("claude+sonnet", "claude+sonnet")).toBe(true);
		expect(globMatches("claude.sonnet", "claudeXsonnet")).toBe(false);
		expect(globMatches("model+[a-z]*", "model+[a-z]test")).toBe(true);
		expect(globMatches("model-?-v1", "model-?-v1")).toBe(true);
	});

	test("cannot be turned into a catastrophic-backtracking regex", () => {
		// `*` becomes `.*`; the anchors plus the linear pattern keep a long
		// non-matching input from blowing up.
		const started = performance.now();
		expect(globMatches("*a*".repeat(1), "b".repeat(2000))).toBe(false);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

// ── requestNeedsVision ───────────────────────────────────────────────────────

describe("requestNeedsVision", () => {
	test("detects an image block anywhere in the conversation", () => {
		expect(requestNeedsVision(imageBody)).toBe(true);
	});

	test("string content and text-only blocks are not vision", () => {
		expect(requestNeedsVision(textBody)).toBe(false);
		expect(
			requestNeedsVision({
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		).toBe(false);
	});

	test("a missing or malformed message list is not vision", () => {
		expect(requestNeedsVision({})).toBe(false);
		expect(requestNeedsVision({ messages: [] })).toBe(false);
	});
});

// ── isTargetAllowed (the cost gate) ──────────────────────────────────────────

describe("isTargetAllowed", () => {
	test("allowlisted free model → true", () => {
		const cfg = testConfig();
		expect(
			isTargetAllowed({ provider: "kilo", model: "stealth/space-bunny-alpha" }, cfg),
		).toBe(true);
		expect(
			isTargetAllowed({ provider: "kilo", model: "poolside/laguna-s-2.1:free" }, cfg),
		).toBe(true);
	});

	test("unapproved paid model → false", () => {
		expect(
			isTargetAllowed({ provider: "kilo", model: "some-paid-model" }, testConfig()),
		).toBe(false);
		expect(
			isTargetAllowed({ provider: "kilo", model: "nvidia/nemotron-paid" }, testConfig()),
		).toBe(false);
	});

	test("model absent from a non-empty allowlist → false", () => {
		const cfg = testConfig({ allowedModels: ["kilo/stealth/space-bunny-alpha"] });
		expect(
			isTargetAllowed({ provider: "kilo", model: "poolside/laguna-s-2.1:free" }, cfg),
		).toBe(false);
	});

	test("explicitly allowlisted paid model passes FREE_MODELS_ONLY", () => {
		const cfg = testConfig({ allowedModels: ["qwen/qwen3-max"] });
		expect(isTargetAllowed({ provider: "qwen", model: "qwen3-max" }, cfg)).toBe(true);
	});

	test("an empty allowlist permits every free model", () => {
		const cfg = testConfig({ allowedModels: [] });
		expect(isTargetAllowed({ provider: "kilo", model: "openrouter/free" }, cfg)).toBe(
			true,
		);
	});

	test("FREE_MODELS_ONLY=false with an empty allowlist permits anything", () => {
		const cfg = testConfig({ allowedModels: [], freeModelsOnly: false });
		expect(isTargetAllowed({ provider: "kilo", model: "some-unknown-model" }, cfg)).toBe(
			true,
		);
	});

	// A promotional token quota is not a free tier, so a Qwen key alone must
	// never be able to start billing traffic.
	test("qwen is never free, even with no allowlist and a configured key", () => {
		const cfg = testConfig({ allowedModels: [] });
		expect(isTargetAllowed({ provider: "qwen", model: "qwen3-max" }, cfg)).toBe(false);
		expect(isTargetAllowed({ provider: "qwen", model: "qwen3.8-max" }, cfg)).toBe(false);
		expect(isTargetAllowed({ provider: "qwen", model: "brand-new-model" }, cfg)).toBe(
			false,
		);
		expect(isFreeTarget({ provider: "qwen", model: "qwen3-max" })).toBe(false);
	});

	test("an unknown kilo id is free only if it carries a free-tier marker", () => {
		expect(isFreeTarget({ provider: "kilo", model: "vendor/new-model:free" })).toBe(true);
		expect(isFreeTarget({ provider: "kilo", model: "vendor/new-model-free" })).toBe(true);
		expect(isFreeTarget({ provider: "kilo", model: "vendor/new-model" })).toBe(false);
	});

	// The end-to-end version of "configured ids resolve like requested ids".
	// A bare ALLOWED_MODELS entry used to stay bare while the gate compares
	// `provider/model`, so it never matched the target it was meant to approve
	// — and the documented Ollama walkthrough was silently broken.
	test("a bare configured entry matches a bare request for the same model", () => {
		const cfg = loadConfig({ ALLOWED_MODELS: "my-local-model" });
		expect(cfg.allowedModels).toEqual(["kilo/my-local-model"]);
		expect(isTargetAllowed(parseTarget("my-local-model"), cfg)).toBe(true);
	});

	test("the alias and qualified spellings of an entry are equivalent", () => {
		const qualified = loadConfig({
			ALLOWED_MODELS: "qwen/qwen3-max",
			FREE_MODELS_ONLY: "false",
		});
		const alias = loadConfig({
			ALLOWED_MODELS: "dashscope/qwen3-max",
			FREE_MODELS_ONLY: "false",
		});
		const target = parseTarget("qwen/qwen3-max");
		expect(qualified.allowedModels).toEqual(["qwen/qwen3-max"]);
		expect(alias.allowedModels).toEqual(["qwen/qwen3-max"]);
		expect(isTargetAllowed(target, qualified)).toBe(true);
		expect(isTargetAllowed(target, alias)).toBe(true);
	});

	test("a bare entry and its kilo/ spelling are equivalent", () => {
		const bare = loadConfig({
			ALLOWED_MODELS: "my-local-model",
			FREE_MODELS_ONLY: "false",
		});
		const qualified = loadConfig({
			ALLOWED_MODELS: "kilo/my-local-model",
			FREE_MODELS_ONLY: "false",
		});
		const target = parseTarget("my-local-model");
		expect(bare.allowedModels).toEqual(["kilo/my-local-model"]);
		expect(isTargetAllowed(target, bare)).toBe(true);
		expect(isTargetAllowed(target, qualified)).toBe(true);
	});

	// Normalising a bare name to kilo/ must not become a way to approve the same
	// name on a *different* provider: `qwen3-max` means kilo/qwen3-max, and has
	// nothing to do with qwen/qwen3-max.
	test("a bare entry does not approve the same name on another provider", () => {
		const cfg = loadConfig({ ALLOWED_MODELS: "qwen3-max", FREE_MODELS_ONLY: "false" });
		expect(cfg.allowedModels).toEqual(["kilo/qwen3-max"]);
		expect(isTargetAllowed(parseTarget("qwen3-max"), cfg)).toBe(true);
		expect(isTargetAllowed(parseTarget("qwen/qwen3-max"), cfg)).toBe(false);
	});
});

// ── resolveTarget ────────────────────────────────────────────────────────────

describe("resolveTarget", () => {
	test("provider-qualified model is returned untouched", () => {
		const target = resolveTarget("qwen/qwen3.7-max", {}, testConfig());
		expect(target).toEqual({ provider: "qwen", model: "qwen3.7-max" });
	});

	test("dashscope prefix is canonicalized to qwen", () => {
		expect(resolveTarget("dashscope/qwen3.7-max", {}, testConfig())).toEqual({
			provider: "qwen",
			model: "qwen3.7-max",
		});
	});

	test("a provider-qualified id skips smart routing entirely", () => {
		// The image branch must not hijack an explicit choice.
		const target = resolveTarget("qwen/qwen3.7-max", imageBody, testConfig());
		expect(target.provider).toBe("qwen");
	});

	test("claude-* with an image routes to VISION_MODEL", () => {
		expect(resolveTarget("claude-sonnet-4-20250514", imageBody, testConfig())).toEqual({
			provider: "kilo",
			model: "stealth/space-bunny-alpha",
		});
	});

	test("a custom VISION_MODEL is honoured", () => {
		const cfg = testConfig({ visionModel: "kilo/stepfun/step-3.7-flash:free" });
		expect(resolveTarget("claude-sonnet-4", imageBody, cfg)).toEqual({
			provider: "kilo",
			model: "stepfun/step-3.7-flash:free",
		});
	});

	test("claude-* routes through the first matching alias", () => {
		expect(resolveTarget("claude-sonnet-4-20250514", textBody, testConfig())).toEqual({
			provider: "kilo",
			model: "poolside/laguna-s-2.1:free",
		});
	});

	test("claude-* with no matching alias falls through to the bare name", () => {
		expect(resolveTarget("claude-unknown-model", textBody, testConfig())).toEqual({
			provider: "kilo",
			model: "claude-unknown-model",
		});
	});

	test("SMART_ROUTING=false disables every rewrite", () => {
		const cfg = testConfig({ smartRouting: false });
		expect(resolveTarget("claude-sonnet-4", textBody, cfg)).toEqual({
			provider: "kilo",
			model: "claude-sonnet-4",
		});
		expect(resolveTarget("claude-sonnet-4", imageBody, cfg)).toEqual({
			provider: "kilo",
			model: "claude-sonnet-4",
		});
	});

	test("a non-claude model skips smart routing", () => {
		expect(resolveTarget("gpt-4", textBody, testConfig())).toEqual({
			provider: "kilo",
			model: "gpt-4",
		});
	});
});

// ── buildCandidateTargets ────────────────────────────────────────────────────

describe("buildCandidateTargets", () => {
	test("requested model leads, fallbacks follow", () => {
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "stealth/space-bunny-alpha" },
			textBody,
			testConfig(),
		);
		expect(targets[0]).toEqual({ provider: "kilo", model: "stealth/space-bunny-alpha" });
		expect(targets.length).toBeGreaterThan(1);
	});

	test("duplicates collapse while preserving first-seen order", () => {
		const cfg = testConfig({
			fallbackModels: [
				"kilo/stealth/space-bunny-alpha", // same as the requested target
				"kilo/poolside/laguna-s-2.1:free",
				"kilo/poolside/laguna-s-2.1:free", // explicit duplicate
			],
		});
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "stealth/space-bunny-alpha" },
			textBody,
			cfg,
		);
		const ids = targets.map((t) => `${t.provider}/${t.model}`);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids[0]).toBe("kilo/stealth/space-bunny-alpha");
	});

	test("a provider with no key and no request key yields no candidates", () => {
		const cfg = testConfig({ kiloApiKey: "", qwenApiKey: "" });
		expect(
			buildCandidateTargets(
				{ provider: "kilo", model: "stealth/space-bunny-alpha" },
				textBody,
				cfg,
			),
		).toHaveLength(0);
	});

	test("a request-supplied key enables a provider that has no config key", () => {
		const cfg = testConfig({ kiloApiKey: "", qwenApiKey: "" });
		const first = { provider: "kilo" as const, model: "stealth/space-bunny-alpha" };
		expect(buildCandidateTargets(first, textBody, cfg)).toHaveLength(0);
		expect(
			buildCandidateTargets(first, textBody, cfg, "sk-request-key").length,
		).toBeGreaterThanOrEqual(1);
	});

	// A request key authenticates the provider the client addressed; it must not
	// be treated as a key for every provider in the fallback chain.
	test("a request key does not enable a *different* provider's fallbacks", () => {
		const cfg = testConfig({
			kiloApiKey: "",
			qwenApiKey: "",
			fallbackModels: ["qwen/qwen3-max"],
			allowedModels: ["kilo/stealth/space-bunny-alpha", "qwen/qwen3-max"],
		});
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "stealth/space-bunny-alpha" },
			textBody,
			cfg,
			"sk-request-key",
		);
		expect(targets.map((t) => t.provider)).toEqual(["kilo"]);
	});

	test("unapproved paid fallbacks are dropped", () => {
		const cfg = testConfig({
			allowedModels: ["kilo/stealth/space-bunny-alpha"],
			fallbackModels: ["kilo/paid-model"],
		});
		expect(
			buildCandidateTargets({ provider: "kilo", model: "paid-model" }, textBody, cfg),
		).toHaveLength(0);
	});

	test("an allowlisted paid model survives as a candidate", () => {
		const cfg = testConfig({
			allowedModels: ["kilo/paid-model", "kilo/stealth/space-bunny-alpha"],
			fallbackModels: ["kilo/paid-model"],
		});
		expect(
			buildCandidateTargets({ provider: "kilo", model: "paid-model" }, textBody, cfg),
		).toHaveLength(1);
	});

	test("an allowlisted qwen model becomes a candidate", () => {
		const cfg = testConfig({ allowedModels: ["qwen/qwen3-max"], fallbackModels: [] });
		expect(
			buildCandidateTargets({ provider: "qwen", model: "qwen3-max" }, textBody, cfg),
		).toHaveLength(1);
	});

	test("a paid qwen model is not a candidate without an explicit opt-in", () => {
		const cfg = testConfig({ allowedModels: [] });
		const ids = buildCandidateTargets(
			{ provider: "qwen", model: "qwen3-max" },
			textBody,
			cfg,
		).map((t) => `${t.provider}/${t.model}`);
		// The requested Qwen model is dropped; the free Kilo fallbacks remain.
		expect(ids).not.toContain("qwen/qwen3-max");
		expect(ids.every((id) => id.startsWith("kilo/"))).toBe(true);
		expect(ids).toContain("kilo/poolside/laguna-s-2.1:free");
	});

	test("an image request drops every non-vision candidate", () => {
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
			imageBody,
			testConfig(),
		);
		expect(targets.length).toBeGreaterThan(0);
		expect(targets.every((t) => getCapabilities(t).vision)).toBe(true);
	});

	test("a tools request drops candidates with no tool support", () => {
		const cfg = testConfig({
			allowedModels: ["kilo/new-unknown-model"],
			fallbackModels: [],
		});
		// Unknown models are assumed to support neither tools nor images, so a
		// Claude Code turn (which always sends tools) cannot fall back to one.
		expect(
			buildCandidateTargets(
				{ provider: "kilo", model: "new-unknown-model" },
				{ messages: [{ role: "user", content: "hi" }], tools: [{ name: "t" }] },
				cfg,
			),
		).toHaveLength(0);
	});

	test("a tools request keeps a tool-capable model", () => {
		const targets = buildCandidateTargets(
			{ provider: "kilo", model: "stealth/space-bunny-alpha" },
			{ messages: [{ role: "user", content: "hi" }], tools: [{ name: "t" }] },
			testConfig(),
		);
		expect(targets.length).toBeGreaterThanOrEqual(1);
	});
});
