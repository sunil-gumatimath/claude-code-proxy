// ============================================================================
// handlers/stream.ts — OpenAI SSE → Anthropic SSE pump
// ============================================================================

import { anthropicErrorSse } from "../errors";
import { colors, error, log } from "../log";
import { StreamTranslator } from "../translate";

/**
 * Incremental SSE frame decoder.
 *
 * Follows the event-stream grammar rather than treating each line as a whole
 * event: `data:` lines accumulate into a frame and are dispatched, newline-
 * joined, on the blank line that terminates the frame. That is what makes a
 * multi-line frame survive intact — a line-at-a-time reader silently keeps
 * only the first `data:` line and drops the rest of the payload. The `[DONE]`
 * sentinel is passed through as an ordinary payload so the translator, not
 * this class, decides what it means.
 */
export class SseFrameDecoder {
	private buffer = "";
	private dataLines: string[] = [];
	/** Byte size of `dataLines`, tracked incrementally to keep the check linear. */
	private frameBytes = 0;

	/**
	 * Feed decoded text and return the payloads of any frames it completed.
	 * `maxBytes` bounds both the unparsed tail and the frame under assembly, so
	 * a single pathological line cannot grow without limit.
	 */
	push(text: string, maxBytes: number): string[] {
		this.buffer += text;
		const payloads: string[] = [];

		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			const payload = this.consumeLine(line);
			if (payload !== undefined) payloads.push(payload);
			newline = this.buffer.indexOf("\n");
		}

		// One check per chunk rather than per line: the tail is a partial line
		// and the frame counter is already exact, so this stays O(chunk) and is
		// always measured in bytes (a UTF-16 length under-counts multi-byte
		// content, letting an oversized frame through).
		if (this.bufferedBytes() > maxBytes) {
			throw new Error(`SSE stream frame exceeded maximum size of ${maxBytes} bytes`);
		}
		return payloads;
	}

	/**
	 * Flush at end of stream. Upstreams routinely close without the final blank
	 * line, so a frame still under assembly must be dispatched rather than lost.
	 */
	flush(): string[] {
		const payloads: string[] = [];
		if (this.buffer) {
			const payload = this.consumeLine(this.buffer);
			this.buffer = "";
			if (payload !== undefined) payloads.push(payload);
		}
		const pending = this.takeFrame();
		if (pending !== undefined) payloads.push(pending);
		return payloads;
	}

	/**
	 * Consume one complete line. Returns the frame payload when this line
	 * terminated a frame, otherwise undefined.
	 */
	private consumeLine(line: string): string | undefined {
		// Tolerate CRLF: some gateways emit it despite the spec.
		const bare = line.endsWith("\r") ? line.slice(0, -1) : line;

		// A blank line dispatches the frame under assembly.
		if (bare === "") return this.takeFrame();

		// ':' introduces a comment, commonly used as a keep-alive heartbeat.
		if (bare.startsWith(":")) return undefined;

		const colon = bare.indexOf(":");
		const field = colon === -1 ? bare : bare.slice(0, colon);
		// Exactly one optional leading space is part of the framing.
		let value = colon === -1 ? "" : bare.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);

		// event:/id:/retry: are not used by OpenAI-compatible streams.
		if (field !== "data") return undefined;
		this.dataLines.push(value);
		// +1 for the newline this line contributes to the joined payload.
		this.frameBytes += Buffer.byteLength(value, "utf8") + 1;
		return undefined;
	}

	private takeFrame(): string | undefined {
		if (!this.dataLines.length) return undefined;
		const payload = this.dataLines.join("\n");
		this.dataLines = [];
		this.frameBytes = 0;
		// `data:` with an empty value is a no-op frame, not an empty payload.
		return payload.trim() ? payload : undefined;
	}

	private bufferedBytes(): number {
		return this.frameBytes + Buffer.byteLength(this.buffer, "utf8");
	}
}

/**
 * The narrow slice of ReadableStreamDefaultReader this module uses. Declared
 * locally so the file is not coupled to Bun's augmented reader type.
 */
interface StreamReader {
	read(): Promise<{ done: boolean; value: Uint8Array }>;
	cancel(reason?: unknown): Promise<void>;
}

/** One upstream attempt the pump is allowed to fall back from. */
export interface StreamAttempt {
	response: Response;
	controller: AbortController;
	detach: () => void;
}

