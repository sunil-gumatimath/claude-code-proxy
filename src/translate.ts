// ============================================================================
// translate.ts — Anthropic Messages API ↔ OpenAI Chat Completions translator
// ============================================================================

import { createHash } from "node:crypto";
import { anthropicErrorSse, extractErrorMessage, truncate } from "./errors";
import type {
	AnthropicContentBlock,
	AnthropicMessage,
	AnthropicMessageResponse,
	AnthropicMessagesRequest,
	AnthropicTextBlock,
	AnthropicThinkingBlock,
	OpenAIChatRequest,
	OpenAIChatResponse,
	OpenAIChoice,
	OpenAIMessage,
	ReasoningEffort,
} from "./types";

// ─── Request Translation (Anthropic → OpenAI) ──────────────────────────────

export function translateRequest(
	body: AnthropicMessagesRequest,
	defaultModel = "claude-sonnet-4-20250514",
	reasoningEffort: ReasoningEffort = "",
): OpenAIChatRequest {
	const openai: OpenAIChatRequest = {
		model: "",
		messages: [],
	};

	// The upstream model name is finalized by the handler via qualifyModel()
	// (provider prefix + MODEL_PREFIX); here we only keep the raw requested name.
	openai.model = body.model || defaultModel;

	const messages: OpenAIMessage[] = [];

	if (body.system) {
		if (typeof body.system === "string") {
			messages.push({ role: "system", content: body.system });
		} else if (Array.isArray(body.system)) {
			const text = body.system
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			if (text) messages.push({ role: "system", content: text });
		}
	}

	const answeredToolIds = collectAnsweredToolIds(body.messages || []);
	for (const msg of body.messages || []) {
		messages.push(...translateMessage(msg, answeredToolIds));
	}
	openai.messages = messages;

	if (body.max_tokens != null) {
		openai.max_tokens = Math.min(body.max_tokens, 16384);
	}
	if (body.temperature != null) openai.temperature = body.temperature;
	if (body.top_p != null) openai.top_p = body.top_p;
	if (body.stop_sequences) openai.stop = body.stop_sequences;
	if (body.stream != null) openai.stream = body.stream;

	if (body.stream) {
		openai.stream_options = { include_usage: true };
	}

	if (reasoningEffort) {
		// REASONING_EFFORT is an explicit operator override — applied even when
		// the client sends no thinking (Claude Code may not enable it for
		// unrecognized models). "xhigh" is the OpenAI-standard max; gateways
		// that speak DeepSeek's vocabulary map it to their own "max" effort.
		openai.reasoning_effort = reasoningEffort;
	} else if (body.thinking?.type === "enabled") {
		const budget = body.thinking.budget_tokens ?? 0;
		openai.reasoning_effort =
			budget >= 32_000
				? "xhigh"
				: budget >= 10_000
					? "high"
					: budget >= 4_000
						? "medium"
						: "low";
	}

	if (body.tools?.length) {
		openai.tools = body.tools.map((t) => ({
			type: "function",
			function: {
				name: t.name,
				description: t.description || "",
				parameters: t.input_schema || { type: "object", properties: {} },
			},
		}));
	}

	if (body.tool_choice) {
		if (body.tool_choice.type === "auto") {
			openai.tool_choice = "auto";
		} else if (body.tool_choice.type === "any") {
			openai.tool_choice = "required";
		} else if (body.tool_choice.type === "tool") {
			openai.tool_choice = {
				type: "function",
				function: { name: body.tool_choice.name },
			};
		} else if (body.tool_choice.type === "none") {
			openai.tool_choice = "none";
		}

		if (body.tool_choice.disable_parallel_tool_use === true) {
			openai.parallel_tool_calls = false;
		}
	}

	return openai;
}

function translateMessage(
	msg: {
		role: string;
		content: string | AnthropicContentBlock[];
	},
	answeredToolIds: ReadonlySet<string> = new Set(),
): OpenAIMessage[] {
	const role = msg.role;

	if (typeof msg.content === "string") {
		return [{ role, content: msg.content }];
	}

	if (!Array.isArray(msg.content)) {
		return [{ role, content: "" }];
	}

	if (role === "assistant")
		return translateAssistantMessage(msg.content, answeredToolIds);
	if (role === "user") return translateUserMessage(msg.content);

	const text = msg.content
		.filter((b) => b.type === "text" && "text" in b)
		.map((b) => (b as AnthropicTextBlock).text)
		.join("\n");
	return [{ role, content: text }];
}

