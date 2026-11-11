// ============================================================================
// server.ts — HTTP routing, CORS, and process lifecycle
// ============================================================================

import type { Server } from "bun";
import { isAuthorized } from "./auth";
import { type Config, isLoopbackHost } from "./config";
import { anthropicError } from "./errors";
import { handleCountTokens, handleMessages } from "./handlers/messages";
import { handleReady } from "./handlers/ready";
import { banner, colors, log, setDebug, warn } from "./log";
import { getCapabilities, maxOutputTokens, parseTarget } from "./providers";
import { getMetrics, prometheusMetrics } from "./runtime";
import { NAME, VERSION } from "./version";
import { initWideEvents } from "./wide";

const { cyan, green, dim, bold, yellow, red } = colors;

/** Frozen once so /v1/models does not report a new creation time on every call. */
const MODELS_CREATED_AT = Math.floor(Date.now() / 1000);

type RouteHandler = (
	req: Request,
	config: Config,
	server: Server<unknown>,
) => Promise<Response> | Response;

interface Route {
	method: string;
	/** Canonical path, no trailing slash; matching tolerates one. */
	path: string;
	handler: RouteHandler;
	/**
	 * Operational routes are loopback-gated (or key-gated) because they expose
	 * the proxy's identity, its upstream target, and its traffic counters. The
	 * data plane is not gated — see warnOnNonLoopbackBind for why that is a
	 * documented trade rather than an oversight.
	 */
	operational: boolean;
	/** Adds CORS headers when the request origin is allowlisted. */
	cors: boolean;
}

