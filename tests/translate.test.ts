import { describe, expect, test } from "bun:test";
import {
	StreamTranslator,
	translateRequest,
	translateResponse,
} from "../src/translate";

describe("translateRequest", () => {
	test("keeps requested model name and maps messages", () => {
		const out = translateRequest({
			model: "claude-sonnet-4-20250514",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 100,
		});
		expect(out.model).toBe("claude-sonnet-4-20250514");
		expect(out.messages[0]).toEqual({ role: "user", content: "hi" });
		expect(out.max_tokens).toBe(100);
	});

	test("uses default model when request omits it", () => {
		const out = translateRequest(
			{
				messages: [{ role: "user", content: "hi" }],
			},
			"fallback-model",
		);
		expect(out.model).toBe("fallback-model");
	});

	test("maps system string and tools", () => {
		const out = translateRequest(
			{
				model: "m",
				system: "You are helpful",
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{
						name: "get_weather",
						description: "Weather",
						input_schema: {
							type: "object",
							properties: { city: { type: "string" } },
						},
					},
				],
				tool_choice: { type: "auto" },
				stream: true,
			},
			"anthropic/",
		);
		expect(out.messages[0]).toEqual({
			role: "system",
			content: "You are helpful",
		});
		expect(out.tools).toHaveLength(1);
		expect((out.tools as any)[0].function.name).toBe("get_weather");
		expect(out.tool_choice).toBe("auto");
		expect(out.stream).toBe(true);
		expect(out.stream_options).toEqual({ include_usage: true });
	});

	test("maps tool_result to role:tool messages", () => {
		const out = translateRequest(
			{
				model: "m",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_1",
								content: "ok",
							},
						],
					},
				],
			},
		);
		expect(out.messages).toEqual([
			{ role: "tool", tool_call_id: "call_1", content: "ok" },
		]);
	});

	test("maps assistant tool_use to tool_calls", () => {
		const out = translateRequest(
			{
				model: "m",
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Using tool" },
							{
								type: "tool_use",
								id: "toolu_1",
								name: "search",
								input: { q: "bun" },
							},
						],
					},
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
						],
					},
				],
			},
		);
		expect(out.messages[0].content).toBe("Using tool");
		expect(out.messages[0].tool_calls?.[0]).toMatchObject({
			id: "toolu_1",
			type: "function",
			function: { name: "search", arguments: '{"q":"bun"}' },
		});
	});

	test("drops tool_use echoed without a matching tool_result", () => {
		// A tool call the upstream never generated (interrupted stream) must
		// not be echoed: strict gateways 400 tool_calls with no follow-up tool
		// message.
		const out = translateRequest(
			{
				model: "m",
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Using tool" },
							{
								type: "tool_use",
								id: "toolu_ghost",
								name: "search",
								input: { q: "bun" },
							},
						],
					},
					{ role: "user", content: "continue anyway" },
				],
			},
		);
		expect(out.messages[0].tool_calls).toBeUndefined();
		expect(out.messages[0].content).toBe("Using tool");
	});

	test("maps system as array of text blocks", () => {
		const out = translateRequest(
			{
				model: "m",
				system: [{ type: "text", text: "Be concise." }],
				messages: [{ role: "user", content: "hi" }],
			},
		);
		expect(out.messages[0]).toEqual({ role: "system", content: "Be concise." });
	});

	test("handles missing messages gracefully", () => {
		const out = translateRequest({ model: "m" });
		expect(out.messages).toEqual([]);
	});

	test("maps tool_choice types", () => {
		const base = {
			model: "m",
			messages: [{ role: "user" as const, content: "hi" }],
			tools: [
				{
					name: "f",
					input_schema: { type: "object" as const, properties: {} },
				},
			],
		};

		const anyOut = translateRequest({
			...base,
			tool_choice: { type: "any" as const },
		});
		expect(anyOut.tool_choice).toBe("required");

		const noneOut = translateRequest({
			...base,
			tool_choice: { type: "none" as const },
		});
		expect(noneOut.tool_choice).toBe("none");

		const specificOut = translateRequest({
			...base,
			tool_choice: { type: "tool" as const, name: "f" },
		});
		expect(specificOut.tool_choice).toEqual({
			type: "function",
			function: { name: "f" },
		});
	});

	test("maps thinking budget to reasoning_effort", () => {
		const low = translateRequest(
			{
				model: "m",
				messages: [{ role: "user", content: "hi" }],
				thinking: { type: "enabled", budget_tokens: 2000 },
			},
		);
		expect(low.reasoning_effort).toBe("low");

		const med = translateRequest(
			{
				model: "m",
				messages: [{ role: "user", content: "hi" }],
				thinking: { type: "enabled", budget_tokens: 6000 },
			},
		);
		expect(med.reasoning_effort).toBe("medium");

		const high = translateRequest(
			{
				model: "m",
				messages: [{ role: "user", content: "hi" }],
				thinking: { type: "enabled", budget_tokens: 15000 },
			},
		);
		expect(high.reasoning_effort).toBe("high");
	});

	test("REASONING_EFFORT override wins over budget mapping", () => {
		const forced = translateRequest(
			{
				model: "m",
				messages: [{ role: "user", content: "hi" }],
				thinking: { type: "enabled", budget_tokens: 2000 },
			},
			undefined,
			"xhigh",
		);
		expect(forced.reasoning_effort).toBe("xhigh");
	});

	test("REASONING_EFFORT applies without client thinking", () => {
		const forced = translateRequest(
			{ model: "m", messages: [{ role: "user", content: "hi" }] },
			undefined,
			"max",
		);
		expect(forced.reasoning_effort).toBe("max");
	});

	test("no REASONING_EFFORT leaves budget mapping intact", () => {
		const out = translateRequest({
			model: "m",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(out.reasoning_effort).toBeUndefined();
	});

	test("maps image content blocks (base64 and URL)", () => {
		const out = translateRequest(
			{
				model: "m",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "What is this?" },
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAA=",
								},
							},
							{
								type: "image",
								source: { type: "url", url: "https://example.com/photo.jpg" },
							},
						] as any,
					},
				],
			},
		);
		const content = out.messages[0].content as unknown[];
		expect(content).toHaveLength(3);
		expect((content[0] as any).type).toBe("text");
		expect((content[1] as any).type).toBe("image_url");
		expect((content[2] as any).type).toBe("image_url");
		expect((content[1] as any).image_url.url).toContain(
			"data:image/png;base64,",
		);
		expect((content[2] as any).image_url.url).toBe(
			"https://example.com/photo.jpg",
		);
	});

	test("maps document blocks", () => {
		const out = translateRequest(
			{
				model: "m",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "document",
								source: { type: "text", content: "Hello from doc" },
							},
						] as any,
					},
				],
			},
		);
		expect(out.messages[0].content as string).toContain("[Document]");
		expect(out.messages[0].content as string).toContain("Hello from doc");
	});

	test("forwards stop_sequences and top_p", () => {
		const out = translateRequest(
			{
				model: "m",
				messages: [{ role: "user", content: "hi" }],
				stop_sequences: ["\n\n", "."],
				top_p: 0.9,
			},
		);
		expect(out.stop).toEqual(["\n\n", "."]);
		expect(out.top_p).toBe(0.9);
	});

	test("does not forward non-standard is_error on tool results", () => {
		const out = translateRequest({
			model: "m",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_1",
							content: "error occurred",
							is_error: true,
						},
					],
				},
			],
		});
		expect(out.messages[0]).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			content: "error occurred",
		});
	});

	test("passes thinking blocks through as reasoning_content", () => {
		const out = translateRequest({
			model: "m",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "I should use a tool" },
						{ type: "text", text: "Final answer" },
					],
				},
			],
		});
		// Thinking-mode gateways demand reasoning passthrough on follow-ups
		expect(out.messages[0].content).toBe("Final answer");
		expect(out.messages[0].reasoning_content).toBe("I should use a tool");
	});

	test("thinking-only echo keeps empty content instead of null", () => {
		// A truncated turn (thinking but no text) must round-trip as content ""
		// — gateways reject assistant messages with null content when
		// reasoning_content is present.
		const out = translateRequest({
			model: "m",
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "planning..." }],
				},
			],
		});
		expect(out.messages[0].content).toBe("");
		expect(out.messages[0].reasoning_content).toBe("planning...");
	});
});

