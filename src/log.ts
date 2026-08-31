// ============================================================================
// log.ts — Structured-friendly console logging
// ============================================================================

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export const colors = { dim, cyan, green, red, yellow, bold };

let debugEnabled = false;

export function setDebug(enabled: boolean) {
  debugEnabled = enabled;
}

function ts(): string {
  return dim(new Date().toISOString());
}

/** Redact long base64 / potential secrets and summarize prompt bodies in debug dumps */
function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[…]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (/^sk-[a-zA-Z0-9_-]{10,}/.test(value) || /^[a-f0-9]{32,}$/i.test(value) || /^Bearer\s+/i.test(value)) {
      return "[REDACTED]";
    }
    if (value.length > 200) return `${value.slice(0, 80)}…[${value.length} chars]`;
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeForLog(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/key|token|secret|authorization|password|credential|cookie/i.test(k)) {
        out[k] = "[REDACTED]";
      } else if (k === "data" && typeof v === "string" && v.length > 100) {
        out[k] = `[base64 ${v.length} chars]`;
      } else if ((k === "content" || k === "system") && typeof v === "string" && v.length > 200) {
        out[k] = `${v.slice(0, 80)}…[${v.length} chars]`;
      } else {
        out[k] = sanitizeForLog(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function log(msg: string) {
  console.log(`${ts()} ${msg}`);
}

export function info(msg: string) {
  log(msg);
}

export function warn(msg: string) {
  log(`${yellow("!")} ${msg}`);
}

export function error(msg: string) {
  log(`${red("✗")} ${msg}`);
}

export function debug(msg: string, data?: unknown) {
  if (!debugEnabled) return;
  console.log(`${ts()} ${dim("[DEBUG]")} ${msg}`);
  if (data !== undefined) {
    console.log(JSON.stringify(sanitizeForLog(data), null, 2));
  }
}

export function banner(lines: string[]) {
  console.log("");
  for (const line of lines) console.log(line);
  console.log("");
}
