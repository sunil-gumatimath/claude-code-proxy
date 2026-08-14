import type { Config } from "./config";

// ============================================================================
// runtime.ts — shared routing health, capacity control, and observability
// ============================================================================

export interface ProxyMetricsSnapshot {
	requestsTotal: number;
	requestsActive: number;
	streamsActive: number;
	fallbacksTotal: number;
	upstreamErrorsTotal: number;
	rateLimitsTotal: number;
	queuedRequests: number;
	totalLatencyMs: number;
	/** Upstream attempts keyed by provider-qualified model ID. */
	modelRequests: Record<string, number>;
}

const metrics: ProxyMetricsSnapshot = {
	requestsTotal: 0,
	requestsActive: 0,
	streamsActive: 0,
	fallbacksTotal: 0,
	upstreamErrorsTotal: 0,
	rateLimitsTotal: 0,
	queuedRequests: 0,
	totalLatencyMs: 0,
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
	return (
		[
			"# HELP kilo_proxy_requests_total Total completed and active client requests started.",
			"# TYPE kilo_proxy_requests_total counter",
			`kilo_proxy_requests_total ${m.requestsTotal}`,
			"# HELP kilo_proxy_requests_active Active client requests.",
			"# TYPE kilo_proxy_requests_active gauge",
			`kilo_proxy_requests_active ${m.requestsActive}`,
			"# HELP kilo_proxy_streams_active Active streaming responses.",
			"# TYPE kilo_proxy_streams_active gauge",
			`kilo_proxy_streams_active ${m.streamsActive}`,
			"# HELP kilo_proxy_fallbacks_total Upstream model fallback attempts.",
			"# TYPE kilo_proxy_fallbacks_total counter",
			`kilo_proxy_fallbacks_total ${m.fallbacksTotal}`,
			"# HELP kilo_proxy_upstream_errors_total Upstream errors.",
			"# TYPE kilo_proxy_upstream_errors_total counter",
			`kilo_proxy_upstream_errors_total ${m.upstreamErrorsTotal}`,
			"# HELP kilo_proxy_rate_limits_total Upstream rate-limit responses.",
			"# TYPE kilo_proxy_rate_limits_total counter",
			`kilo_proxy_rate_limits_total ${m.rateLimitsTotal}`,
			"# HELP kilo_proxy_model_requests_total Upstream attempts by provider and model.",
			"# TYPE kilo_proxy_model_requests_total counter",
			...Object.entries(m.modelRequests).map(([model, count]) => {
				const [provider, ...parts] = model.split("/");
				return `kilo_proxy_model_requests_total{provider="${escapePrometheusLabel(provider)}",model="${escapePrometheusLabel(parts.join("/"))}"} ${count}`;
			}),
		].join("\n") + "\n"
	);
}

function escapePrometheusLabel(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export class RequestLimiter {
	private active = 0;
	private queue: Array<(release: () => void) => void> = [];

	constructor(
		private readonly maxConcurrent: number,
		private readonly maxQueue: number,
	) {}

	acquire(): Promise<(() => void) | undefined> {
		if (this.active < this.maxConcurrent) return Promise.resolve(this.lease());
		if (this.queue.length >= this.maxQueue) return Promise.resolve(undefined);
		metrics.queuedRequests++;
		return new Promise((resolve) => {
			this.queue.push((release) => {
				metrics.queuedRequests--;
				resolve(release);
			});
		});
	}

	private lease(): () => void {
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.queue.shift();
			this.active--;
			if (next) next(this.lease());
		};
	}
}

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
		this.until.set(model, Date.now() + this.cooldownMs);
		// Guard against unbounded growth: evict oldest entry when over capacity.
		if (this.until.size > ModelCooldowns.MAX_ENTRIES) {
			const oldest = this.until.keys().next();
			if (!oldest.done) this.until.delete(oldest.value);
		}
	}
	succeed(model: string) {
		this.until.delete(model);
	}
}

let _limiter: RequestLimiter | undefined;
let _cooldowns: ModelCooldowns | undefined;

export function getRuntime(config: Config) {
	if (!_limiter) {
		_limiter = new RequestLimiter(
			config.maxConcurrentRequests,
			config.maxQueuedRequests,
		);
		_cooldowns = new ModelCooldowns(config.modelCooldownMs);
	}
	return { limiter: _limiter, cooldowns: _cooldowns as ModelCooldowns };
}