/**
 * Tool call ids that some tool_result in the request answers. Tool calls the
 * upstream never generated (e.g. fabricated by an interrupted stream, or a
 * tool run the client abandoned) must not be echoed: strict gateways reject
 * assistant tool_calls that no tool message follows up on.
 */
function collectAnsweredToolIds(messages: AnthropicMessage[]): ReadonlySet<string> {
	const answered = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type === "tool_result" && "tool_use_id" in block) {
				answered.add(String(block.tool_use_id));
			}
		}
	}
	return answered;
}

function translateAssistantMessage(
	blocks: AnthropicContentBlock[],
	answeredToolIds: ReadonlySet<string> = new Set(),
): OpenAIMessage[] {
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];

	for (const block of blocks) {
		if (block.type === "text" && "text" in block) {
			textParts.push(String(block.text));
		} else if (block.type === "tool_use" && "id" in block && "name" in block) {
			// Drop tool calls no tool_result answers: echoing them back to a
			// strict gateway 400s the whole turn ("tool_calls must be followed
			// by tool messages").
			if (!answeredToolIds.has(String(block.id))) continue;
			const input = "input" in block ? block.input : {};
			toolCalls.push({
				id: String(block.id),
				type: "function",
				function: {
					name: String(block.name),
					arguments: typeof input === "string" ? input : JSON.stringify(input ?? {}),
				},
			});
		} else if (block.type === "thinking" && "thinking" in block) {
			// OpenAI-compatible gateways in thinking mode demand the model's
			// reasoning be passed back verbatim on follow-up turns
			// ("reasoning_content must be passed back to the API").
			thinkingParts.push(String(block.thinking));
		}
		// "redacted_thinking" blocks are intentionally dropped
	}

	const out: OpenAIMessage = {
		role: "assistant",
		// Empty string keeps the message valid: gateways reject assistant
		// messages whose content is null/missing when reasoning_content is set.
		content: textParts.join("\n"),
	};
	if (thinkingParts.length) out.reasoning_content = thinkingParts.join("\n");
	if (toolCalls.length) out.tool_calls = toolCalls;
	return [out];
}

function translateUserMessage(blocks: AnthropicContentBlock[]): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	const contentParts: unknown[] = [];

	for (const block of blocks) {
		if (block.type === "text" && "text" in block) {
			contentParts.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			const part = toImagePart(block as { source?: unknown });
			if (part) contentParts.push(part);
		} else if (block.type === "document" && "source" in block) {
			const source = block.source as {
				type?: string;
				media_type?: string;
				data?: string;
				content?: string;
			};
			const text = source?.content || (source?.type === "text" ? source.data : undefined);
			if (text) {
				contentParts.push({ type: "text", text: `[Document]\n${text}` });
			} else if (source?.data && source?.media_type) {
				// OpenAI-compatible gateways that understand input_file can forward PDFs
				// and other encoded document attachments without losing the payload.
				contentParts.push({
					type: "file",
					file: {
						file_data: `data:${source.media_type};base64,${source.data}`,
						mime_type: source.media_type,
					},
				});
			}
		} else if (block.type === "tool_result" && "tool_use_id" in block) {
			if (contentParts.length) {
				result.push({
					role: "user",
					content: simplifyContent([...contentParts]),
				});
				contentParts.length = 0;
			}

			let toolContent = "";
			const toolImages: unknown[] = [];
			const content = "content" in block ? block.content : undefined;
			if (typeof content === "string") {
				toolContent = content;
			} else if (Array.isArray(content)) {
				const texts: string[] = [];
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					if (part.type === "text" && "text" in part) {
						texts.push(String(part.text));
					} else if (part.type === "image") {
						const image = toImagePart(part as { source?: unknown });
						if (image) toolImages.push(image);
					}
				}
				toolContent = texts.join("\n");
			}

			// Anthropic's is_error has no OpenAI equivalent and non-standard keys
			// can 400 strict gateways, so the failure is stated in-band. Handing
			// back only the error text makes a failed tool look like a successful
			// result that happened to contain a message.
			if ("is_error" in block && block.is_error === true) {
				toolContent = toolContent ? `[tool error] ${toolContent}` : "[tool error]";
			}

			// Note: the error text itself is already in content.
			result.push({
				role: "tool",
				tool_call_id: String(block.tool_use_id),
				content: toolContent || "",
			});

			// An OpenAI tool message is text-only, so an image a tool returned
			// cannot ride along with it. Emit it as the immediately following user
			// message; silently dropping it leaves the model blind to the output.
			if (toolImages.length) result.push({ role: "user", content: toolImages });
		}
	}

	if (contentParts.length) {
		result.push({ role: "user", content: simplifyContent(contentParts) });
	}

	return result.length ? result : [{ role: "user", content: "" }];
}

