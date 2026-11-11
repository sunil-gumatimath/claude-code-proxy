#!/usr/bin/env bun
/**
 * Report-only check: compare the live Kilo gateway catalog against the
 * `free: true` set in src/providers.ts CAPABILITIES.
 *
 * Usage:
 *   bun run catalog:check
 *   bun run scripts/check-catalog.ts -- --base-url=https://api.kilo.ai/api/gateway
 *
 * Env: KILO_BASE_URL, KILO_API_KEY (optional; some gateways allow unauthenticated /models)
 *
 * Exit: 0 when no drift detected (or catalog unreachable with --allow-unreachable),
 *       1 when drift is detected.
 */

import { freeModelIds } from "../src/providers";

type CatalogModel = {
	id?: string;
	/** Authoritative free-tier flag published by the gateway. */
	isFree?: boolean;
	pricing?: { prompt?: string | number; completion?: string | number; request?: string | number };
	supported_parameters?: string[];
	architecture?: { input_modalities?: string[]; modality?: string };
	[key: string]: unknown;
};

function arg(name: string): string | undefined {
	const prefix = `--${name}=`;
	for (const a of Bun.argv.slice(2)) if (a.startsWith(prefix)) return a.slice(prefix.length);
	return undefined;
}

function hasFlag(name: string): boolean {
	const flag = `--${name}`;
	return [...Bun.argv.slice(2), ...process.argv.slice(2)].includes(flag);
}

function priceIsZero(v: string | number | undefined): boolean {
	if (v === undefined || v === null || v === "") return false;
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) && n === 0;
}

function looksFreeById(id: string): boolean {
	return id.endsWith(":free") || id.endsWith("-free");
}

function isZeroCost(m: CatalogModel): boolean {
	// Conservative: require both prompt and completion to be explicitly zero when present.
	// Some $0/stealth models may not expose obvious pricing; id heuristics help but are not sufficient alone.
	const p = m.pricing;
	if (p && priceIsZero(p.prompt) && priceIsZero(p.completion)) return true;
	return false;
}

/**
 * Whether the gateway itself calls this model free.
 *
 * The catalog publishes an explicit `isFree` boolean and that is the field the
 * gateway bills against, so it is preferred over inferring from `pricing`.
 * Inferring produced false positives — the `google/lyria-*` music endpoints are
 * $0 but accept no tool calls — and would miss a free model whose pricing
 * block is shaped differently. Pricing stays as the fallback for a catalog
 * response that omits the flag.
 */
function isFreeCatalogModel(m: CatalogModel): boolean {
	if (typeof m.isFree === "boolean") return m.isFree;
	return isZeroCost(m);
}

function supportsTools(m: CatalogModel): boolean | undefined {
	const sp = m.supported_parameters;
	if (Array.isArray(sp)) {
		return sp.some((p) => p === "tools" || p === "tool_choice" || p === "functions");
	}
	return undefined;
}

function supportsVision(m: CatalogModel): boolean | undefined {
	const mods = m.architecture?.input_modalities;
	if (Array.isArray(mods)) return mods.includes("image");
	return undefined;
}

async function main() {
	const baseUrl = (
		arg("base-url") ||
		Bun.env.KILO_BASE_URL ||
		"https://api.kilo.ai/api/gateway"
	).replace(/\/+$/, "");
	const url = `${baseUrl}/models`;
	const headers: Record<string, string> = {};
	const key = Bun.env.KILO_API_KEY;
	if (key) headers.Authorization = `Bearer ${key}`;

	console.log(`Fetching catalog: ${url}`);
	let json: unknown;
	try {
		const res = await fetch(url, { headers });
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.error(`HTTP ${res.status} from /models ${body.slice(0, 200)}`);
			process.exit(hasFlag("allow-unreachable") ? 0 : 1);
		}
		json = await res.json();
	} catch (err) {
		console.error(`Failed to fetch catalog: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(hasFlag("allow-unreachable") ? 0 : 1);
	}

	const raw = Array.isArray(json)
		? json
		: Array.isArray((json as any)?.data)
			? (json as any).data
			: [];
	const models = raw as CatalogModel[];
	const byId = new Map<string, CatalogModel>();
	for (const m of models) if (m?.id) byId.set(String(m.id), m);

	const knownFree = new Set(freeModelIds());
	const catalogZero = new Set<string>();
	for (const [id, m] of byId) {
		// Trust the gateway's flag; fall back to pricing only when it is absent.
		if (isFreeCatalogModel(m) || (looksFreeById(id) && knownFree.has(id))) {
			catalogZero.add(id);
		}
	}

	const missingInCapabilities = [...catalogZero]
		.filter((id) => !knownFree.has(`kilo/${id}`) && !knownFree.has(id))
		.sort();
	// Our CAPABILITIES are provider-qualified (kilo/...). Normalize catalog ids for comparison.
	const catalogIdsNormalized = new Set([...byId.keys()].map((id) => (id.startsWith("kilo/") ? id : `kilo/${id}`)));
	const retiredOrRepriced = [...knownFree]
		.filter((id) => {
			const bare = id.replace(/^kilo\//, "");
			if (!byId.has(bare) && !byId.has(id)) return true;
			const m = byId.get(bare) ?? byId.get(id);
			if (!m) return true;
			// The gateway's own flag wins; pricing is the fallback when it is absent.
			if (typeof m.isFree === "boolean") return !m.isFree;
			if (m.pricing && !isZeroCost(m)) return true;
			return false;
		})
		.sort();

	console.log("");
	console.log(`Catalog models: ${models.length}`);
	console.log(`Known free in CAPABILITIES: ${knownFree.size}`);
	console.log(`Detected free in catalog (isFree flag): ${[...byId.values()].filter(isFreeCatalogModel).length}`);
	console.log("");

	let drift = false;
	if (missingInCapabilities.length) {
		drift = true;
		console.log("Catalog $0 models missing from CAPABILITIES (review, then add if stable):");
		for (const id of missingInCapabilities) console.log(`  - ${id}`);
		console.log("");
	}
	if (retiredOrRepriced.length) {
		drift = true;
		console.log("CAPABILITIES free models missing from catalog or no longer $0-priced (review):");
		for (const id of retiredOrRepriced) console.log(`  - ${id}`);
		console.log("");
	}

	// Capability hints (best-effort; catalog schemas vary)
	const hints: string[] = [];
	for (const id of knownFree) {
		const bare = id.replace(/^kilo\//, "");
		const m = byId.get(bare) ?? byId.get(id);
		if (!m) continue;
		const t = supportsTools(m);
		const v = supportsVision(m);
		if (t === false) hints.push(`${id}: catalog suggests tools not supported`);
		// vision=false in catalog is not definitive; skip noisy hints.
		void v;
	}
	if (hints.length) {
		console.log("Capability hints (best-effort):");
		for (const h of hints) console.log(`  - ${h}`);
		console.log("");
	}

	if (!drift) {
		console.log("No drift detected between the catalog's free set and CAPABILITIES.");
		console.log("Note: when the catalog omits `isFree`, zero-pricing detection is used, which can misread audio/image endpoints as usable free models.");
		process.exit(0);
	}
	console.log("Drift detected (report-only). Update src/providers.ts CAPABILITIES/config defaults/docs as needed, then run bun run check.");
	process.exit(1);
}

await main();
