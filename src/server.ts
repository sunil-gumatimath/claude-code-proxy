// ============================================================================
// server.ts — HTTP server (routing + lifecycle)
// ============================================================================

import type { Server } from "bun";
import type { Config } from "./config";
import { anthropicError } from "./errors";
import { handleCountTokens, handleMessages, isAuthorized } from "./handlers/messages";
import { colors, banner, log, setDebug } from "./log";
import { getMetrics, prometheusMetrics } from "./runtime";
import { NAME, VERSION } from "./version";

const { cyan, green, dim, bold, yellow } = colors;

export function createServer(config: Config) {
  setDebug(config.debug);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: config.maxBodyBytes,
    idleTimeout: 255, // max allowed by Bun (seconds) for long streams
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // CORS preflight (optional clients)
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(req, config),
        });
      }

      if (
        req.method === "GET" &&
        (url.pathname === "/" ||
          url.pathname === "/health" ||
          url.pathname === "/healthz")
      ) {
        return Response.json(
          {
            status: "ok",
            proxy: NAME,
            version: VERSION,
            target: config.kiloBaseUrl,
            uptime_s: Math.floor(process.uptime()),
          },
          {
            headers: {
              "Cache-Control": "no-store",
              ...corsHeaders(req, config),
            },
          }
        );
      }

      if (req.method === "GET" && url.pathname === "/version") {
        const denied = requireOperationalAuth(req, config, server);
        if (denied) return withCors(denied, req, config);
        return Response.json(
          { name: NAME, version: VERSION },
          { headers: { "Cache-Control": "no-store" } }
        );
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const denied = requireOperationalAuth(req, config, server);
        if (denied) return withCors(denied, req, config);
        const models = [...new Set([
          ...config.allowedModels,
          ...config.fallbackModels,
          ...config.modelAliases.map((alias) => alias.model),
        ])];
        return Response.json(
          {
            object: "list",
            data: models.map((id) => ({
              id,
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: "claude-code-proxy",
            })),
          },
          { headers: { "Cache-Control": "no-store", ...corsHeaders(req, config) } }
        );
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        const denied = requireOperationalAuth(req, config, server);
        if (denied) return withCors(denied, req, config);
        return new Response(prometheusMetrics(), {
          headers: {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders(req, config),
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/dashboard") {
        const denied = requireOperationalAuth(req, config, server);
        if (denied) return withCors(denied, req, config);
        return new Response(dashboardHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(req, config) },
        });
      }

      if (req.method === "GET" && url.pathname === "/dashboard.json") {
        const denied = requireOperationalAuth(req, config, server);
        if (denied) return withCors(denied, req, config);
        return Response.json(getMetrics(), { headers: { "Cache-Control": "no-store", ...corsHeaders(req, config) } });
      }

      if (
        req.method === "POST" &&
        url.pathname === "/v1/messages/count_tokens"
      ) {
        return withCors(await handleCountTokens(req, config), req, config);
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const res = await handleMessages(req, config);
        return withCors(res, req, config);
      }

      return anthropicError(
        404,
        "not_found_error",
        `Unknown route: ${req.method} ${url.pathname}`
      );
    },

    error(err) {
      log(`${colors.red("✗")} Unhandled server error: ${err.message}`);
      return anthropicError(500, "api_error", "Internal server error");
    },
  });

  printBanner(config);
  setupGracefulShutdown(server);

  return server;
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
      "Content-Type, Authorization, x-api-key, x-proxy-api-key, anthropic-version, anthropic-beta",
    Vary: "Origin",
  };
}

function requireOperationalAuth(
	req: Request,
	config: Config,
	server?: Server<unknown>,
): Response | undefined {
	// When a proxy key is configured it is always required — localhost or not.
	if (config.proxyApiKey) {
		return isAuthorized(req, config.proxyApiKey)
			? undefined
			: anthropicError(401, "authentication_error", "Invalid proxy API key.");
	}
	// If running under Bun.serve, inspect the real socket IP address to prevent
	// Host-header spoofing. Fall back to parsed URL hostname only when no socket IP
	// is exposed (e.g. in-memory test invocations).
	const socketIp = server?.requestIP?.(req)?.address;
	if (socketIp) {
		const loopback =
			socketIp === "127.0.0.1" ||
			socketIp === "::1" ||
			socketIp === "::ffff:127.0.0.1" ||
			socketIp === "localhost";
		if (!loopback) {
			return anthropicError(
				401,
				"authentication_error",
				"Set PROXY_API_KEY to access operational endpoints over the network.",
			);
		}
		return undefined;
	}

	const host = new URL(req.url).hostname;
	const loopback =
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host === "[::1]";
	if (!loopback) {
		return anthropicError(
			401,
			"authentication_error",
			"Set PROXY_API_KEY to access operational endpoints over the network.",
		);
	}
	return undefined;
}

function withCors(res: Response, req: Request, config: Config): Response {
  const cors = corsHeaders(req, config);
  if (!Object.keys(cors).length) return res;
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function printBanner(config: Config) {
  banner([
    bold(`  ⚡ ${NAME} v${VERSION}`),
    "",
    `  ${dim("Listen:")}        ${cyan(`http://${config.host}:${config.port}`)}`,
    `  ${dim("Target:")}        ${cyan(config.kiloBaseUrl)}`,
    `  ${dim("Model prefix:")}  ${cyan(`"${config.modelPrefix}"`)}`,
    `  ${dim("API key:")}       ${
      config.kiloApiKey
        ? green("✓ from KILO_API_KEY")
        : dim("⚠ from request headers")
    }`,
    `  ${dim("Upstream TO:")}   ${cyan(`${config.upstreamTimeoutMs}ms`)}`,
    `  ${dim("Max body:")}      ${cyan(formatBytes(config.maxBodyBytes))}`,
    `  ${dim("Debug:")}         ${config.debug ? green("ON") : dim("off")}`,
    "",
    config.host === "0.0.0.0" || config.host === "::"
      ? `  ${yellow("⚠ Bound on all interfaces — do not expose without auth")}`
      : `  ${dim("Bound localhost-only (set PROXY_HOST=0.0.0.0 to change)")}`,
    `  ${green("Ready")} → http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}/v1/messages`,
  ]);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function dashboardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kilo Proxy</title>
  <style>body{margin:40px;background:#101216;color:#eef2f7;font:16px system-ui;max-width:850px}h1{margin-bottom:4px}.muted{color:#9aa4b2}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:24px}.card{background:#191d24;border:1px solid #2b313c;border-radius:10px;padding:16px}.value{font-size:28px;font-weight:700;margin-top:8px}@media(max-width:600px){.grid{grid-template-columns:1fr}}</style>
  </head><body><h1>⚡ Kilo Proxy</h1><p class="muted">Live runtime metrics · refreshes every 2 seconds</p><div id="grid" class="grid"></div>
  <script>const labels={requestsTotal:'Requests',requestsActive:'Active requests',streamsActive:'Active streams',fallbacksTotal:'Fallbacks',upstreamErrorsTotal:'Upstream errors',rateLimitsTotal:'Rate limits',queuedRequests:'Queued requests'};async function load(){const m=await fetch('/dashboard.json').then(r=>r.json());document.querySelector('#grid').innerHTML=Object.entries(labels).map(([k,l])=>'<div class="card"><div class="muted">'+l+'</div><div class="value">'+m[k]+'</div></div>').join('')}load();setInterval(load,2000)</script></body></html>`;
}

function setupGracefulShutdown(server: Server<unknown>) {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down (${signal})…`);
    try {
      server.stop(false);
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      process.exit(0);
    }, 5000);
    timer.unref?.();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