/** Convert an Anthropic image source into an OpenAI image_url content part. */
function toImagePart(block: { source?: unknown }): unknown | undefined {
	const source = block.source as
		| { type?: string; media_type?: string; data?: string; url?: string }
		| undefined;
	if (source?.type === "base64" && source.media_type && source.data) {
		return {
			type: "image_url",
			image_url: { url: `data:${source.media_type};base64,${source.data}` },
		};
	}
	if (source?.type === "url" && source.url) {
		return { type: "image_url", image_url: { url: source.url } };
	}
	return undefined;
}

function simplifyContent(parts: unknown[]): string | unknown[] {
	if (
		parts.length === 1 &&
		parts[0] &&
		typeof parts[0] === "object" &&
		(parts[0] as { type?: string }).type === "text"
	) {
		return String((parts[0] as { text: string }).text);
	}
	return parts;
}

// ─── Response Translation (OpenAI → Anthropic) — Non-Streaming ─────────────

export function translateResponse(
	openai: OpenAIChatResponse,
	originalModel: string,
): AnthropicMessageResponse {
	const choice = openai.choices?.[0];

	if (!choice) {
		return {
			id: `msg_${uid()}`,
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "" }],
			model: originalModel,
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 0, output_tokens: 0 },
		};
	}

	const content: AnthropicContentBlock[] = [];

	if (choice.message?.content) {
		content.push({ type: "text", text: String(choice.message.content) });
	}

	if (choice.message?.reasoning_content) {
		const thinking = String(choice.message.reasoning_content);
		const block: AnthropicThinkingBlock = {
			type: "thinking",
			thinking,
			signature: thinkingSignature(thinking),
		};
		content.unshift(block);
	}

	if (choice.message?.tool_calls) {
		for (const tc of choice.message.tool_calls) {
			const name = tc.function?.name;
			// A tool call with no name cannot be dispatched by the client —
			// drop it instead of emitting a block it cannot act on.
			if (!name) continue;
			let input: unknown = {};
			try {
				input = JSON.parse(tc.function.arguments || "{}");
			} catch {
				input = { raw: tc.function.arguments };
			}
			content.push({
				type: "tool_use",
				// `id` is required by the Anthropic schema, but some gateways omit
				// it (typically on a trailing chunk). Synthesize a stable id rather
				// than emit `id: undefined`, which JSON.stringify drops entirely and
				// leaves an invalid tool_use block.
				id: tc.id || `toolu_${uid()}`,
				name,
				input,
			});
		}
	}

	if (!content.length) content.push({ type: "text", text: "" });

	return {
		id: openai.id ? `msg_${openai.id.replace(/^chatcmpl-/, "")}` : `msg_${uid()}`,
		type: "message",
		role: "assistant",
		content,
		model: originalModel,
		stop_reason: mapFinishReason(choice.finish_reason ?? null),
		stop_sequence: null,
		usage: {
			input_tokens: openai.usage?.prompt_tokens || 0,
			output_tokens: openai.usage?.completion_tokens || 0,
		},
	};
}

// ─── Streaming Translation (OpenAI SSE → Anthropic SSE) ─────────────────────

