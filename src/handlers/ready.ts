// ============================================================================
// handlers/ready.ts — readiness probe: key present, upstream reachable
// ============================================================================

import type { Config } from "../config";
import { getProvider } from "../providers";

type UpstreamCheck = "ok" | "unauthorized" | "unreachable" | "skipped";

interface ReadyBody {
	status: "ready" | "degraded";
	checks: {
		kilo_key: boolean;
		qwen_key: boolean;
		upstream: UpstreamCheck;
	};
	/** Model a request that omits `model` would land on. */
	model: string;
	checked_at: string;
}

const CACHE_MS = 30_000;
let cache: { key: string; at: number; body: ReadyBody; code: number } | undefined;

/** Drop the memoized probe (tests, and any future reconfiguration path). */
export function resetReadyCacheForTests(): void {
	cache = undefined;
}

/**
 * GET /ready — distinguishes "the process is up" from "it can serve a turn".
 *
 * `/health` is liveness only: it keeps answering `ok` with a revoked key or an
 * unreachable gateway, which is exactly when Claude Code fails while the proxy
 * looks healthy. This probes the configured upstream once per CACHE_MS and
 * answers 503 when a turn cannot succeed, so a dead credential is one curl away
 * instead of a debugging session.
 *
 * The probe hits `/models` rather than sending a completion: it costs no tokens,
 * and a 401/403 still proves the gateway itself is reachable.
 */
export async function handleReady(config: Config, now = Date.now()): Promise<Response> {
	const provider = getProvider(config, "kilo");
	const key = `${provider.baseUrl}:${Boolean(provider.apiKey)}`;
	if (cache && cache.key === key && now - cache.at < CACHE_MS) {
		return json(cache.body, cache.code);
	}

	const body: ReadyBody = {
		status: "degraded",
		checks: {
			kilo_key: Boolean(provider.apiKey),
			qwen_key: Boolean(config.qwenApiKey),
			upstream: "skipped",
		},
		model: config.defaultModel,
		checked_at: new Date(now).toISOString(),
	};

	// With no credential anywhere the proxy cannot forward anything, and there
	// is nothing to probe.
	if (!body.checks.kilo_key && !body.checks.qwen_key) {
		return json(body, 503);
	}

	if (body.checks.kilo_key) {
		body.checks.upstream = await probe(provider.baseUrl, provider.apiKey);
		if (body.checks.upstream === "ok") body.status = "ready";
	}

	const code = body.status === "ready" ? 200 : 503;
	cache = { key, at: now, body, code };
	return json(body, code);
}

async function probe(baseUrl: string, apiKey: string): Promise<UpstreamCheck> {
	try {
		const res = await fetch(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			// A readiness probe must not hang the caller: 3s is enough for a
			// gateway to answer headers.
			signal: AbortSignal.timeout(3000),
		});
		if (res.ok) return "ok";
		// The gateway answered and rejected the credential.
		if (res.status === 401 || res.status === 403) return "unauthorized";
		return "unreachable";
	} catch {
		return "unreachable";
	}
}

function json(body: ReadyBody, status: number): Response {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
