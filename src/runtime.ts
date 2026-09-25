// ============================================================================
// runtime.ts — shared capacity control, routing health, and observability
// ============================================================================

import type { Config } from "./config";

// ─── Metrics ─────────────────────────────────────────────────────────────────

export interface ProxyMetricsSnapshot {
	requestsTotal: number;
	requestsActive: number;
	streamsActive: number;
	fallbacksTotal: number;
	upstreamErrorsTotal: number;
	rateLimitsTotal: number;
	queuedRequests: number;
	totalLatencyMs: number;
	completedRequests: number;
	/** Upstream attempts keyed by provider-qualified model ID. */
	modelRequests: Record<string, number>;
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
	upstreamErrorsTotal: 0,
	rateLimitsTotal: 0,
	queuedRequests: 0,
	totalLatencyMs: 0,
	completedRequests: 0,
	modelRequests: {},
};

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

export function recordModelRequest(model: string) {
	metrics.modelRequests[model] = (metrics.modelRequests[model] ?? 0) + 1;
}

export function recordUpstreamError(status?: number) {
	metrics.upstreamErrorsTotal++;
	if (status === 429) metrics.rateLimitsTotal++;
}

export function getMetrics(): ProxyMetricsSnapshot {
	return { ...metrics, modelRequests: { ...metrics.modelRequests } };
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
		"# HELP kilo_proxy_upstream_errors_total Upstream errors, including 200-with-error-body.",
		"# TYPE kilo_proxy_upstream_errors_total counter",
		`kilo_proxy_upstream_errors_total ${m.upstreamErrorsTotal}`,
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

	fail(model: string) {
		// Re-insert so Map iteration order stays ordered by failure time, not
		// first-seen time, before evicting whichever entry expires soonest.
		this.until.delete(model);
		this.until.set(model, Date.now() + this.cooldownMs);
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

/** Zero the process counters. Test-only; production counters are cumulative. */
export function resetMetricsForTests(): void {
	metrics.requestsTotal = 0;
	metrics.requestsActive = 0;
	metrics.streamsActive = 0;
	metrics.fallbacksTotal = 0;
	metrics.upstreamErrorsTotal = 0;
	metrics.rateLimitsTotal = 0;
	metrics.queuedRequests = 0;
	metrics.totalLatencyMs = 0;
	metrics.completedRequests = 0;
	metrics.modelRequests = {};
}