export function createServer(config: Config): Server<unknown> {
	setDebug(config.debug);
	initWideEvents(config);
	assertSafeBind(config);

	const routes: Route[] = [
		{
			method: "GET",
			path: "/",
			operational: true,
			cors: true,
			handler: (_req, cfg) =>
				Response.json(
					{
						status: "ok",
						proxy: NAME,
						version: VERSION,
						target: cfg.kiloBaseUrl,
						uptime_s: Math.floor(process.uptime()),
					},
					{ headers: { "Cache-Control": "no-store" } },
				),
		},
		{ method: "GET", path: "/health", operational: true, cors: true, handler: health },
		{ method: "GET", path: "/healthz", operational: true, cors: true, handler: health },
		{
			method: "GET",
			path: "/version",
			operational: true,
			cors: true,
			handler: () => Response.json({ name: NAME, version: VERSION }),
		},
		{
			// Readiness, not liveness: 503 when no key is configured or the
			// gateway cannot be reached, which `/health` would happily call ok.
			method: "GET",
			path: "/ready",
			operational: true,
			cors: true,
			handler: (_req, cfg) => handleReady(cfg),
		},
		{
			method: "GET",
			path: "/v1/models",
			operational: true,
			cors: true,
			handler: (_req, cfg) =>
				Response.json({
					object: "list",
					data: [
						...new Set([
							...cfg.allowedModels,
							...cfg.fallbackModels,
							...cfg.modelAliases.map((alias) => alias.model),
						]),
					].map((id) => {
						// Expose what the proxy already knows about each id, so a client
						// can pick sensibly instead of discovering 400s at request time.
						const target = parseTarget(id);
						const caps = getCapabilities(target);
						return {
							id,
							object: "model",
							created: MODELS_CREATED_AT,
							owned_by: NAME,
							context_length: caps.contextLength ?? null,
							max_output_tokens: maxOutputTokens(target),
							supports_tools: caps.tools,
							supports_vision: caps.vision,
							free: caps.free,
						};
					}),
				}),
		},
		{
			method: "GET",
			path: "/metrics",
			operational: true,
			cors: true,
			handler: () =>
				new Response(prometheusMetrics(), {
					headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
				}),
		},
		{
			method: "GET",
			path: "/dashboard",
			operational: true,
			cors: true,
			handler: () =>
				new Response(dashboardHtml(), {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				}),
		},
		{
			method: "GET",
			path: "/dashboard.json",
			operational: true,
			cors: true,
			handler: () => Response.json(getMetrics()),
		},
		{
			method: "POST",
			path: "/v1/messages",
			operational: false,
			cors: true,
			handler: (req, cfg, server) => {
				announceRemoteUse(server.requestIP?.(req)?.address);
				return handleMessages(req, cfg);
			},
		},
		{
			method: "POST",
			path: "/v1/messages/count_tokens",
			operational: false,
			cors: true,
			handler: (req, cfg) => handleCountTokens(req, cfg),
		},
	];

	// Group by path so a wrong verb can be answered with 405 + Allow rather than
	// a 404 that reads as "this proxy has no such endpoint".
	const byPath = new Map<string, Route[]>();
	for (const route of routes) {
		const list = byPath.get(route.path) ?? [];
		list.push(route);
		byPath.set(route.path, list);
	}

	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		maxRequestBodySize: config.maxBodyBytes,
		// Bun's maximum, so a legitimately long stream is not cut off.
		idleTimeout: 255,

		async fetch(req: Request): Promise<Response> {
			let url: URL;
			try {
				url = new URL(req.url);
			} catch {
				return anthropicError(400, "invalid_request_error", "Malformed request URL.");
			}

			// Preflight is answered before routing and without auth: browsers do not
			// send credentials on a preflight, and the reply carries no data.
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders(req, config) });
			}

			const path = normalizePath(url.pathname);
			const candidates = byPath.get(path);

			if (!candidates) {
				return withCors(
					anthropicError(
						404,
						"not_found_error",
						`Unknown route: ${req.method} ${url.pathname}`,
					),
					req,
					config,
				);
			}

			const route = candidates.find((r) => r.method === req.method);
			if (!route) {
				const allow = [...new Set(candidates.map((r) => r.method))].sort();
				return withCors(
					anthropicError(
						405,
						"invalid_request_error",
						`${req.method} is not allowed on ${path}.`,
						{
							allow: allow.join(", "),
						},
					),
					req,
					config,
				);
			}

			if (route.operational) {
				const denied = requireOperationalAuth(req, config, server);
				if (denied) return withCors(denied, req, config);
			}

			try {
				const res = await route.handler(req, config, server);
				// withCors rebuilds the Response around the same body stream, so a
				// streaming response is neither buffered nor truncated here.
				return route.cors ? withCors(res, req, config) : res;
			} catch (err) {
				// Route handlers map their own failures; reaching here means
				// something threw outside that contract.
				const msg = err instanceof Error ? err.message : String(err);
				log(`${red("✗")} Unhandled route error on ${path}: ${msg}`);
				return withCors(
					anthropicError(500, "api_error", "Internal server error"),
					req,
					config,
				);
			}
		},

		error(err) {
			log(`${red("✗")} Unhandled server error: ${err.message}`);
			return anthropicError(500, "api_error", "Internal server error");
		},
	});

	printBanner(config);
	warnOnNonLoopbackBind(config);
	warnOnUnusableDefault(config);
	setupGracefulShutdown(server);

	return server;
}

function health(): Response {
	return Response.json({ status: "ok" });
}

// ── Routing helpers ──────────────────────────────────────────────────────────

/** Strip a single trailing slash so `/health/` and `/health` route alike. */
function normalizePath(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
	return pathname;
}

function corsHeaders(req: Request, config: Config): Record<string, string> {
	const origin = req.headers.get("origin");
	// Browsers are opt-in. Do not reflect arbitrary origins when this process has
	// access to a configured upstream key.
	if (!origin || !config.corsAllowedOrigins.includes(origin)) return {};
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers":
			"Content-Type, Authorization, x-api-key, x-proxy-api-key, anthropic-version, anthropic-beta, x-request-id",
		"Access-Control-Max-Age": "600",
		Vary: "Origin",
	};
}

/**
 * Gate the endpoints that expose the proxy's identity, upstream target, or
 * traffic counters.
 *
 * Order matters: a configured PROXY_API_KEY is always required, loopback or
 * not. Without one, the check reads the real socket peer address rather than
 * the `Host` header, so a spoofed header gains nothing, and a request URL that
 * fails to parse is denied rather than assumed local.
 */