interface StreamPumpOptions {
	/** Model name reported to the client in message_start. */
	model: string;
	/** Echoed back as x-request-id for client-side correlation. */
	requestId: string;
	/** High-resolution start time, for the completion log line. */
	startTime: number;
	/** Aborts the current upstream once the stream is done or abandoned. */
	upstreamController: AbortController;
	/** Releases the concurrency slot and closes the request metrics. */
	cleanup: () => void;
	/** Estimated prompt tokens, reported in message_start (see StreamTranslator). */
	inputTokens?: number;
	/** Detaches the client-abort listener registered for the first attempt. */
	detach?: () => void;
	/**
	 * Fetches the next candidate after an attempt failed before any byte reached
	 * the client. Returning undefined means the chain is exhausted.
	 */
	retry?: () => Promise<StreamAttempt | undefined>;
	/**
	 * Reports a failed attempt so the caller can cool the model down and count
	 * the error. Never called for a client disconnect, which says nothing about
	 * the model's health.
	 */
	onUpstreamFailure?: (reason: string) => void;
	/** The client's own signal, so a disconnect is never mistaken for a retry. */
	clientSignal?: AbortSignal;
	/** Bound on a single SSE line or frame (MAX_BODY_BYTES by default). */
	maxBufferBytes?: number;
	/**
	 * Per-read deadline (UPSTREAM_TIMEOUT_MS). The header-level timeout is
	 * already cleared by the time the body is handed over, so without this an
	 * upstream that sends headers and then goes quiet would hold its slot for
	 * good.
	 */
	idleTimeoutMs?: number;
}

type AttemptResult =
	| { status: "done" }
	| { status: "retry" }
	| { status: "failed"; reason: string; reported?: boolean };

/**
 * Wrap an upstream streaming response as an Anthropic SSE response.
 *
 * Returns immediately; the body is pumped by the returned ReadableStream. The
 * `cleanup` callback runs exactly once — on normal completion, on error, and on
 * client cancellation — so the caller's concurrency slot cannot leak.
 *
 * Before the first byte reaches the client, a failed attempt can be replaced by
 * the next candidate (`retry`). That is the difference between a flaky free
 * model costing the user a whole turn and it costing nothing visible: the SSE
 * response is only committed once real content starts flowing.
 */
