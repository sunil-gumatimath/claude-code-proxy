import { describe, expect, test } from "bun:test";
import { handleStream, SseFrameDecoder } from "../src/handlers/stream";

// ── SseFrameDecoder ──────────────────────────────────────────────────────────

describe("SseFrameDecoder", () => {
	test("dispatches a single-line data frame", () => {
		const d = new SseFrameDecoder();
		expect(d.push('data: {"a":1}\n\n', 1024)).toEqual(['{"a":1}']);
	});

	test("joins a multi-line data frame with newlines", () => {
		// The event-stream grammar concatenates data lines within one frame. A
		// line-at-a-time reader keeps only the first and drops the rest.
		const d = new SseFrameDecoder();
		expect(d.push("data: line1\ndata: line2\ndata: line3\n\n", 1024)).toEqual([
			"line1\nline2\nline3",
		]);
	});

	test("holds a partial frame until it is terminated", () => {
		const d = new SseFrameDecoder();
		expect(d.push('data: {"a"', 1024)).toEqual([]);
		expect(d.push(":1}\n", 1024)).toEqual([]);
		expect(d.push("\n", 1024)).toEqual(['{"a":1}']);
	});

	test("flush dispatches a frame that never got its blank line", () => {
		// Upstreams routinely close without the trailing newline; that frame must
		// not be silently dropped.
		const d = new SseFrameDecoder();
		expect(d.push('data: {"a":1}', 1024)).toEqual([]);
		expect(d.flush()).toEqual(['{"a":1}']);
	});

	test("flush on an empty decoder yields nothing", () => {
		expect(new SseFrameDecoder().flush()).toEqual([]);
	});

	test("skips comments and keep-alive heartbeats", () => {
		const d = new SseFrameDecoder();
		expect(d.push(": keep-alive\n\n", 1024)).toEqual([]);
		expect(d.push(":\n\n", 1024)).toEqual([]);
	});

	test("ignores fields other than data", () => {
		const d = new SseFrameDecoder();
		expect(d.push("event: ping\nid: 7\nretry: 100\n\n", 1024)).toEqual([]);
	});

	test("a comment between data lines does not split the frame", () => {
		const d = new SseFrameDecoder();
		expect(d.push("data: a\n: heartbeat\ndata: b\n\n", 1024)).toEqual(["a\nb"]);
	});

	test("tolerates CRLF line endings", () => {
		const d = new SseFrameDecoder();
		expect(d.push('data: {"a":1}\r\n\r\n', 1024)).toEqual(['{"a":1}']);
	});

	test("strips exactly one leading space after the colon", () => {
		const d = new SseFrameDecoder();
		expect(d.push("data:  two-spaces\n\n", 1024)).toEqual([" two-spaces"]);
		expect(d.push("data:no-space\n\n", 1024)).toEqual(["no-space"]);
	});

	test("a bare data: line with no value dispatches nothing", () => {
		const d = new SseFrameDecoder();
		expect(d.push("data:\n\n", 1024)).toEqual([]);
		expect(d.push("data: \n\n", 1024)).toEqual([]);
	});

	test("consecutive frames are all dispatched", () => {
		const d = new SseFrameDecoder();
		expect(d.push("data: one\n\ndata: two\n\ndata: three\n\n", 1024)).toEqual([
			"one",
			"two",
			"three",
		]);
	});

	test("a frame split across many chunks reassembles", () => {
		const d = new SseFrameDecoder();
		const payload = 'data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n';
		const out: string[] = [];
		for (const ch of payload) out.push(...d.push(ch, 1024));
		expect(out).toHaveLength(1);
		expect(JSON.parse(out[0])).toBeTruthy();
	});

	test("rejects an unbounded trailing line", () => {
		const d = new SseFrameDecoder();
		expect(() => d.push(`data: ${"x".repeat(200)}`, 64)).toThrow(/exceeded maximum size/);
	});

	test("rejects an unbounded frame assembled across many chunks", () => {
		// The bound covers the frame under assembly, not just one line, so an
		// attacker cannot get around it by sending many small data lines.
		const d = new SseFrameDecoder();
		expect(() => {
			for (let i = 0; i < 20; i++) d.push(`data: ${"x".repeat(50)}\n`, 64);
		}).toThrow(/exceeded maximum size/);
	});

	test("a frame that fits is not rejected, and its counter resets after dispatch", () => {
		const d = new SseFrameDecoder();
		// Two frames of ~40 bytes each pass a 64-byte bound only if the counter
		// is reset on dispatch.
		d.push(`data: ${"x".repeat(40)}\n\n`, 64);
		expect(() => d.push(`data: ${"x".repeat(40)}\n\n`, 64)).not.toThrow();
	});

	test("the size check measures bytes, not UTF-16 units", () => {
		// A 3-byte character is 1 UTF-16 unit; a byte-based bound catches it.
		const d = new SseFrameDecoder();
		expect(() => d.push(`data: ${"世".repeat(30)}`, 64)).toThrow(/exceeded maximum size/);
	});
});

