import { describe, expect, test } from "bun:test";
import {
	ANY_REASONING_EFFORT,
	canonicalizeModelId,
	displayTarget,
	freeModelIds,
	getCapabilities,
	isFreeTarget,
	normalizeReasoningEffort,
	parseTarget,
	qualifyModel,
	reasoningVocabulary,
} from "../src/providers";
import { testConfig } from "./fixtures";

const kilo = (model: string) => ({ provider: "kilo", model }) as const;
const qwen = (model: string) => ({ provider: "qwen", model }) as const;

describe("parseTarget", () => {
	test("splits a known provider prefix", () => {
		expect(parseTarget("kilo/stealth/space-bunny-alpha")).toEqual({
			provider: "kilo",
			model: "stealth/space-bunny-alpha",
		});
	});

	test("dashscope is an alias for qwen", () => {
		expect(parseTarget("dashscope/qwen3-max")).toEqual({
			provider: "qwen",
			model: "qwen3-max",
		});
	});

	test("the prefix is case-insensitive", () => {
		expect(parseTarget("KILO/foo").provider).toBe("kilo");
	});

	test("an unknown prefix stays part of the model name", () => {
		expect(parseTarget("openai/gpt-4")).toEqual({
			provider: "kilo",
			model: "openai/gpt-4",
		});
	});

	test("a bare name defaults to kilo", () => {
		expect(parseTarget("gpt-4")).toEqual({ provider: "kilo", model: "gpt-4" });
	});

	test("a leading slash is not a prefix", () => {
		expect(parseTarget("/leading")).toEqual({ provider: "kilo", model: "/leading" });
	});
});

describe("canonicalizeModelId", () => {
	test("rewrites an alias prefix to the canonical provider", () => {
		expect(canonicalizeModelId("dashscope/qwen3-max")).toBe("qwen/qwen3-max");
	});

	test("is idempotent on an already-canonical id", () => {
		expect(canonicalizeModelId("qwen/qwen3-max")).toBe("qwen/qwen3-max");
	});

	test("leaves an unrelated prefix alone", () => {
		expect(canonicalizeModelId("openai/gpt-4")).toBe("openai/gpt-4");
	});
});

describe("displayTarget", () => {
	test("round-trips through parseTarget", () => {
		const id = "kilo/stealth/space-bunny-alpha";
		expect(displayTarget(parseTarget(id))).toBe(id);
	});
});

describe("qualifyModel", () => {
	test("applies MODEL_PREFIX to a kilo target", () => {
		const cfg = testConfig({ modelPrefix: "anthropic/" });
		expect(qualifyModel(kilo("claude-sonnet-4"), cfg)).toBe("anthropic/claude-sonnet-4");
	});

	test("does not double-prefix", () => {
		const cfg = testConfig({ modelPrefix: "anthropic/" });
		expect(qualifyModel(kilo("anthropic/claude-sonnet-4"), cfg)).toBe(
			"anthropic/claude-sonnet-4",
		);
	});

	test("never prefixes a qwen target", () => {
		const cfg = testConfig({ modelPrefix: "anthropic/" });
		expect(qualifyModel(qwen("qwen3.7-max"), cfg)).toBe("qwen3.7-max");
	});

	test("an empty prefix leaves the model untouched", () => {
		expect(qualifyModel(kilo("stepfun/step-3.7-flash:free"), testConfig())).toBe(
			"stepfun/step-3.7-flash:free",
		);
	});
});

describe("capability lookups", () => {
	test("a known model reports its declared capabilities", () => {
		expect(getCapabilities(kilo("stealth/space-bunny-alpha"))).toMatchObject({
			tools: true,
			vision: true,
			free: true,
		});
		expect(getCapabilities(kilo("nvidia/nemotron-3-ultra-550b-a55b:free"))).toMatchObject(
			{
				tools: true,
				vision: false,
				free: true,
			},
		);
	});

	test("an unknown model assumes no tools, no vision, and paid", () => {
		expect(getCapabilities(kilo("who/knows"))).toEqual({
			tools: false,
			vision: false,
			free: false,
		});
	});

	test("every free id is a real, provider-qualified entry", () => {
		const ids = freeModelIds();
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) {
			const target = parseTarget(id);
			expect(isFreeTarget(target)).toBe(true);
			expect(getCapabilities(target).free).toBe(true);
		}
	});

	test("no qwen model is ever reported free", () => {
		for (const id of freeModelIds()) expect(id.startsWith("kilo/")).toBe(true);
	});
});

describe("normalizeReasoningEffort", () => {
	test("an unset effort stays unset", () => {
		expect(
			normalizeReasoningEffort(kilo("stealth/space-bunny-alpha"), undefined),
		).toBeUndefined();
		expect(
			normalizeReasoningEffort(kilo("stealth/space-bunny-alpha"), ""),
		).toBeUndefined();
	});

	test("an unrestricted model passes every standard spelling through", () => {
		for (const effort of ANY_REASONING_EFFORT) {
			expect(normalizeReasoningEffort(kilo("stealth/space-bunny-alpha"), effort)).toBe(
				effort,
			);
		}
	});

	// A restricted upstream 400s on an unsupported spelling, so clamping to the
	// strongest *supported* effort at or below the request preserves intent.
	test("a restricted model clamps to its own vocabulary", () => {
		const hy3 = kilo("tencent/hunyuan-hy3");
		expect(reasoningVocabulary(hy3)).toEqual(["no_think", "low", "high"]);
		expect(normalizeReasoningEffort(hy3, "max")).toBe("high");
		expect(normalizeReasoningEffort(hy3, "xhigh")).toBe("high");
		expect(normalizeReasoningEffort(hy3, "high")).toBe("high");
		expect(normalizeReasoningEffort(hy3, "medium")).toBe("low");
		expect(normalizeReasoningEffort(hy3, "low")).toBe("low");
		expect(normalizeReasoningEffort(hy3, "no_think")).toBe("no_think");
	});

	test("an unrecognised effort falls back to the strongest supported", () => {
		expect(normalizeReasoningEffort(kilo("tencent/hy3"), "ludicrous")).toBe("high");
	});

	test("the vocabulary match is case-insensitive", () => {
		expect(normalizeReasoningEffort(kilo("tencent/HY3-preview"), "xhigh")).toBe("high");
	});
});
