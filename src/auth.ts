// ============================================================================
// auth.ts — client credential extraction and proxy-key verification
// ============================================================================

import { createHash, timingSafeEqual } from "node:crypto";

/** Extract API key from Anthropic-style or Bearer headers. */
export function extractApiKey(req: Request): string {
	const xKey = req.headers.get("x-api-key");
	if (xKey?.trim()) return xKey.trim();

	const auth = req.headers.get("authorization");
	if (!auth) return "";

	if (auth.toLowerCase().startsWith("bearer ")) {
		return auth.slice(7).trim();
	}

	// Claude Code sometimes sends the raw token
	return auth.trim();
}

/**
 * Whether the request carries the expected proxy key.
 *
 * When `expectedKey` is empty the proxy is in its documented "local adapter"
 * mode and every request is allowed; callers that also need a network-origin
 * check pair this with a loopback gate (see server.requireOperationalAuth).
 * The comparison is constant-time over SHA-256 digests so it neither leaks the
 * key's length nor its common prefix.
 */
export function isAuthorized(req: Request, expectedKey: string): boolean {
	if (!expectedKey) return true;
	const supplied = req.headers.get("x-proxy-api-key") || extractApiKey(req);
	if (!supplied) return false;
	const suppliedHash = createHash("sha256").update(supplied, "utf8").digest();
	const expectedHash = createHash("sha256").update(expectedKey, "utf8").digest();
	return timingSafeEqual(suppliedHash, expectedHash);
}