export class StreamTranslator {
	private msgId: string;
	private model: string;
	private started = false;
	private textBlockActive = false;
	private textBlockIdx = -1;
	private thinkingBlockActive = false;
	private thinkingBlockIdx = -1;
	private nextBlockIdx = 0;
	/** A text/tool block was fully started (message will be valid on echo). */
	private sawText = false;
	private sawTool = false;
	/** OpenAI tool_call index → Anthropic content block index */
	private toolMap = new Map<
		number,
		{
			blockIdx: number;
			id: string;
			name: string;
			pendingArgs: string;
			started: boolean;
		}
	>();
	private inputTokens = 0;
	private outputTokens = 0;
	private finished = false;
	private pendingFinishReason: string | undefined;
	/** The upstream answered 200 with an error object inside the stream. */
	private errorFrame = false;

	/**
	 * `estimatedInputTokens` seeds message_start. The upstream's real prompt
	 * usage only arrives in the final chunk, long after message_start has been
	 * sent, and Anthropic clients (Claude Code in particular) read the context
	 * size from that event. Reporting 0 there makes their context meter and
	 * auto-compact behaviour wrong, so a local estimate is better than a
	 * confidently incorrect zero.
	 */
	constructor(model: string, estimatedInputTokens = 0) {
		this.msgId = `msg_${uid()}`;
		this.model = model;
		this.inputTokens = estimatedInputTokens;
	}

	get isFinished(): boolean {
		return this.finished;
	}

	/** Whether the last processed chunk was an error object, not a completion. */
	get errored(): boolean {
		return this.errorFrame;
	}

	/**
	 * Process one SSE data payload from the OpenAI stream.
	 * Returns Anthropic SSE event strings ready to write.
	 */
	processChunk(data: string): string[] {
		// Once finalize() has run, message_stop has been emitted and the stream is
		// over. Without this guard a trailing chunk (some gateways send one after
		// [DONE]) would open a new content block *after* message_stop, which
		// violates the event ordering clients rely on.
		if (this.finished) return [];

		if (data === "[DONE]") {
			// No explicit reason: let finalize() use the finish_reason the
			// upstream actually sent. Passing "stop" here would discard it.
			return this.finalize();
		}

		let chunk: OpenAIChatResponse & {
			choices?: Array<OpenAIChoice>;
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};

		try {
			chunk = JSON.parse(data);
		} catch {
			return [];
		}

		// OpenAI-compatible gateways sometimes answer a 200 with an error object
		// inside the stream body. Surface it as an Anthropic SSE error instead of
		// a silent, empty success so the client never treats the turn as OK.
		const maybeError = (chunk as { error?: { message?: unknown } }).error;
		if (maybeError) {
			const errMsg = extractErrorMessage(maybeError, "Upstream stream error");
			this.finished = true;
			this.errorFrame = true;
			return [anthropicErrorSse("api_error", truncate(errMsg, 2000))];
		}

		const events: string[] = [];

		if (!this.started) {
			events.push(
				sse("message_start", {
					type: "message_start",
					message: {
						id: this.msgId,
						type: "message",
						role: "assistant",
						content: [],
						model: this.model,
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: this.inputTokens, output_tokens: 0 },
					},
				}),
				sse("ping", { type: "ping" }),
			);
			this.started = true;
		}

		if (chunk.usage) {
			this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens;
			this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
		}

		const choice = chunk.choices?.[0];
		if (!choice) return events;

		const delta = choice.delta || {};

		if (delta.reasoning_content) {
			if (!this.thinkingBlockActive) {
				this.thinkingBlockIdx = this.nextBlockIdx++;
				this.thinkingBlockActive = true;
				// The signature is synthesized here for the same reason as in the
				// non-streaming path: Anthropic's schema requires it on a thinking
				// block and we have no upstream one to forward. Streaming is the
				// common case, so leaving it off would make most thinking blocks
				// schema-invalid.
				const seed = String(delta.reasoning_content);
				events.push(
					sse("content_block_start", {
						type: "content_block_start",
						index: this.thinkingBlockIdx,
						content_block: {
							type: "thinking",
							thinking: "",
							signature: thinkingSignature(seed),
						},
					}),
				);
			}
			events.push(
				sse("content_block_delta", {
					type: "content_block_delta",
					index: this.thinkingBlockIdx,
					delta: { type: "thinking_delta", thinking: delta.reasoning_content },
				}),
			);
		}

