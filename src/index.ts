// ============================================================================
// index.ts — Entry point
// ============================================================================

import { loadConfig } from "./config";
import { createServer } from "./server";
import { error } from "./log";

try {
	const config = loadConfig();
	createServer(config);
} catch (err) {
	error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
