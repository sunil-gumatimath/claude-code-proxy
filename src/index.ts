// ============================================================================
// index.ts — Entry point
// ============================================================================

import { loadConfig } from "./config";
import { error } from "./log";
import { createServer } from "./server";

try {
	const config = loadConfig();
	createServer(config);
} catch (err) {
	error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