describe("translateResponse", () => {
	test("maps text + finish_reason", () => {
		const out = translateResponse(
			{
				choices: [
					{
						message: { role: "assistant", content: "Hello" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 3 },
			},
			"claude-test",
		);
		expect(out.model).toBe("claude-test");
		expect(out.stop_reason).toBe("end_turn");
		expect(out.content[0]).toEqual({ type: "text", text: "Hello" });
		expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
	});

	test("maps tool_calls finish to tool_use", () => {
		const out = translateResponse(
			{
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "get_weather",
										arguments: '{"city":"NYC"}',
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
			"m",
		);
		expect(out.stop_reason).toBe("tool_use");
		expect(out.content[0]).toMatchObject({
			type: "tool_use",
			id: "call_1",
			name: "get_weather",
			input: { city: "NYC" },
		});
	});

	test("maps reasoning_content to thinking block", () => {
		const out = translateResponse(
			{
				choices: [
					{
						message: {
							role: "assistant",
							content: "Here's my answer",
							reasoning_content: "Let me think step by step...",
						},
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 5, completion_tokens: 10 },
			},
			"m",
		);
		// thinking block comes first (unshifted)
		expect(out.content[0]).toEqual({
			type: "thinking",
			thinking: "Let me think step by step...",
		});
		expect(out.content[1]).toEqual({ type: "text", text: "Here's my answer" });
		expect(out.stop_reason).toBe("end_turn");
	});

	test("handles empty choices gracefully", () => {
		const out = translateResponse({ choices: [] as any }, "m");
		expect(out.content).toHaveLength(1);
		expect(out.content[0]).toEqual({ type: "text", text: "" });
		expect(out.stop_reason).toBe("end_turn");
		expect(out.usage.input_tokens).toBe(0);
		expect(out.usage.output_tokens).toBe(0);
	});

	test("maps finish_reason length to max_tokens", () => {
		const out = translateResponse(
			{
				choices: [
					{
						message: { role: "assistant", content: "Truncated" },
						finish_reason: "length",
					},
				],
			},
			"m",
		);
		expect(out.stop_reason).toBe("max_tokens");
	});

	test("maps finish_reason content_filter to end_turn", () => {
		const out = translateResponse(
			{
				choices: [
					{
						message: { role: "assistant", content: "Filtered" },
						finish_reason: "content_filter",
					},
				],
			},
			"m",
		);
		expect(out.stop_reason).toBe("end_turn");
	});

	test("includes tool_use alongside text content", () => {
		const out = translateResponse(
			{
				choices: [
					{
						message: {
							role: "assistant",
							content: "Calling tool",
							tool_calls: [
								{
									id: "call_2",
									type: "function",
									function: { name: "search", arguments: '{"q":"test"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
			"m",
		);
		expect(out.content).toHaveLength(2);
		expect(out.content[0]).toEqual({ type: "text", text: "Calling tool" });
		expect(out.content[1]).toMatchObject({ type: "tool_use", name: "search" });
		expect(out.stop_reason).toBe("tool_use");
	});

	test("constructs id from OpenAI chatcmpl prefix", () => {
		const out = translateResponse(
			{
				id: "chatcmpl-abc123",
				choices: [
					{
						message: { role: "assistant", content: "Hi" },
						finish_reason: "stop",
					},
				],
			},
			"m",
		);
		expect(out.id).toBe("msg_abc123");
	});
});

describe("StreamTranslator", () => {
	test("translates text stream and finishes", () => {
		const t = new StreamTranslator("claude-test");
		const events = [
			...t.processChunk(
				JSON.stringify({
					choices: [{ delta: { content: "Hi" }, index: 0 }],
				}),
			),
			...t.processChunk(
				JSON.stringify({
					choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				}),
			),
			...t.finalize(),
		];
		const joined = events.join("");
		expect(joined).toContain("message_start");
		expect(joined).toContain("text_delta");
		expect(joined).toContain("Hi");
		expect(joined).toContain("message_stop");
		expect(joined).toContain("end_turn");
		expect(t.isFinished).toBe(true);
	});

	test("finalize closes stream without finish_reason", () => {
		const t = new StreamTranslator("m");
		t.processChunk(
			JSON.stringify({
				choices: [{ delta: { content: "x" }, index: 0 }],
			}),
		);
		const end = t.finalize("stop");
		const joined = end.join("");
		expect(joined).toContain("message_stop");
		expect(t.finalize("stop")).toEqual([]); // idempotent
	});

	test("tool call args before id still emit deltas", () => {
		const t = new StreamTranslator("m");
		const e1 = t.processChunk(
			JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '{"a":' } }],
						},
					},
				],
			}),
		);
		const e2 = t.processChunk(
			JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_xyz",
									function: { name: "fn", arguments: "1}" },
								},
							],
						},
					},
				],
			}),
		);
		const joined = [...e1, ...e2].join("");
		expect(joined).toContain("content_block_start");
		expect(joined).toContain("input_json_delta");
		// Payload is JSON-stringified inside SSE (quotes escaped)
		expect(joined).toContain("partial_json");
		expect(joined.includes("{") && joined.includes("a")).toBe(true);
	});

	test("handles [DONE] sentinel", () => {
		const t = new StreamTranslator("m");
		t.processChunk(
			JSON.stringify({
				choices: [{ delta: { content: "Hi" }, index: 0 }],
			}),
		);
		const end = t.processChunk("[DONE]");
		const joined = end.join("");
		expect(joined).toContain("message_stop");
		expect(t.isFinished).toBe(true);
	});

	test("finalize on empty unstarted stream emits valid message", () => {
		const t = new StreamTranslator("m");
		const end = t.finalize("stop");
		const joined = end.join("");
		expect(joined).toContain("message_start");
		expect(joined).toContain("message_stop");
		expect(t.isFinished).toBe(true);
	});

	test("emits ping event on first chunk", () => {
		const t = new StreamTranslator("m");
		const events = t.processChunk(
			JSON.stringify({
				choices: [{ delta: { content: "x" }, index: 0 }],
			}),
		);
		expect(events.join("")).toContain('"ping"');
	});

	test("translates reasoning_content in stream", () => {
		const t = new StreamTranslator("m");
		const events = t.processChunk(
			JSON.stringify({
				choices: [
					{ delta: { reasoning_content: "Let me think..." }, index: 0 },
				],
			}),
		);
		const joined = events.join("");
		expect(joined).toContain("content_block_start");
		expect(joined).toContain("thinking");
		expect(joined).toContain("Let me think...");
	});

	test("reasoning-only stream finalizes with a text block", () => {
		// Upstream died after reasoning but before any content: a thinking-only
		// assistant message would round-trip as content:null + reasoning_content,
		// which strict gateways reject. The translator must append a text block.
		const t = new StreamTranslator("m");
		t.processChunk(
			JSON.stringify({
				choices: [{ delta: { reasoning_content: "planning..." }, index: 0 }],
			}),
		);
		const end = t.finalize("stop");
		const joined = end.join("");
		expect(joined).toContain('"type":"text"');
		expect(joined).toContain("stream ended before completion");
		expect(joined).toContain("message_stop");
	});

	test("finalize drops incomplete tool calls without fabricating IDs", () => {
		// Upstream streamed tool fragments but closed before sending id/name:
		// fabricating a toolu_ block makes the client echo a dangling tool call
		// that strict gateways reject on the next turn. Drop it instead.
		const t = new StreamTranslator("m");
		t.processChunk(
			JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: '{"cmd":"echo"}' } },
							],
						},
					},
				],
			}),
		);
		const end = t.finalize("stop");
		const joined = end.join("");
		expect(joined).not.toContain("toolu_");
		expect(joined).not.toContain("unknown_tool");
		expect(joined).toContain("message_stop");
		expect(joined).toContain('"type":"text"'); // truncation marker keeps it valid
	});

	test("transitions from thinking to text block cleanly", () => {
		const t = new StreamTranslator("m");
		const think = t.processChunk(
			JSON.stringify({
				choices: [{ delta: { reasoning_content: "thinking..." }, index: 0 }],
			}),
		);
		const text = t.processChunk(
			JSON.stringify({
				choices: [{ delta: { content: "answer" }, index: 0 }],
			}),
		);
		const finish = t.processChunk(
			JSON.stringify({
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
			}),
		);
		const joined = [...think, ...text, ...finish].join("");
		// Thinking block is stopped before text block starts
		expect(joined.match(/content_block_stop/g)?.length).toBeGreaterThanOrEqual(
			2,
		);
		expect(joined).toContain("thinking_delta");
		expect(joined).toContain("text_delta");
	});

	test("emits empty text block when only tool calls finish", () => {
		const t = new StreamTranslator("m");
		const e1 = t.processChunk(
			JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									function: { name: "fn", arguments: "{}" },
								},
							],
						},
					},
				],
			}),
		);
		const e2 = t.processChunk(
			JSON.stringify({
				choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
			}),
		);
		const joined = [...e1, ...e2, ...t.finalize()].join("");
		expect(joined).toContain("tool_use");
		expect(joined).toContain("message_stop");
		expect(t.isFinished).toBe(true);
	});

	test("multiple tool calls in one chunk", () => {
		const t = new StreamTranslator("m");
		const events = t.processChunk(
			JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "c1",
									function: { name: "fn1", arguments: "{}" },
								},
								{
									index: 1,
									id: "c2",
									function: { name: "fn2", arguments: "{}" },
								},
							],
						},
					},
				],
			}),
		);
		const joined = events.join("");
		expect(joined).toContain('"tool_use"');
		expect(joined).toContain("fn1");
		expect(joined).toContain("fn2");
	});

	test("usage stats propagate through stream (output only per spec)", () => {
		const t = new StreamTranslator("m");
		t.processChunk(
			JSON.stringify({
				choices: [{ delta: { content: "a" }, index: 0 }],
			}),
		);
		const end = t.processChunk(
			JSON.stringify({
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
				usage: { prompt_tokens: 7, completion_tokens: 3 },
			}),
		);
		const joined = [...end, ...t.finalize()].join("");
		// Anthropic message_delta.usage carries output_tokens only
		expect(joined).toContain('"output_tokens":3');
		expect(joined).not.toContain('"input_tokens"');
	});

	test("waits for usage-only chunk after finish", () => {
		const t = new StreamTranslator("m");
		t.processChunk(JSON.stringify({ choices: [{ delta: { content: "a" } }] }));
		t.processChunk(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }));
		const end = t.processChunk(JSON.stringify({
			choices: [],
			usage: { prompt_tokens: 8, completion_tokens: 4 },
		}));
		const joined = [...end, ...t.finalize()].join("");
		expect(joined).toContain('"output_tokens":4');
	});
});
