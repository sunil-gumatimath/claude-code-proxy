import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { handleMessages, handleCountTokens } from "../src/handlers/messages";
import { createServer } from "../src/server";
import type { Config } from "../src/config";
import { resetRuntimeForTests } from "../src/runtime";
const baseConfig: Config = {
  host: "127.0.0.1",
  port: 4181,
  kiloApiKey: "kilo-key",
  qwenApiKey: "qwen-key",
  qwenBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  proxyApiKey: "",
  kiloBaseUrl: "https://api.kilo.ai/api/gateway",
  modelPrefix: "",
  defaultModel: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
  fallbackModels: [
    "kilo/poolside/laguna-s-2.1:free",
    "kilo/cohere/north-mini-code:free",
    "kilo/stepfun/step-3.7-flash:free",
  ],
  allowedModels: [
    "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
    "kilo/poolside/laguna-s-2.1:free",
    "kilo/cohere/north-mini-code:free",
    "kilo/stepfun/step-3.7-flash:free",
  ],
  freeModelsOnly: true,
  visionModel: "kilo/stepfun/step-3.7-flash:free",
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
        model: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
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
        model: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
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
        model: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
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
        model: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
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
        model: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
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

describe("stream idle deadline", () => {
  test("a stalled upstream stream is aborted and releases its slot", async () => {
    // Regression: the header-level timeout is cleared once fetch resolves, so
    // nothing used to bound the body. A stalled stream pinned its concurrency
    // slot forever and wedged the proxy after MAX_CONCURRENT_REQUESTS stalls.
    const cfg: Config = {
      ...baseConfig,
      upstreamTimeoutMs: 150,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0,
      fallbackModels: [],
    };

    let resolveStall: (() => void) | undefined;
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
          );
          // Never close, never send more: the upstream just stops talking.
          void new Promise<void>((resolve) => {
            resolveStall = resolve;
          });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const stalled = await handleMessages(
      makeRequest({
        model: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      cfg,
    );
    expect(stalled.status).toBe(200);

    const reader = stalled.body!.getReader();
    const decoder = new TextDecoder();
    let out = "";
    // Drain until the deadline fires and the stream terminates.
    const drained = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
      }
    })();
    await Promise.race([drained, Bun.sleep(3000)]);
    await reader.cancel().catch(() => {});
    resolveStall?.();

    expect(out).toContain("event: error");
    expect(out).toContain("stalled");

    // The slot must be back: a fresh request now succeeds instead of 429.
    globalThis.fetch = mock(async () =>
      jsonResponse({
        id: "chatcmpl-after",
        choices: [
          { message: { role: "assistant", content: "recovered" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    ) as unknown as typeof fetch;

    const after = await handleMessages(
      makeRequest({
        model: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi again" }],
      }),
      cfg,
    );
    expect(after.status).toBe(200);
  });
});

describe("count_tokens does not consume upstream capacity", () => {
  test("succeeds while every upstream slot is busy", async () => {
    // Regression: count_tokens shares the upstream RequestLimiter, so a busy
    // proxy answered Claude Code's own context accounting with 429.
    const cfg: Config = {
      ...baseConfig,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0,
      fallbackModels: [],
    };

    let resolveStall: (() => void) | undefined;
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'),
          );
          void new Promise<void>((resolve) => {
            resolveStall = resolve;
          });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    // Occupy the single slot with a stream that will not finish.
    const inflight = await handleMessages(
      makeRequest({
        model: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      cfg,
    );
    expect(inflight.status).toBe(200);

    const counted = await handleCountTokens(
      makeRequest({
        model: "kilo/nvidia/nemotron-3-ultra-550b-a55b:free",
        messages: [{ role: "user", content: "hello world" }],
      }),
      cfg,
    );

    expect(counted.status).toBe(200);
    const json = (await counted.json()) as { input_tokens: number };
    expect(json.input_tokens).toBeGreaterThan(0);

    await inflight.body?.cancel().catch(() => {});
    resolveStall?.();
  });

  test("still rejects an oversized body and invalid JSON", async () => {
    const tooBig = await handleCountTokens(
      makeRequest({ messages: [] }),
      { ...baseConfig, maxBodyBytes: 4 },
    );
    expect(tooBig.status).toBe(413);

    const bad = new Request("http://127.0.0.1:4181/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const badRes = await handleCountTokens(bad, baseConfig);
    expect(badRes.status).toBe(400);
  });
});

describe("createServer routing & security", () => {
  test("returns 404 with not_found_error type for unknown routes", async () => {
    const server = createServer(baseConfig);
    const res = await server.fetch(new Request("http://127.0.0.1:4181/unknown-endpoint"));
    server.stop(true);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("not_found_error");
  });

  test("CORS preflight includes x-proxy-api-key in allowed headers", async () => {
    const cfg: Config = { ...baseConfig, corsAllowedOrigins: ["http://localhost:3000"] };
    const server = createServer(cfg);
    const res = await server.fetch(
      new Request("http://127.0.0.1:4181/v1/messages", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      }),
    );
    server.stop(true);
    expect(res.status).toBe(204);
    const headers = res.headers.get("access-control-allow-headers") ?? "";
    expect(headers).toContain("x-proxy-api-key");
  });
});
