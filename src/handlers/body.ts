// ============================================================================
// handlers/body.ts — bounded request-body reading
// ============================================================================

/** Thrown when a body exceeds MAX_BODY_BYTES. Callers map this to HTTP 413. */
export const BODY_TOO_LARGE = "BODY_TOO_LARGE";

/** Thrown when the client stops sending mid-body. Callers map this to 499. */
export const BODY_ABORTED = "BODY_ABORTED";

export function isBodyError(err: unknown, code: string): boolean {
	return err instanceof Error && err.message === code;
}

/**
 * Read a request body as text, bounded by `maxBytes`.
 *
 * Three independent limits apply, because any one of them alone is insufficient:
 *  - `content-length` is rejected up front when it already exceeds the cap;
 *  - chunks are counted as they arrive, so a missing or lying header cannot
 *    stream an unbounded body past the limit;
 *  - each individual read is raced against `readTimeoutMs`, so a client that
 *    opens a body and then stalls cannot hold the connection open indefinitely
 *    while staying under the byte cap.
 *
 * The per-read race is what actually unblocks a stalled upload: cancelling the
 * stream is not reliable while a `read()` is pending, so the timeout rejects
 * and the `finally` cancels afterwards.
 */
export async function readBodyLimited(
	req: Request,
	maxBytes: number,
	readTimeoutMs = 120_000,
): Promise<string> {
	const declared = req.headers.get("content-length");
	if (declared && Number(declared) > maxBytes) {
		throw new Error(BODY_TOO_LARGE);
	}

	const reader = req.body?.getReader();
	if (!reader) return "";

	const chunks: Uint8Array[] = [];
	let total = 0;
	const decoder = new TextDecoder();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const cancelQuietly = () => {
		void reader.cancel().catch(() => {});
	};

	try {
		for (;;) {
			// A fresh deadline per read: a slow-but-steady upload is legitimate,
			// a stalled one is not.
			const read = reader.read();
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(BODY_ABORTED)), readTimeoutMs);
			});
			const { done, value } = await Promise.race([read, deadline]);
			clearTimeout(timer);
			timer = undefined;
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw new Error(BODY_TOO_LARGE);
			chunks.push(value);
		}
	} catch (err) {
		cancelQuietly();
		throw err;
	} finally {
		if (timer) clearTimeout(timer);
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return decoder.decode(merged);
}
