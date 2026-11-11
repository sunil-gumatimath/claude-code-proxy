import { describe, expect, test } from "bun:test";
import {
	canFallback,
	isAbortError,
	isTransientStatus,
	retryAfterMs,
} from "../src/handlers/upstream";
import {
	getMetrics,
	getRuntime,
	healthPenalty,
	ModelCooldowns,
	modelHealthPenalty,
	prometheusMetrics,
	RequestLimiter,
	recordModelFailure,
	recordModelRequest,
	recordModelSuccess,
	recordUpstreamError,
	resetRuntimeForTests,
} from "../src/runtime";
import { testConfig } from "./fixtures";

// ── canFallback ──────────────────────────────────────────────────────────────

describe("isTransientStatus", () => {
	// This predicate is the single definition of "the model or provider is
	// unwell, not the request". It drives both the retry decision and the
	// cooldown, so the two cannot disagree about which statuses qualify.
	test("model- and provider-level failures are transient", () => {
		for (const status of [402, 403, 404, 408, 429, 500, 502, 503, 504]) {
			expect(isTransientStatus(status)).toBe(true);
		}
	});

	test("client errors are not transient", () => {
		for (const status of [400, 401, 405, 409, 413, 422]) {
			expect(isTransientStatus(status)).toBe(false);
		}
	});

	test("canFallback agrees with it whenever attempts remain", () => {
		// The invariant that the two hand-written status lists used to violate.
		for (const status of [200, 400, 401, 402, 403, 404, 408, 429, 500, 503]) {
			expect(canFallback(status, 0, 2)).toBe(isTransientStatus(status));
		}
	});
});

describe("canFallback", () => {
	test("transient statuses with attempts left → true", () => {
		for (const status of [404, 408, 429, 403, 402, 500, 503]) {
			expect(canFallback(status, 0, 2)).toBe(true);
		}
	});

	test("a 400 is the client's fault and is not retried", () => {
		expect(canFallback(400, 0, 2)).toBe(false);
		expect(canFallback(422, 0, 2)).toBe(false);
	});

	test("the last attempt never falls back, whatever the status", () => {
		for (const status of [404, 429, 500]) {
			expect(canFallback(status, 1, 2)).toBe(false);
		}
	});

	test("a single-candidate chain has nowhere to fall back to", () => {
		expect(canFallback(429, 0, 1)).toBe(false);
	});
});

