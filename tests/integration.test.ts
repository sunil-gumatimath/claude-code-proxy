import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { handleMessages } from "../src/handlers/messages";
import type { Config } from "../src/config";
import { resetRuntimeForTests } from "../src/runtime";

const baseConfig: Config = {
  host: "127.0.0.1",
  port: 4181,
  kiloApiKey: "kilo-key",
  opencodeApiKey: "oc-key",
  opencodeBaseUrl: "https://opencode.ai/zen/v1",
  proxyApiKey: "",
  kiloBaseUrl: "https://api.kilo.ai/api/gateway",
  modelPrefix: "",
  defaultModel: "claude-sonnet-4-20250514",
  fallbackModels: [
    "kilo/poolside/laguna-s-2.1:free",
    "kilo/cohere/north-mini-code:free",
    "kilo/stepfun/step-3.7-flash:free",
    "opencode/deepseek-v4-flash-free",
    "opencode/longcat-2.0-free",
    "opencode/laguna-s-2.1-free",
  ],
  allowedModels: [
    "opencode/deepseek-v4-flash-free",
    "opencode/longcat-2.0-free",
    "opencode/mimo-v2.5-free",
    "opencode/north-mini-code-free",
    "opencode/nemotron-3-ultra-free",
    "opencode/laguna-s-2.1-free",
    "kilo/stepfun/step-3.7-flash:free",
    "kilo/poolside/laguna-s-2.1:free",
    "kilo/cohere/north-mini-code:free",
  ],
  freeModelsOnly: true,
  modelAliases: [],
  reasoningEffort: "",
  smartRouting: true,
  maxConcurrentRequests: 4,
  maxQueuedRequests: 20,
  modelCooldownMs: 30_000,
  debug: false,
  upstreamTimeoutMs: 120_000,
  upstreamTlsRejectUnauthorized: true,
  upstreamCaFile: "",
  maxBodyBytes: 20 * 1024 * 1024,
  corsAllowedOrigins: [],
};

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:4181/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collectStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value);
  }
  return acc;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  resetRuntimeForTests();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("handleMessages — sync", () => {
  test("translates a sync request into an Anthropic-shaped response", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        id: "chatcmpl-1",
        choices: [
          { message: { role: "assistant", content: "Hello" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    ) as unknown as typeof fetch;

    const res = await handleMessages(
      makeRequest({
        model: "opencode/deepseek-v4-flash-free",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
      baseConfig,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>;
    expect(json.type).toBe("message");
    expect(json.content[0]).toEqual({ type: "text", text: "Hello" });
    expect(json.stop_reason).toBe("end_turn");
    expect(json.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });

  test("returns an error response when upstream answers 200 with an error body", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ error: { message: "model overloaded" } }, 200),
    ) as unknown as typeof fetch;

    const res = await handleMessages(
      makeRequest({
        model: "opencode/deepseek-v4-flash-free",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
      baseConfig,
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, any>;
    expect(json.error.type).toBe("api_error");
    expect(json.error.message).toContain("model overloaded");
  });
});

describe("handleMessages — fallback", () => {
  test("falls back to the next candidate after a 429", async () => {
    // Bun passes (url, options) to fetch, so the first arg is a string, not a
    // Request. Count calls instead of parsing the body.
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls === 1) {
        return new Response("rate limited", { status: 429 });
      }
      return jsonResponse({
        id: "chatcmpl-2",
        choices: [
          { message: { role: "assistant", content: "fallback ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const res = await handleMessages(
      makeRequest({
        model: "opencode/deepseek-v4-flash-free",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
      baseConfig,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, any>;
    expect(json.content[0]).toEqual({ type: "text", text: "fallback ok" });
  });
});

describe("handleMessages — streaming", () => {
  test("streams Anthropic SSE for a successful upstream stream", async () => {
    globalThis.fetch = mock(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const res = await handleMessages(
      makeRequest({
        model: "opencode/deepseek-v4-flash-free",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      baseConfig,
    );

    expect(res.status).toBe(200);
    const out = await collectStream(res);
    expect(out).toContain("message_start");
    expect(out).toContain("text_delta");
    expect(out).toContain("Hi");
    expect(out).toContain("message_stop");
    expect(out).toContain("end_turn");
  });

  test("emits an SSE error event when the upstream stream carries an error object", async () => {
    globalThis.fetch = mock(async () =>
      sseResponse(['data: {"error":{"message":"stream boom"}}\n\n']),
    ) as unknown as typeof fetch;

    const res = await handleMessages(
      makeRequest({
        model: "opencode/deepseek-v4-flash-free",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      baseConfig,
    );

    expect(res.status).toBe(200);
    const out = await collectStream(res);
    expect(out).toContain("event: error");
    expect(out).toContain("stream boom");
  });
});
