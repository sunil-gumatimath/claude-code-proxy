// ============================================================================
// types.ts — Shared Anthropic / OpenAI shapes used by the proxy
// ============================================================================

export type Role = "user" | "assistant" | "system" | "tool";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicTextBlock[];
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  role: Role;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicToolChoice {
  type: "auto" | "any" | "tool" | "none";
  name?: string;
}

export interface AnthropicMessagesRequest {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: { type: "enabled" | "disabled"; budget_tokens?: number };
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  index?: number;
}

export interface OpenAIMessage {
  role: string;
  content?: string | null | unknown[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string | null;
  annotations?: Array<unknown>;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** OpenAI reasoning-effort values; "" = derive from the thinking budget. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "";

export interface OpenAIChoice {
  index?: number;
  message?: OpenAIMessage;
  delta?: {
    content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
    role?: string;
    reasoning_content?: string | null;
  };
  finish_reason?: string | null;
}

export interface OpenAIChatResponse {
  id?: string;
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface AnthropicErrorBody {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}
