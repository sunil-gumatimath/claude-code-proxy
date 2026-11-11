// ============================================================================
// tests/wide.test.ts — opt-in wide-event drain
// ============================================================================

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvlogDrain } from "../src/config";
import { testConfig } from "./fixtures";

// config.ts is imported for the parser only; the module under test is wide.ts,
// which is imported inside the tests so the "disabled" case runs against a
// process where initWideEvents has never been called.
const {
	emitWide,
	initWideEvents,
	resetWideEventsForTests,
	startWide,
	wideEventsEnabled,
} = await import("../src/wide");

let dir = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "evlog-test-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Files the drain wrote, if any. */
function logFiles(): string[] {
	try {
		return [...new Bun.Glob("*.jsonl").scanSync({ cwd: dir })];
	} catch {
		return [];
	}
}

describe("wide events", () => {
	test("EVLOG_DRAIN only accepts file/fs, and stays off otherwise", () => {
		expect(parseEvlogDrain("file")).toBe("file");
		expect(parseEvlogDrain("  FS ")).toBe("file");
		expect(parseEvlogDrain("")).toBe("");
		expect(parseEvlogDrain(undefined)).toBe("");
		// A destination we do not implement must not be guessed at.
		expect(parseEvlogDrain("axiom")).toBe("");
	});

	test("disabled: no handle, nothing written", () => {
		resetWideEventsForTests();
		expect(wideEventsEnabled()).toBe(false);
		// Callers use `handle?.set(...)`, so the default configuration must not
		// cost an object allocation per request.
		expect(startWide({ requestId: "req_off" })).toBeUndefined();
		emitWide({ requestId: "req_off", status: 200 });
		expect(logFiles()).toEqual([]);
	});

	test("enabled: one NDJSON line per turn, credentials redacted", async () => {
		initWideEvents(testConfig({ evlogDrain: "file", evlogDir: dir, evlogMaxFiles: 3 }));
		expect(wideEventsEnabled()).toBe(true);

		const handle = startWide({ requestId: "req_on", requestModel: "claude-sonnet-4-6" });
		expect(handle).toBeDefined();
		handle?.set({
			routedModel: "kilo/nvidia/nemotron-3.5-lightning:free",
			stream: true,
			status: 200,
			outcome: "complete",
			inputTokens: 1200,
			outputTokens: 34,
			latencyMs: 812,
			note: "leaked sk-abcdefghijklmnopqrstuvwxyz",
		});
		handle?.emit();
		// A second emit (and any later set) is a no-op, not a second record.
		handle?.set({ late: true });
		handle?.emit();

		// The fs drain batches, so give it a tick to flush.
		await Bun.sleep(150);

		const files = logFiles();
		expect(files.length).toBe(1);
		const lines = (await Bun.file(join(dir, files[0]!)).text())
			.split("\n")
			.filter((line) => line.trim());
		const event = JSON.parse(lines[0]!);

		expect(event.requestId).toBe("req_on");
		expect(event.routedModel).toBe("kilo/nvidia/nemotron-3.5-lightning:free");
		expect(event.inputTokens).toBe(1200);
		expect(event.outputTokens).toBe(34);
		expect(event.latencyMs).toBe(812);
		expect(event.outcome).toBe("complete");
		// The secret must not survive into the log file.
		expect(JSON.stringify(event)).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(event.note).toContain("[REDACTED]");
	});

	test("a second init is ignored rather than re-pointing the drain", () => {
		initWideEvents(testConfig({ evlogDrain: "file", evlogDir: join(dir, "other") }));
		expect(wideEventsEnabled()).toBe(true);
		expect(logFiles().length).toBe(1);
	});
});