function requireOperationalAuth(
	req: Request,
	config: Config,
	server?: Server<unknown>,
): Response | undefined {
	if (config.proxyApiKey) {
		return isAuthorized(req, config.proxyApiKey)
			? undefined
			: anthropicError(401, "authentication_error", "Invalid proxy API key.");
	}

	const socketIp = server?.requestIP?.(req)?.address;
	if (socketIp) return isLoopbackHost(socketIp) ? undefined : remoteDenied();

	// No socket address is exposed (e.g. an in-process test invocation), so fall
	// back to the request URL. An unparseable URL is not proof of loopback
	// origin, so deny rather than fall through: fail closed.
	try {
		return isLoopbackHost(new URL(req.url).hostname) ? undefined : remoteDenied();
	} catch {
		return anthropicError(400, "invalid_request_error", "Malformed request URL.");
	}
}

function remoteDenied(): Response {
	return anthropicError(
		401,
		"authentication_error",
		"Set PROXY_API_KEY to access operational endpoints over the network.",
	);
}

function withCors(res: Response, req: Request, config: Config): Response {
	const cors = corsHeaders(req, config);
	if (!Object.keys(cors).length) return res;
	const headers = new Headers(res.headers);
	for (const [key, value] of Object.entries(cors)) headers.set(key, value);
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}

// ── Startup diagnostics ──────────────────────────────────────────────────────

/**
 * Refuse the only genuinely dangerous default: a non-loopback bind with no
 * PROXY_API_KEY. POST /v1/messages is the data plane and is intentionally not
 * loopback-restricted (single-user local adapter UX), so binding it beyond
 * localhost without a key would publish an unauthenticated relay on the
 * operator's upstream key. The unsafe case is still possible, but only via an
 * explicit opt-in: ALLOW_UNAUTHENTICATED_REMOTE=true.
 *
 * Runs before Bun.serve() binds the port.
 */
function assertSafeBind(config: Config): void {
	if (isLoopbackHost(config.host)) return;
	if (config.proxyApiKey || config.allowUnauthenticatedRemote) return;
	throw new Error(
		`Refusing to bind on ${config.host} without PROXY_API_KEY: POST /v1/messages would be reachable without authentication and could spend your upstream key. ` +
			"Set PROXY_API_KEY, or set ALLOW_UNAUTHENTICATED_REMOTE=true only on a trusted network where you accept that risk.",
	);
}

/**
 * Announce a non-loopback bind. The unauthenticated case is unreachable here
 * unless the operator explicitly opted in (assertSafeBind enforces that), but
 * the warning still applies: the data plane is reachable from other machines.
 */
function warnOnNonLoopbackBind(config: Config): void {
	if (isLoopbackHost(config.host)) return;
	warn(
		`Bound on ${config.host} — reachable from other machines. Operational endpoints stay loopback-only, but POST /v1/messages does not.`,
	);
	if (!config.proxyApiKey) {
		warn(
			"ALLOW_UNAUTHENTICATED_REMOTE=true with no PROXY_API_KEY: POST /v1/messages is reachable without authentication. Use only on a trusted network.",
		);
	}
}

/**
 * Warn when the primary can never be served. Without this the failure only
 * surfaces at the first request as "Model is not permitted", which reads like a
 * client bug rather than a stale `.env`.
 */
function warnOnUnusableDefault(config: Config): void {
	if (config.allowedModels.includes(config.defaultModel)) return;
	warn(
		`DEFAULT_MODEL ${config.defaultModel} is not in ALLOWED_MODELS: any request that omits a model will be rejected. Add it to ALLOWED_MODELS or change DEFAULT_MODEL.`,
	);
}

let remoteUseAnnounced = false;

/** Warn once per process, the first time a non-local peer reaches the data plane. */
function announceRemoteUse(socketIp: string | undefined): void {
	if (remoteUseAnnounced || !socketIp || isLoopbackHost(socketIp)) return;
	remoteUseAnnounced = true;
	warn(
		`Serving POST /v1/messages to non-loopback peer ${socketIp}. If that is not expected, set PROXY_API_KEY.`,
	);
}

