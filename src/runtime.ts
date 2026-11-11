// ============================================================================
// runtime.ts — shared capacity control, routing health, and observability
// ============================================================================

import type { Config } from "./config";

// ─── Metrics ─────────────────────────────────────────────────────────────────

interface ProxyMetricsSnapshot {
	requestsTotal: number;
	requestsActive: number;
	streamsActive: number;
	fallbacksTotal: number;
	streamRetriesTotal: number;
	upstreamErrorsTotal: number;
	upstreamTimeoutsTotal: number;
	rateLimitsTotal: number;
	queuedRequests: number;
	totalLatencyMs: number;
	completedRequests: number;
	/** Upstream attempts keyed by provider-qualified model ID. */
	modelRequests: Record<string, number>;
	/** Upstream responses with headers received (2xx at header phase). */
	modelSuccesses: Record<string, number>;
	/** Upstream failures keyed by provider-qualified model ID. */
	modelFailures: Record<string, number>;
	/** Upstream header-to-header latency EWMA (ms), by model. */
	modelLatencyEwmaMs: Record<string, number>;
}

/**
 * Process-wide counters. Deliberately not per-Runtime: these describe the
 * proxy, not one capacity configuration, and must survive a runtime rebuild.
 */
const metrics: ProxyMetricsSnapshot = {
	requestsTotal: 0,
	requestsActive: 0,
	streamsActive: 0,
	fallbacksTotal: 0,
	streamRetriesTotal: 0,
	upstreamErrorsTotal: 0,
	upstreamTimeoutsTotal: 0,
	rateLimitsTotal: 0,
	queuedRequests: 0,
	totalLatencyMs: 0,
	completedRequests: 0,
	modelRequests: {},
	modelSuccesses: {},
	modelFailures: {},
	modelLatencyEwmaMs: {},
};

/**
 * When each model last failed. Kept out of the exported snapshot because it is
 * an ordering input rather than a metric, and bounded like the cooldown table
 * so a rotating model catalog cannot grow it without limit.
 */
const lastFailureAt = new Map<string, number>();
/** Bounded so a catalog that rotates ids cannot grow this map forever. */
const MAX_TRACKED_MODELS = 100;

export function beginRequest(stream: boolean): () => void {
	metrics.requestsTotal++;
	metrics.requestsActive++;
	if (stream) metrics.streamsActive++;
	const started = performance.now();
	let done = false;
	return () => {
		if (done) return;
		done = true;
		metrics.requestsActive--;
		if (stream) metrics.streamsActive--;
		metrics.completedRequests++;
		metrics.totalLatencyMs += performance.now() - started;
	};
}

export function recordFallback() {
	metrics.fallbacksTotal++;
}

export function recordStreamRetry() {
	metrics.streamRetriesTotal++;
}

export function recordModelRequest(model: string) {
	metrics.modelRequests[model] = (metrics.modelRequests[model] ?? 0) + 1;
}

export function recordModelSuccess(model: string, latencyMs?: number) {
	metrics.modelSuccesses[model] = (metrics.modelSuccesses[model] ?? 0) + 1;
	if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
		const prev = metrics.modelLatencyEwmaMs[model];
		metrics.modelLatencyEwmaMs[model] =
			prev == null ? latencyMs : prev * 0.7 + latencyMs * 0.3;
	}
}

export function recordModelFailure(model: string) {
	metrics.modelFailures[model] = (metrics.modelFailures[model] ?? 0) + 1;
	// Re-insert so the map also tracks recency, then evict the oldest entry.
	lastFailureAt.delete(model);
	lastFailureAt.set(model, Date.now());
	if (lastFailureAt.size > MAX_TRACKED_MODELS) {
		const oldest = lastFailureAt.keys().next();
		if (!oldest.done) lastFailureAt.delete(oldest.value);
	}
}

export function recordUpstreamError(status?: number) {
	metrics.upstreamErrorsTotal++;
	if (status === 429) metrics.rateLimitsTotal++;
	if (status === 408 || status === 504) metrics.upstreamTimeoutsTotal++;
}