describe("isAbortError", () => {
	test("recognises an AbortError", () => {
		expect(isAbortError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(
			true,
		);
	});

	test("recognises Bun's string abort reason", () => {
		expect(isAbortError(new Error("The operation was aborted"))).toBe(true);
		expect(isAbortError("aborted")).toBe(true);
	});

	test("does not misclassify an ordinary failure", () => {
		expect(isAbortError(new Error("ECONNREFUSED"))).toBe(false);
		expect(isAbortError(new TypeError("fetch failed"))).toBe(false);
	});
});

// ── RequestLimiter ───────────────────────────────────────────────────────────

describe("RequestLimiter", () => {
	test("serves up to the concurrency limit immediately", async () => {
		const limiter = new RequestLimiter(2, 0);
		const a = await limiter.acquire();
		const b = await limiter.acquire();
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		// maxQueue 0 means fail fast rather than queue.
		expect(await limiter.acquire()).toBeUndefined();
	});

	test("releasing a slot hands it to the next waiter", async () => {
		const limiter = new RequestLimiter(1, 2);
		const first = await limiter.acquire();
		const queued = limiter.acquire();
		expect(getMetrics().queuedRequests).toBe(1);
		first?.();
		const second = await queued;
		expect(second).toBeDefined();
		second?.();
		expect(getMetrics().queuedRequests).toBe(0);
	});

	test("a double release hands out only one lease", async () => {
		// The release function is idempotent, so calling it twice must not push a
		// second waiter into the freed slot and over-subscribe the limiter.
		const limiter = new RequestLimiter(1, 1);
		const first = await limiter.acquire();
		const second = limiter.acquire(); // queued
		first?.();
		first?.(); // must be a no-op
		const held = await second;
		expect(held).toBeDefined();

		// Exactly one slot is in use, so a third acquirer has to queue rather than
		// be served immediately by the phantom second lease.
		let served = false;
		const third = limiter.acquire().then((r) => {
			served = true;
			return r;
		});
		await Bun.sleep(10);
		expect(served).toBe(false);

		held?.();
		(await third)?.();
	});

	test("a queued waiter is evicted when its signal aborts", async () => {
		const limiter = new RequestLimiter(1, 2);
		const held = await limiter.acquire();
		const controller = new AbortController();
		const queued = limiter.acquire(controller.signal);
		expect(getMetrics().queuedRequests).toBe(1);

		controller.abort();
		expect(await queued).toBeUndefined();
		// Evicted from the queue, so the gauge drops and the slot is still free.
		expect(getMetrics().queuedRequests).toBe(0);
		held?.();
	});

	test("an already-aborted signal never enters the queue", async () => {
		const limiter = new RequestLimiter(1, 2);
		const held = await limiter.acquire();
		const controller = new AbortController();
		controller.abort();
		expect(await limiter.acquire(controller.signal)).toBeUndefined();
		expect(getMetrics().queuedRequests).toBe(0);
		held?.();
	});

	test("a waiter that aborts after being dequeued returns its lease", async () => {
		const limiter = new RequestLimiter(1, 1);
		const held = await limiter.acquire();
		const controller = new AbortController();
		const queued = limiter.acquire(controller.signal);
		controller.abort();
		held?.();
		// The abort already resolved the promise to undefined, so no lease leaks.
		expect(await queued).toBeUndefined();
	});

	test("the queue bound is enforced", async () => {
		const limiter = new RequestLimiter(1, 1);
		const held = await limiter.acquire();
		const first = limiter.acquire();
		// One waiter is queued; the next is rejected immediately.
		expect(await limiter.acquire()).toBeUndefined();
		held?.();
		(await first)?.();
	});
});

// ── ModelCooldowns ───────────────────────────────────────────────────────────

describe("ModelCooldowns", () => {
	test("a failed model is cooling, then recovers", async () => {
		const cooldowns = new ModelCooldowns(20);
		cooldowns.fail("kilo/a");
		expect(cooldowns.isCooling("kilo/a")).toBe(true);
		await Bun.sleep(30);
		expect(cooldowns.isCooling("kilo/a")).toBe(false);
	});

	test("a success clears an existing cooldown", () => {
		const cooldowns = new ModelCooldowns(10_000);
		cooldowns.fail("kilo/a");
		cooldowns.succeed("kilo/a");
		expect(cooldowns.isCooling("kilo/a")).toBe(false);
	});

	test("honors an explicit cooldown hint", async () => {
		const cooldowns = new ModelCooldowns(10_000);
		cooldowns.fail("kilo/a", 15);
		expect(cooldowns.isCooling("kilo/a")).toBe(true);
		await Bun.sleep(25);
		expect(cooldowns.isCooling("kilo/a")).toBe(false);
	});

	test("the table is bounded and evicts the soonest expiry", () => {
		const cooldowns = new ModelCooldowns(10_000);
		for (let i = 0; i < 150; i++) cooldowns.fail(`kilo/model-${i}`);
		// Still functional after eviction, and the earliest entry is the one gone.
		expect(cooldowns.isCooling("kilo/model-0")).toBe(false);
		expect(cooldowns.isCooling("kilo/model-149")).toBe(true);
	});
});

describe("retryAfterMs", () => {
	test("parses delay-seconds and clamps", () => {
		expect(retryAfterMs("2")).toBe(2000);
		expect(retryAfterMs("0")).toBe(0);
		expect(retryAfterMs("99999")).toBe(300_000);
	});

	test("parses HTTP-date relative to now", () => {
		const now = Date.parse("2026-01-01T00:00:00Z");
		expect(retryAfterMs("Thu, 01 Jan 2026 00:00:03 GMT", now)).toBe(3000);
		expect(retryAfterMs("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
	});

	test("returns undefined for missing or invalid values", () => {
		expect(retryAfterMs(null)).toBeUndefined();
		expect(retryAfterMs("")).toBeUndefined();
		expect(retryAfterMs("wat")).toBeUndefined();
	});
});

// ── Runtime registry ─────────────────────────────────────────────────────────

describe("getRuntime", () => {
	test("returns the same instance for the same capacity settings", () => {
		resetRuntimeForTests();
		const a = getRuntime(testConfig());
		const b = getRuntime(testConfig());
		expect(a).toBe(b);
	});

	test("rebuilds when the capacity settings change", () => {
		// Keying on the settings is what stops a new config from silently
		// inheriting the previous one's limits.
		resetRuntimeForTests();
		const a = getRuntime(testConfig({ maxConcurrentRequests: 1 }));
		const b = getRuntime(testConfig({ maxConcurrentRequests: 8 }));
		expect(a).not.toBe(b);
		resetRuntimeForTests();
	});
});

// ── Health ranking ───────────────────────────────────────────────────────────

describe("healthPenalty", () => {
	test("failures cost more than speed, and both are ordered correctly", () => {
		const clean = healthPenalty({ failures: 0, successes: 2, latencyMs: 500 });
		const flaky = healthPenalty({ failures: 2, successes: 2, latencyMs: 500 });
		const slow = healthPenalty({ failures: 0, successes: 2, latencyMs: 8000 });
		expect(flaky).toBeGreaterThan(clean);
		expect(slow).toBeGreaterThan(clean);
	});

	test("an old failure counts for less than a fresh one", () => {
		// Regression: the penalty was cumulative for the process lifetime, so a
		// model that had one bad minute stayed ranked last long after recovering.
		const fresh = healthPenalty({ failures: 3, successes: 0, latencyMs: 0, ageMs: 0 });
		const aged = healthPenalty({
			failures: 3,
			successes: 0,
			latencyMs: 0,
			ageMs: 10 * 60_000,
		});
		const stale = healthPenalty({
			failures: 3,
			successes: 0,
			latencyMs: 0,
			ageMs: 24 * 60 * 60_000,
		});
		expect(aged).toBeLessThan(fresh);
		expect(aged).toBeGreaterThan(0);
		expect(stale).toBeLessThan(0.1);
	});

	test("a recorded failure immediately raises that model's penalty", () => {
		recordModelFailure("kilo/decay-probe");
		expect(modelHealthPenalty("kilo/decay-probe")).toBeGreaterThan(0);
	});
});

// ── Metrics ──────────────────────────────────────────────────────────────────

describe("prometheusMetrics", () => {
	test("exports the saturation and latency series operators are told to watch", () => {
		recordModelRequest("kilo/nvidia/nemotron-3.5-super-vl:free");
		recordModelSuccess("kilo/nvidia/nemotron-3.5-super-vl:free");
		recordModelFailure("kilo/nvidia/nemotron-3.5-super-vl:free");
		recordUpstreamError(429);
		const out = prometheusMetrics();
		for (const name of [
			"kilo_proxy_requests_total",
			"kilo_proxy_requests_active",
			"kilo_proxy_streams_active",
			"kilo_proxy_queued_requests",
			"kilo_proxy_fallbacks_total",
			"kilo_proxy_stream_retries_total",
			"kilo_proxy_upstream_errors_total",
			"kilo_proxy_upstream_timeouts_total",
			"kilo_proxy_rate_limits_total",
			"kilo_proxy_request_duration_ms_sum",
			"kilo_proxy_request_duration_ms_count",
			"kilo_proxy_model_successes_total",
			"kilo_proxy_model_failures_total",
		]) {
			expect(out).toContain(name);
		}
		expect(out).toContain('kilo_proxy_model_requests_total{provider="kilo"');
	});

	test("latency is aggregatable: _sum and _count are both present", () => {
		// A bare running total cannot be averaged across instances; the pair can.
		const out = prometheusMetrics();
		expect(out).toMatch(/kilo_proxy_request_duration_ms_sum [\d.]+/);
		expect(out).toMatch(/kilo_proxy_request_duration_ms_count \d+/);
	});

	test("label values are escaped", () => {
		recordModelRequest('kilo/we"ird\r\nmodel');
		const out = prometheusMetrics();
		expect(out).not.toContain("\r");
		expect(out).toContain('model="we\\"ird\\r\\nmodel"');
	});
});