// ── handleStream ─────────────────────────────────────────────────────────────

function pump(chunks: string[], idleTimeoutMs = 5000) {
	const encoder = new TextEncoder();
	const upstream = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const c of chunks) controller.enqueue(encoder.encode(c));
				controller.close();
			},
		}),
		{ status: 200 },
	);
	const state = { cleaned: 0 };
	const res = handleStream(upstream, {
		model: "m",
		requestId: "req_test",
		startTime: performance.now(),
		upstreamController: new AbortController(),
		cleanup: () => {
			state.cleaned++;
		},
		idleTimeoutMs,
	});
	return { res, state };
}

async function drain(res: Response): Promise<string> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let acc = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		acc += decoder.decode(value, { stream: true });
	}
	return acc;
}

describe("handleStream", () => {
	test("translates a text stream and closes cleanly", async () => {
		const { res, state } = pump([
			'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const out = await drain(res);
		expect(out).toContain("message_start");
		expect(out).toContain("text_delta");
		expect(out).toContain("Hi");
		expect(out).toContain("message_stop");
		expect(out).toContain("end_turn");
		expect(state.cleaned).toBe(1);
	});

	test("sets x-request-id for client-side correlation", () => {
		const { res } = pump(["data: [DONE]\n\n"]);
		expect(res.headers.get("x-request-id")).toBe("req_test");
		expect(res.headers.get("content-type")).toContain("text/event-stream");
	});

	test("cleanup runs exactly once, even with a mid-stream error", async () => {
		const { res, state } = pump(['data: {"error":{"message":"stream boom"}}\n\n']);
		const out = await drain(res);
		expect(out).toContain("event: error");
		expect(out).toContain("stream boom");
		expect(state.cleaned).toBe(1);
	});

	test("emits a valid minimal message when the upstream has no body", async () => {
		const upstream = new Response(null, { status: 200 });
		const state = { cleaned: 0 };
		const res = handleStream(upstream, {
			model: "m",
			requestId: "r",
			startTime: performance.now(),
			upstreamController: new AbortController(),
			cleanup: () => {
				state.cleaned++;
			},
		});
		const out = await drain(res);
		expect(out).toContain("message_start");
		expect(out).toContain("message_stop");
		expect(state.cleaned).toBe(1);
	});

	test("a final frame with no trailing newline is still delivered", async () => {
		const { res } = pump(['data: {"choices":[{"delta":{"content":"tail"}}]}']);
		const out = await drain(res);
		expect(out).toContain("tail");
	});

	test("a stalled stream is reported and releases its slot", async () => {
		// Headers arrive, one chunk flows, then the upstream goes silent forever.
		// Without the per-read deadline this pinned a concurrency slot for good.
		const encoder = new TextEncoder();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const upstream = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
					);
					void gate;
				},
			}),
			{ status: 200 },
		);
		const state = { cleaned: 0 };
		const res = handleStream(upstream, {
			model: "m",
			requestId: "r",
			startTime: performance.now(),
			upstreamController: new AbortController(),
			cleanup: () => {
				state.cleaned++;
			},
			idleTimeoutMs: 100,
		});

		const out = await Promise.race([drain(res), Bun.sleep(3000)]);
		release();
		expect(out).toContain("event: error");
		expect(out).toContain("stalled");
		expect(state.cleaned).toBe(1);
	});

	test("client cancellation aborts the upstream and cleans up once", async () => {
		const encoder = new TextEncoder();
		const controller = new AbortController();
		let aborted = false;
		controller.signal.addEventListener("abort", () => {
			aborted = true;
		});
		const upstream = new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
				},
			}),
			{ status: 200 },
		);
		const state = { cleaned: 0 };
		const res = handleStream(upstream, {
			model: "m",
			requestId: "r",
			startTime: performance.now(),
			upstreamController: controller,
			cleanup: () => {
				state.cleaned++;
			},
		});
		await res.body!.cancel();
		expect(aborted).toBe(true);
		expect(state.cleaned).toBe(1);
	});
});

// ── Failover before the first byte ───────────────────────────────────────────