export function recordUpstreamTimeout() {
	metrics.upstreamErrorsTotal++;
	metrics.upstreamTimeoutsTotal++;
}

/** How long a failure keeps most of its weight (exponential decay constant). */
const HEALTH_DECAY_MS = 10 * 60_000;

/**
 * Pure ranking score from counters and the age of the last failure.
 *
 * Lower is healthier. Failures fade with age: without the decay, a model that
 * had one bad minute at startup stayed ranked last for the rest of the
 * process, long after the cooldown that justified it had expired. Weight
 * failures most, and include latency so consistently slow-but-working models
 * are de-prioritized among healthy alternatives.
 */
export function healthPenalty(args: {
	failures: number;
	successes: number;
	latencyMs: number;
	/**
	 * Milliseconds since the last failure. Omitted is treated as "just now", so
	 * every recorded failure counts at full weight — the conservative choice for
	 * a caller that has the counters but no timestamp.
	 */
	ageMs?: number;
}): number {
	const age = args.ageMs ?? 0;
	const failureWeight = Math.exp(-age / HEALTH_DECAY_MS);
	return (
		args.failures * failureWeight * 3 -
		args.successes +
		Math.min(30, args.latencyMs / 1000)
	);
}

/**
 * Lower is healthier. Used only as a secondary ordering hint among otherwise
 * eligible candidates (never to override cooldown, capability, or allowlist).
 */
export function modelHealthPenalty(model: string): number {
	const lastFailure = lastFailureAt.get(model);
	return healthPenalty({
		failures: metrics.modelFailures[model] ?? 0,
		successes: metrics.modelSuccesses[model] ?? 0,
		latencyMs: metrics.modelLatencyEwmaMs[model] ?? 0,
		ageMs: lastFailure === undefined ? undefined : Date.now() - lastFailure,
	});
}

export function getMetrics(): ProxyMetricsSnapshot {
	return {
		...metrics,
		modelRequests: { ...metrics.modelRequests },
		modelSuccesses: { ...metrics.modelSuccesses },
		modelFailures: { ...metrics.modelFailures },
		modelLatencyEwmaMs: { ...metrics.modelLatencyEwmaMs },
	};
}