function printBanner(config: Config) {
	const exposed = !isLoopbackHost(config.host);
	const defaultAllowed = config.allowedModels.includes(config.defaultModel);
	banner([
		bold(`  ⚡ ${NAME} v${VERSION}`),
		"",
		`  ${dim("Listen:")}        ${cyan(`http://${config.host}:${config.port}`)}`,
		`  ${dim("Target:")}        ${cyan(config.kiloBaseUrl)}`,
		`  ${dim("Model prefix:")}  ${cyan(`"${config.modelPrefix}"`)}`,
		`  ${dim("Default:")}       ${cyan(config.defaultModel)} ${
			defaultAllowed ? green("✓ allowlisted") : red("✗ NOT allowlisted")
		}`,
		`  ${dim("API key:")}       ${
			config.kiloApiKey ? green("✓ from KILO_API_KEY") : dim("⚠ from request headers")
		}`,
		`  ${dim("Upstream TO:")}   ${cyan(`${config.upstreamTimeoutMs}ms`)}`,
		`  ${dim("Max body:")}      ${cyan(formatBytes(config.maxBodyBytes))}`,
		`  ${dim("Debug:")}         ${config.debug ? green("ON") : dim("off")}`,
		`  ${dim("Wide events:")}   ${wideEventStatus(config)}`,
		"",
		exposed
			? `  ${yellow("⚠ Non-loopback bind")} — POST /v1/messages is reachable from the network${
					config.proxyApiKey ? " (key-protected)" : " and UNAUTHENTICATED"
				}`
			: `  ${dim("Bound localhost-only (set PROXY_HOST=0.0.0.0 to change)")}`,
		`  ${green("Ready")} → http://${exposed ? "localhost" : config.host}:${config.port}/v1/messages`,
	]);
}

/** Banner text for the two independent wide-event switches. */
function wideEventStatus(config: Config): string {
	const sinks = [
		config.evlogDrain === "file" ? `file → ${config.evlogDir}` : "",
		config.evlogPretty ? "terminal" : "",
	].filter(Boolean);
	return sinks.length ? green(sinks.join(" + ")) : dim("off");
}

function formatBytes(n: number): string {
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)}MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
	return `${n}B`;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

/**
 * Static HTML that polls /dashboard.json. Values are written with
 * textContent and joined via replaceChildren, never innerHTML, so a metric
 * value can never be interpreted as markup.
 */
function dashboardHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${NAME} dashboard</title>
<style>
  body{margin:0;padding:40px;background:#101216;color:#eef2f7;font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:900px}
  h1{margin:0 0 4px;font-size:24px}
  .muted{color:#9aa4b2;margin:0 0 24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
  .card{background:#191d24;border:1px solid #2b313c;border-radius:10px;padding:16px}
  .value{font-size:28px;font-weight:700;margin-top:8px;font-variant-numeric:tabular-nums}
</style>
</head>
<body>
  <h1>${NAME}</h1>
  <p class="muted">Live runtime metrics · refreshes every 2s</p>
  <div id="grid" class="grid"></div>
<script>
const LABELS = {
  requestsTotal: "Requests",
  requestsActive: "Active requests",
  streamsActive: "Active streams",
  queuedRequests: "Queued requests",
  fallbacksTotal: "Fallbacks",
  upstreamErrorsTotal: "Upstream errors",
  rateLimitsTotal: "Rate limits",
  totalLatencyMs: "Total latency (ms)"
};
const grid = document.getElementById("grid");
async function load() {
  let m;
  try {
    m = await fetch("/dashboard.json", { cache: "no-store" }).then((r) => r.json());
  } catch {
    grid.textContent = "metrics unavailable";
    return;
  }
  grid.replaceChildren(...Object.entries(LABELS).map(([key, label]) => {
    const card = document.createElement("div");
    card.className = "card";
    const caption = document.createElement("div");
    caption.className = "muted";
    caption.textContent = label;
    const value = document.createElement("div");
    value.className = "value";
    value.textContent = String(m[key] ?? 0);
    card.append(caption, value);
    return card;
  }));
}
load();
setInterval(load, 2000);
</script>
</body>
</html>`;
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

function setupGracefulShutdown(server: Server<unknown>): void {
	let shuttingDown = false;

	const shutdown = (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		log(`Shutting down (${signal})…`);
		try {
			// force=false lets in-flight responses finish; the timer below is the
			// backstop for a stream that never ends.
			server.stop(false);
		} catch {
			/* already stopped */
		}
		const timer = setTimeout(() => process.exit(0), 5000);
		timer.unref?.();
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}
