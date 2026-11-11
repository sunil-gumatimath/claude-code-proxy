import { createLogger, initLogger } from "evlog";
initLogger({ silent: false, pretty: true });
const log = createLogger({ requestId: "req_demo", requestModel: "claude-sonnet-4-6" });
log.set({ routedModel: "kilo/nvidia/nemotron-3.5-lightning:free", status: 200, outcome: "complete", inputTokens: 21, outputTokens: 16, latencyMs: 2917 });
log.emit();
