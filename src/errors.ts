import type { AnthropicErrorBody } from "./types";

export function anthropicError(
  status: number,
  type: string,
  message: string,
): Response {
  const body: AnthropicErrorBody = {
    type: "error",
    error: { type, message },
  };
  return Response.json(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** Map common upstream HTTP statuses to Anthropic error types. */
export function mapUpstreamErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status === 400) return "invalid_request_error";
  if (status >= 500) return "api_error";
  return "api_error";
}

export function anthropicErrorSse(type: string, message: string): string {
  const payload = {
    type: "error",
    error: { type, message },
  };
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Extract a human-readable message from an upstream error value. Handles the
 * common `{ error: { message } }` shape as well as non-object / message-less
 * payloads, falling back to a caller-supplied default.
 */
export function extractErrorMessage(err: unknown, fallback: string): string {
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
