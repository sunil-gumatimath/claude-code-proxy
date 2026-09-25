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