export function handleStream(upstream: Response, options: StreamPumpOptions): Response {
	const {
		model,
		requestId,
		startTime,
		upstreamController,
		cleanup,
		inputTokens = 0,
		detach,
		retry,
		onUpstreamFailure,
		clientSignal,
		maxBufferBytes = 20 * 1024 * 1024,
		idleTimeoutMs = 120_000,
	} = options;

	let translator = new StreamTranslator(model, inputTokens);
	const encoder = new TextEncoder();

	let cleaned = false;
	let canceled = false;
	/** True once a byte reached the client; after that a retry would duplicate. */
	let emitted = false;
	/** The attempt currently driving the stream. */
	let current: StreamAttempt = {
		response: upstream,
		controller: upstreamController,
		detach: detach ?? (() => {}),
	};

	const onceCleanup = () => {
		if (cleaned) return;
		cleaned = true;
		cleanup();
	};

	// The consumer can disappear between any two of our checks, so every
	// controller touch goes through a guard rather than assuming liveness.
	const safeEnqueue = (controller: ReadableStreamDefaultController, data: Uint8Array) => {
		if (canceled) return;
		try {
			controller.enqueue(data);
		} catch {
			canceled = true;
		}
	};

	const safeClose = (controller: ReadableStreamDefaultController) => {
		if (canceled) return;
		canceled = true;
		try {
			controller.close();
		} catch {
			// Already closed by the runtime — nothing left to do.
		}
	};

	const readable = new ReadableStream({
		async start(controller) {
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			let idleTimedOut = false;

			const clearIdleTimer = () => {
				if (idleTimer === undefined) return;
				clearTimeout(idleTimer);
				idleTimer = undefined;
			};
			const stallMessage = () =>
				`Upstream stream stalled for more than ${idleTimeoutMs}ms`;

			const enqueueEvents = (events: string[]) => {
				if (!events.length) return;
				emitted = true;
				for (const event of events) safeEnqueue(controller, encoder.encode(event));
			};

			// Re-armed on every chunk of progress, so this bounds the *gap*
			// between chunks rather than the total stream length.
			const armIdleTimer = (active: StreamReader) => {
				clearIdleTimer();
				idleTimer = setTimeout(() => {
					idleTimedOut = true;
					// Both paths matter: cancel() releases the socket, abort()
					// unwinds a body that cancel() alone would not disturb.
					void active.cancel("upstream stream idle timeout").catch(() => {});
					current.controller.abort("Upstream stream idle timeout");
				}, idleTimeoutMs);
			};

			/**
			 * Hand the turn to the next candidate. Only legal before anything was
			 * written to the client: a second message_start mid-stream would corrupt
			 * the response, so a failure after that point is reported instead.
			 */
			const failover = async (reason: string): Promise<boolean> => {
				const clientGone = canceled || clientSignal?.aborted === true;
				// A disconnect says nothing about the model, so it must not cool it.
				if (!clientGone) onUpstreamFailure?.(reason);
				if (emitted || clientGone || !retry) return false;

				current.controller.abort(reason);
				const next = await retry();
				if (!next) return false;
				if (canceled || clientSignal?.aborted) {
					next.controller.abort("Client disconnected");
					next.detach();
					return false;
				}
				current.detach();
				current = next;
				// Nothing from the abandoned attempt escaped, so start clean.
				translator = new StreamTranslator(model, inputTokens);
				return true;
			};

			const runAttempt = async (): Promise<AttemptResult> => {
				idleTimedOut = false;
				const body = current.response.body;
				if (!body) {
					// Upstream sent a bodyless 200. Still emit a valid, minimal
					// Anthropic message so the client sees a clean end_turn.
					enqueueEvents(translator.finalize());
					return { status: "done" };
				}

				const active = body.getReader() as StreamReader;
				const decoder = new TextDecoder();
				const frames = new SseFrameDecoder();

				/** Dispatch payloads, promoting an upstream error frame to a retry. */
				const dispatch = async (
					payloads: string[],
				): Promise<AttemptResult | undefined> => {
					for (const payload of payloads) {
						if (canceled) return { status: "done" };
						const events = translator.processChunk(payload);
						if (translator.errored) {
							// A 200 carrying an error object is exactly the "model is
							// unavailable" case worth trying elsewhere — as long as
							// nothing has been published yet.
							if (await failover("Upstream returned an error event")) {
								return { status: "retry" };
							}
							enqueueEvents(events);
							return {
								status: "failed",
								reason: "Upstream returned an error event",
								reported: true,
							};
						}
						enqueueEvents(events);
					}
					return undefined;
				};

				armIdleTimer(active);
				try {
					for (;;) {
						const { done, value } = await active.read();
						if (done || canceled) break;
						armIdleTimer(active);
						const early = await dispatch(
							frames.push(decoder.decode(value, { stream: true }), maxBufferBytes),
						);
						if (early) return early;
					}

					clearIdleTimer();

					if (idleTimedOut) {
						const reason = stallMessage();
						return (await failover(reason))
							? { status: "retry" }
							: { status: "failed", reason };
					}

					const early = await dispatch(frames.flush());
					if (early) return early;

					enqueueEvents(translator.finalize());
					return { status: "done" };
				} catch (err) {
					clearIdleTimer();
					// The consumer vanishing is not an upstream failure.
					if (canceled || clientSignal?.aborted) return { status: "done" };
					// The idle timer aborts the body, so the stall usually surfaces
					// here rather than as a clean read() end. Report the stall, not
					// the resulting abort error.
					const reason = idleTimedOut
						? stallMessage()
						: err instanceof Error
							? err.message
							: String(err);
					return (await failover(reason))
						? { status: "retry" }
						: { status: "failed", reason };
				}
			};

			try {
				for (;;) {
					const result = await runAttempt();
					if (result.status === "retry") continue;
					if (result.status === "failed") {
						if (
							!result.reported &&
							!result.reason.includes("Controller is already closed")
						) {
							error(`Stream error: ${result.reason} ${colors.dim(requestId)}`);
						}
						safeEnqueue(
							controller,
							encoder.encode(anthropicErrorSse("api_error", result.reason)),
						);
						safeClose(controller);
						return;
					}

					const elapsed = (performance.now() - startTime).toFixed(0);
					log(
						`${colors.green("←")} stream ${colors.dim(model)} complete ${colors.dim(`${elapsed}ms`)} ${colors.dim(requestId)}`,
					);
					safeClose(controller);
					return;
				}
			} finally {
				clearIdleTimer();
				current.detach();
				onceCleanup();
			}
		},
		async cancel() {
			canceled = true;
			current.controller.abort("Client stopped reading stream");
			onceCleanup();
		},
	});

	return new Response(readable, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"x-request-id": requestId,
			"X-Accel-Buffering": "no",
		},
	});
}
