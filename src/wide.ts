// ============================================================================
// wide.ts — opt-in wide events (evlog) for machine-readable turn records
// ============================================================================
//
// Off by default. Two independent switches:
//   EVLOG_DRAIN=file  → one NDJSON line per turn that an agent can read
//   EVLOG_PRETTY=true → render each turn as a styled block in the terminal
//
// The default (both off) leaves console behaviour untouched: initLogger runs
// `silent`, so evlog owns only the drain and src/log.ts keeps owning stdout.
//
// A handle is taken when the request arrives and emitted when the turn ends.
// That placement is deliberate: evlog times an event from logger creation, so
// creating it at emit time would report a ~1ms turn in the header of a turn
// that actually took seconds.

import { createLogger, initLogger } from "evlog";
import { createFsDrain } from "evlog/fs";
import type { Config } from "./config";
import { redact } from "./log";

/** A wide event is a flat bag of context, emitted once per request. */
export type WideFields = Record<string, unknown>;

/** Collect context during a request, then emit it once. */
export interface WideHandle {
	/** Ignored after emit: a sealed logger would only warn. */
	set(fields: WideFields): void;
	/** Idempotent, and never throws. */
	emit(): void;
}

let active = false;

/**
 * Start the drain. Safe to call on every boot: with both switches off this is
 * a no-op, and a second call after a successful init is ignored so the global
 * logger is never re-pointed at a different destination.
 */
export function initWideEvents(config: Config): void {
	if (active) return;
	const toFile = config.evlogDrain === "file";
	if (!toFile && !config.evlogPretty) return;
	initLogger({
		// `silent` is what keeps stdout as log.ts prints it; pretty output needs
		// the console, so the two move together.
		silent: !config.evlogPretty,
		pretty: config.evlogPretty,
		...(toFile
			? {
					drain: createFsDrain({
						dir: config.evlogDir,
						pretty: false,
						maxFiles: config.evlogMaxFiles,
					}),
				}
			: {}),
	});
	active = true;
}

export function wideEventsEnabled(): boolean {
	return active;
}

/** Drop the module state so a test can re-initialise against a temp dir. */
export function resetWideEventsForTests(): void {
	active = false;
}

/**
 * Begin a wide event. Returns undefined when disabled, so callers can use
 * `handle?.set(...)` and pay nothing in the default configuration.
 */
export function startWide(initial: WideFields = {}): WideHandle | undefined {
	if (!active) return undefined;

	let log: ReturnType<typeof createLogger>;
	try {
		log = createLogger(sanitizeFields(initial));
	} catch {
		return undefined;
	}

	let emitted = false;
	return {
		set(fields) {
			if (emitted) return;
			try {
				log.set(sanitizeFields(fields));
			} catch {
				/* observability must never fail a turn */
			}
		},
		emit() {
			if (emitted) return;
			emitted = true;
			try {
				log.emit();
			} catch {
				/* observability must never fail a turn */
			}
		},
	};
}

/** Start and emit in one step, for a caller that already has every field. */
export function emitWide(fields: WideFields): void {
	startWide(fields)?.emit();
}

/**
 * Redact credential-shaped strings and cap their length, so a wide event can
 * never become the place a key or a whole prompt body is persisted to disk.
 * Handles the two shapes used here: flat fields and one nested object level.
 */
function sanitizeFields(fields: WideFields): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		out[key] = sanitizeValue(value, 0);
	}
	return out;
}

function sanitizeValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return redact(value).slice(0, 500);
	if (value === null || typeof value !== "object") return value;
	if (depth >= 2) return "[…]";
	if (Array.isArray(value))
		return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
	const nested: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (item === undefined) continue;
		nested[key] = sanitizeValue(item, depth + 1);
	}
	return nested;
}