		if (delta.content != null && delta.content !== "") {
			if (this.thinkingBlockActive) {
				events.push(
					sse("content_block_stop", {
						type: "content_block_stop",
						index: this.thinkingBlockIdx,
					}),
				);
				this.thinkingBlockActive = false;
			}
			if (!this.textBlockActive) {
				this.textBlockIdx = this.nextBlockIdx++;
				this.textBlockActive = true;
				this.sawText = true;
				events.push(
					sse("content_block_start", {
						type: "content_block_start",
						index: this.textBlockIdx,
						content_block: { type: "text", text: "" },
					}),
				);
			}
			events.push(
				sse("content_block_delta", {
					type: "content_block_delta",
					index: this.textBlockIdx,
					delta: { type: "text_delta", text: delta.content },
				}),
			);
		}

		if (delta.tool_calls) {
			if (this.thinkingBlockActive) {
				events.push(
					sse("content_block_stop", {
						type: "content_block_stop",
						index: this.thinkingBlockIdx,
					}),
				);
				this.thinkingBlockActive = false;
			}
			if (this.textBlockActive) {
				events.push(
					sse("content_block_stop", {
						type: "content_block_stop",
						index: this.textBlockIdx,
					}),
				);
				this.textBlockActive = false;
			}

			for (const tc of delta.tool_calls) {
				const tcIdx = tc.index ?? 0;
				let entry = this.toolMap.get(tcIdx);

				// Open the Anthropic block only after we know its immutable metadata.
				// Some OpenAI-compatible providers send argument fragments before id/name.
				if (!entry) {
					const blockIdx = this.nextBlockIdx++;
					entry = {
						blockIdx,
						id: tc.id || "",
						name: tc.function?.name || "",
						pendingArgs: "",
						started: false,
					};
					this.toolMap.set(tcIdx, entry);
				} else {
					if (tc.id) entry.id = tc.id;
					if (tc.function?.name) entry.name = tc.function.name;
				}

				if (tc.function?.arguments) {
					entry.pendingArgs += tc.function.arguments;
				}

				if (!entry.started && entry.id && entry.name) {
					entry.started = true;
					this.sawTool = true;
					events.push(
						sse("content_block_start", {
							type: "content_block_start",
							index: entry.blockIdx,
							content_block: {
								type: "tool_use",
								id: entry.id,
								name: entry.name,
								input: {},
							},
						}),
					);
				}

				if (entry.started && entry.pendingArgs) {
					events.push(
						sse("content_block_delta", {
							type: "content_block_delta",
							index: entry.blockIdx,
							delta: {
								type: "input_json_delta",
								partial_json: entry.pendingArgs,
							},
						}),
					);
					entry.pendingArgs = "";
				}
			}
		}

		if (choice.finish_reason && !this.finished) {
			// Providers commonly send usage in a final usage-only chunk after the
			// finish chunk. Defer message_delta/message_stop until [DONE] or EOF so
			// those tokens are included in the Anthropic usage event.
			this.pendingFinishReason = choice.finish_reason;
		}