export function prometheusMetrics(): string {
	const m = getMetrics();
	const lines = [
		"# HELP kilo_proxy_requests_total Client requests accepted.",
		"# TYPE kilo_proxy_requests_total counter",
		`kilo_proxy_requests_total ${m.requestsTotal}`,
		"# HELP kilo_proxy_requests_completed_total Client requests that ran to completion.",
		"# TYPE kilo_proxy_requests_completed_total counter",
		`kilo_proxy_requests_completed_total ${m.completedRequests}`,
		"# HELP kilo_proxy_requests_active Client requests currently in flight.",
		"# TYPE kilo_proxy_requests_active gauge",
		`kilo_proxy_requests_active ${m.requestsActive}`,
		"# HELP kilo_proxy_streams_active Streaming responses currently open.",
		"# TYPE kilo_proxy_streams_active gauge",
		`kilo_proxy_streams_active ${m.streamsActive}`,
		"# HELP kilo_proxy_queued_requests Requests waiting for a concurrency slot.",
		"# TYPE kilo_proxy_queued_requests gauge",
		`kilo_proxy_queued_requests ${m.queuedRequests}`,
		"# HELP kilo_proxy_fallbacks_total Requests served by a fallback model.",
		"# TYPE kilo_proxy_fallbacks_total counter",
		`kilo_proxy_fallbacks_total ${m.fallbacksTotal}`,
		"# HELP kilo_proxy_stream_retries_total Stream attempts retried before first byte.",
		"# TYPE kilo_proxy_stream_retries_total counter",
		`kilo_proxy_stream_retries_total ${m.streamRetriesTotal}`,
		"# HELP kilo_proxy_upstream_errors_total Upstream errors, including 200-with-error-body.",
		"# TYPE kilo_proxy_upstream_errors_total counter",
		`kilo_proxy_upstream_errors_total ${m.upstreamErrorsTotal}`,
		"# HELP kilo_proxy_upstream_timeouts_total Upstream timeout failures.",
		"# TYPE kilo_proxy_upstream_timeouts_total counter",
		`kilo_proxy_upstream_timeouts_total ${m.upstreamTimeoutsTotal}`,
		"# HELP kilo_proxy_rate_limits_total Upstream rate-limit responses.",
		"# TYPE kilo_proxy_rate_limits_total counter",
		`kilo_proxy_rate_limits_total ${m.rateLimitsTotal}`,
		// Exported as _sum plus a separate _count so avg latency is derivable
		// with rate(kilo_proxy_request_duration_ms_sum[5m]) / rate(..._count[5m]).
		// A bare running total is not aggregatable across instances.
		"# HELP kilo_proxy_request_duration_ms_sum Total client request duration in milliseconds.",
		"# TYPE kilo_proxy_request_duration_ms_sum counter",
		`kilo_proxy_request_duration_ms_sum ${m.totalLatencyMs.toFixed(3)}`,
		"# HELP kilo_proxy_request_duration_ms_count Completed client requests, for averaging.",
		"# TYPE kilo_proxy_request_duration_ms_count counter",
		`kilo_proxy_request_duration_ms_count ${m.completedRequests}`,
		"# HELP kilo_proxy_model_requests_total Upstream attempts by provider and model.",
		"# TYPE kilo_proxy_model_requests_total counter",
		...Object.entries(m.modelRequests).map(([id, count]) => {
			// Ids are provider-qualified, so the provider becomes the label and
			// the remainder (which may itself contain slashes) stays the model.
			const [provider, ...rest] = id.split("/");
			return `kilo_proxy_model_requests_total{provider="${escapeLabel(provider)}",model="${escapeLabel(rest.join("/"))}"} ${count}`;
		}),
		"# HELP kilo_proxy_model_successes_total Upstream attempts that reached a successful header response, by provider and model.",
		"# TYPE kilo_proxy_model_successes_total counter",
		...Object.entries(m.modelSuccesses).map(([id, count]) => {
			const [provider, ...rest] = id.split("/");
			return `kilo_proxy_model_successes_total{provider="${escapeLabel(provider)}",model="${escapeLabel(rest.join("/"))}"} ${count}`;
		}),
		"# HELP kilo_proxy_model_failures_total Upstream attempt failures, by provider and model.",
		"# TYPE kilo_proxy_model_failures_total counter",
		...Object.entries(m.modelFailures).map(([id, count]) => {
			const [provider, ...rest] = id.split("/");
			return `kilo_proxy_model_failures_total{provider="${escapeLabel(provider)}",model="${escapeLabel(rest.join("/"))}"} ${count}`;
		}),
		"# HELP kilo_proxy_model_latency_ewma_ms EWMA header latency for successful upstream attempts, by provider and model.",
		"# TYPE kilo_proxy_model_latency_ewma_ms gauge",
		...Object.entries(m.modelLatencyEwmaMs).map(([id, ms]) => {
			const [provider, ...rest] = id.split("/");
			return `kilo_proxy_model_latency_ewma_ms{provider="${escapeLabel(provider)}",model="${escapeLabel(rest.join("/"))}"} ${ms.toFixed(3)}`;
		}),
	];
	return `${lines.join("\n")}\n`;
}

function escapeLabel(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/"/g, '\\"');
}

// ─── Capacity ────────────────────────────────────────────────────────────────

/**
 * Bounded-concurrency gate with a bounded wait queue.
 *
 * `acquire` resolves to a release function, or to `undefined` when the caller
 * cannot be served — either the queue is full (fail fast, so a saturated proxy
 * answers 429 rather than accumulating unbounded pending work) or the caller's
 * signal aborted while it waited.
 */
export class RequestLimiter {
	private active = 0;
	private queue: Array<(release: () => void) => void> = [];

	constructor(
		private readonly maxConcurrent: number,
		private readonly maxQueue: number,
	) {}

	acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
		if (signal?.aborted) return Promise.resolve(undefined);
		if (this.active < this.maxConcurrent) return Promise.resolve(this.lease());
		if (this.queue.length >= this.maxQueue) return Promise.resolve(undefined);

		metrics.queuedRequests++;
		const { promise, resolve } = Promise.withResolvers<(() => void) | undefined>();
		let entry: ((release: () => void) => void) | null = null;

		const onAbort = () => {
			// Evict from the queue so an abandoned request does not occupy a slot
			// that a live one is waiting for.
			if (entry) {
				const idx = this.queue.indexOf(entry);
				if (idx !== -1) {
					this.queue.splice(idx, 1);
					metrics.queuedRequests--;
				}
			}
			resolve(undefined);
		};

		entry = (release) => {
			metrics.queuedRequests--;
			signal?.removeEventListener("abort", onAbort);
			// The signal may have fired between the dequeue and this call; in that
			// case hand the lease straight on rather than to a caller that is gone.
			if (signal?.aborted) {
				release();
				resolve(undefined);
			} else {
				resolve(release);
			}
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.queue.push(entry);
		return promise;
	}

	private lease(): () => void {
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.queue.shift();
			this.active--;
			// Hand the freed capacity straight to the next waiter, keeping `active`
			// constant across the transfer.
			if (next) next(this.lease());
		};
	}
}

// ─── Routing health ──────────────────────────────────────────────────────────

/**
 * Per-model cooldown after a 429/402/403/404/5xx or a timeout, so a dead model
 * is skipped instead of retried on every request. Bounded: the entry that
 * expires soonest is evicted once the table is full.
 */
export class ModelCooldowns {
	private until = new Map<string, number>();
	private static readonly MAX_ENTRIES = 100;

	constructor(private readonly cooldownMs: number) {}

	isCooling(model: string): boolean {
		const expires = this.until.get(model) ?? 0;
		if (expires <= Date.now()) {
			this.until.delete(model);
			return false;
		}
		return true;
	}

	fail(model: string, cooldownMs?: number) {
		// Re-insert so the freshest failure wins for this model, then evict the
		// entry that expires soonest once the table is full.
		this.until.delete(model);
		const ms =
			typeof cooldownMs === "number" && Number.isFinite(cooldownMs) && cooldownMs >= 0
				? cooldownMs
				: this.cooldownMs;
		this.until.set(model, Date.now() + ms);
		if (this.until.size > ModelCooldowns.MAX_ENTRIES) {
			let soonestKey: string | undefined;
			let soonestExpiry = Number.POSITIVE_INFINITY;
			for (const [key, expiry] of this.until) {
				if (expiry < soonestExpiry) {
					soonestExpiry = expiry;
					soonestKey = key;
				}
			}
			if (soonestKey !== undefined) this.until.delete(soonestKey);
		}
	}

	succeed(model: string) {
		this.until.delete(model);
	}
}

// ─── Runtime registry ────────────────────────────────────────────────────────

export interface Runtime {
	limiter: RequestLimiter;
	cooldowns: ModelCooldowns;
}

/**
 * Memoized per capacity configuration.
 *
 * Keyed on the settings that actually shape the limiter and cooldowns, so a
 * config change produces a new runtime instead of silently inheriting the
 * previous one's limits. In production there is exactly one config and this is
 * a single cached lookup; the keying exists so tests (and any future
 * reconfiguration path) get the runtime they asked for.
 */
let cachedKey = "";
let cached: Runtime | undefined;

export function getRuntime(config: Config): Runtime {
	const key = `${config.maxConcurrentRequests}:${config.maxQueuedRequests}:${config.modelCooldownMs}`;
	if (!cached || cachedKey !== key) {
		cached = {
			limiter: new RequestLimiter(config.maxConcurrentRequests, config.maxQueuedRequests),
			cooldowns: new ModelCooldowns(config.modelCooldownMs),
		};
		cachedKey = key;
	}
	return cached;
}

/** Drop the memoized runtime so the next getRuntime() rebuilds it. */
export function resetRuntimeForTests(): void {
	cached = undefined;
	cachedKey = "";
}