const encoder = new TextEncoder();

/** An attempt whose body delivers `text` and then closes normally. */
function goodAttempt(text: string, onDetach?: () => void) {
	return {
		response: new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(
						encoder.encode(
							`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n` +
								'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
								"data: [DONE]\n\n",
						),
					);
					c.close();
				},
			}),
			{ status: 200 },
		),
		controller: new AbortController(),
		detach: () => onDetach?.(),
	};
}

/** An attempt whose body fails before emitting anything. */
function brokenAttempt(message = "upstream reset") {
	return {
		response: new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					c.error(new Error(message));
				},
			}),
			{ status: 200 },
		),
		controller: new AbortController(),
		detach: () => {},
	};
}

describe("handleStream — failover before first byte", () => {
	test("an attempt that fails before any content is replaced transparently", async () => {
		let retries = 0;
		let firstDetached = 0;
		let cleanupCount = 0;
		const failures: string[] = [];

		const res = handleStream(brokenAttempt().response, {
			model: "m",
			requestId: "r",
			startTime: performance.now(),
			upstreamController: new AbortController(),
			cleanup: () => {
				cleanupCount++;
			},
			detach: () => {
				firstDetached++;
			},
			onUpstreamFailure: (reason) => failures.push(reason),
			retry: async () => {
				retries++;
				return goodAttempt("second");
			},
		});

		const out = await drain(res);
		expect(retries).toBe(1);
		expect(out).toContain("second");
		expect(out).toContain("message_stop");
		expect(out).not.toContain("event: error");
		// Exactly one message_start: a retried attempt must not open a second one.
		expect(out.split("message_start").length - 1).toBe(2); // event: + data:
		expect(failures).toHaveLength(1);
		expect(firstDetached).toBe(1);
		expect(cleanupCount).toBe(1);
	});

	test("no retry once content has reached the client", async () => {
		let retries = 0;
		// pull-based so the content chunk is actually delivered before the error:
		// controller.error() immediately after enqueue discards the queued chunk.
		let step = 0;
		const failing = new Response(
			new ReadableStream<Uint8Array>({
				pull(c) {
					if (step++ === 0) {
						c.enqueue(
							encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
						);
					} else {
						c.error(new Error("reset mid-stream"));
					}
				},
			}),
			{ status: 200 },
		);

		const res = handleStream(failing, {
			model: "m",
			requestId: "r",
			startTime: performance.now(),
			upstreamController: new AbortController(),
			cleanup: () => {},
			retry: async () => {
				retries++;
				return goodAttempt("second");
			},
		});

		const out = await drain(res);
		expect(retries).toBe(0);
		expect(out).toContain("partial");
		expect(out).toContain("event: error");
		expect(out).not.toContain("second");
	});

	test("a stall before the first byte also fails over", async () => {
		// Headers arrive, the body never produces anything. The idle deadline fires
		// and the next candidate should be tried rather than failing the turn.
		const silent = new Response(
			new ReadableStream<Uint8Array>({
				start() {
					/* never enqueues, never closes */
				},
			}),
			{ status: 200 },
		);

		const res = handleStream(silent, {
			model: "m",
			requestId: "r",
			startTime: performance.now(),
			upstreamController: new AbortController(),
			cleanup: () => {},
			idleTimeoutMs: 60,
			retry: async () => goodAttempt("rescued"),
		});

		const out = await Promise.race([drain(res), Bun.sleep(3000)]);
		expect(out).toContain("rescued");
		expect(out).not.toContain("event: error");
	});

	test("a stall after content is reported and does not retry", async () => {
		let retries = 0;
		let failures = 0;
		const stalled = stallingResponse();
		const res = handleStream(stalled.response, {
			model: "m",
			requestId: "r",
			startTime: performance.now(),
			upstreamController: new AbortController(),
			cleanup: () => {},
			idleTimeoutMs: 60,
			onUpstreamFailure: () => {
				failures++;
			},
			retry: async () => {
				retries++;
				return goodAttempt("second");
			},
		});

		const out = await Promise.race([drain(res), Bun.sleep(3000)]);
		stalled.release();
		expect(out).toContain("event: error");
		expect(out).toContain("stalled");
		expect(retries).toBe(0);
		// A stalled model is as unhealthy as a bad status, so it must be cooled.
		expect(failures).toBe(1);
	});
});

/** Emits one chunk, then never ends (released by the caller). */
function stallingResponse() {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
				void gate;
			},
		}),
		{ status: 200 },
	);
	return { response, release };
}