		return events;
	}

	/**
	 * Ensure stream always ends with Anthropic close events
	 * (e.g. upstream closed without finish_reason).
	 */
	finalize(reason = this.pendingFinishReason || "stop"): string[] {
		if (this.finished) return [];
		if (!this.started) {
			// Empty stream — still emit a minimal valid message
			this.started = true;
			return [
				sse("message_start", {
					type: "message_start",
					message: {
						id: this.msgId,
						type: "message",
						role: "assistant",
						content: [],
						model: this.model,
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: this.inputTokens, output_tokens: 0 },
					},
				}),
				...this.emitFinish(reason),
			];
		}
		return this.emitFinish(reason);
	}

	/**
	 * A turn that emitted a tool_use block must report `tool_use`, whatever the
	 * upstream's finish_reason said. Some gateways send "stop" alongside a
	 * completed tool call; the client would then treat the turn as finished and
	 * never dispatch the tool, silently stalling the agent.
	 */
	private resolveStopReason(finishReason: string): string {
		const mapped = mapFinishReason(finishReason);
		return this.sawTool && mapped === "end_turn" ? "tool_use" : mapped;
	}

	private emitFinish(finishReason: string): string[] {
		if (this.finished) return [];
		this.finished = true;
		const events: string[] = [];

		if (this.textBlockActive) {
			events.push(
				sse("content_block_stop", {
					type: "content_block_stop",
					index: this.textBlockIdx,
				}),
			);
			this.textBlockActive = false;
		}

		if (this.thinkingBlockActive) {
			events.push(
				sse("content_block_stop", {
					type: "content_block_stop",
					index: this.thinkingBlockIdx,
				}),
			);
			this.thinkingBlockActive = false;
		}

		for (const [, entry] of this.toolMap) {
			// Never fabricate tool_use blocks for tool calls the upstream failed
			// to describe (no id/name arrived). A fake ID poisons the conversation
			// history: the client echoes the dangling tool call back and strict
			// gateways reject the next turn ("tool_calls must be followed by
			// tool messages"). Drop the incomplete call instead — the stream
			// closes with whatever blocks actually started.
			if (!entry.started) continue;
			events.push(
				sse("content_block_stop", {
					type: "content_block_stop",
					index: entry.blockIdx,
				}),
			);
		}

		if (!this.sawText && !this.sawTool) {
			// Message would carry only a thinking block (or nothing) — invalid on
			// echo: OpenAI-style gateways demand content or tool_calls alongside
			// reasoning_content. Emit a neutral text block so the turn round-trips.
			const fallbackIdx = this.nextBlockIdx++;
			events.push(
				sse("content_block_start", {
					type: "content_block_start",
					index: fallbackIdx,
					content_block: { type: "text", text: "" },
				}),
				sse("content_block_delta", {
					type: "content_block_delta",
					index: fallbackIdx,
					delta: { type: "text_delta", text: "(stream ended before completion)" },
				}),
				sse("content_block_stop", {
					type: "content_block_stop",
					index: fallbackIdx,
				}),
			);
		}

		events.push(
			sse("message_delta", {
				type: "message_delta",
				delta: {
					stop_reason: this.resolveStopReason(finishReason),
					stop_sequence: null,
				},
				// Anthropic spec: message_delta.usage carries output_tokens only.
				usage: {
					output_tokens: this.outputTokens,
				},
			}),
			sse("message_stop", { type: "message_stop" }),
		);

		return events;
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapFinishReason(reason: string | null): string {
	switch (reason) {
		case "stop":
			return "end_turn";
		case "tool_calls":
			return "tool_use";
		case "length":
			return "max_tokens";
		case "content_filter":
			return "end_turn";
		default:
			return "end_turn";
	}
}

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Anthropic requires an opaque `signature` on thinking blocks. This proxy has
 * no upstream signature to forward, so derive a deterministic placeholder: the
 * client needs the field present for the block to be schema-valid.
 *
 * The value is a pure function of the reasoning text (the whole block in the
 * non-streaming path, the first delta in the streaming one, where the full text
 * is not yet known). It carries no cryptographic meaning, is never verified,
 * and is never forwarded upstream — nothing on either side treats it as
 * anything but a required field.
 */
function thinkingSignature(thinking: string): string {
	return createHash("sha256").update(thinking, "utf8").digest("hex").slice(0, 32);
}

/**
 * Cheap prompt-size estimate (chars/4), matching the heuristic `count_tokens`
 * uses. Measured against the translated upstream request so it covers what is
 * actually sent, tool schemas included — it is an approximation for the
 * client's context meter, not a billing figure.
 *
 * An encoded image or document is charged a flat budget instead of its payload
 * length: one screenshot is a few thousand characters of base64 per pixel and
 * counting them verbatim would report hundreds of thousands of tokens for a
 * single image, making the client compact far too early.
 */
export function estimateTokens(value: unknown): number {
	return Math.max(1, Math.ceil(countEstimateChars(value) / 4));
}

/** Characters an attachment is charged, roughly 1500 tokens. */
const ATTACHMENT_TOKEN_BUDGET = 6000;

function countEstimateChars(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) {
		let total = 0;
		for (const item of value) total += countEstimateChars(item);
		return total;
	}
	if (!value || typeof value !== "object") return 0;

	const type = (value as { type?: unknown }).type;
	if (type === "image_url" || type === "file") return ATTACHMENT_TOKEN_BUDGET;

	let total = 0;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		total += key.length + countEstimateChars(item);
	}
	return total;
}

export function uid(): string {
	try {
		return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
	} catch {
		return (
			Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
		);
	}
}
