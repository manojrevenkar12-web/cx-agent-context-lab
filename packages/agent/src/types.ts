// The message model the loop works on. It mirrors what the provider APIs accept, without a framework
// in between: a conversation is an array of messages, each a list of content blocks.

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type Block = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: Block[];
}

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/**
 * A piece of the system prompt. `stable` parts are identical across turns and customers (persona,
 * policies); the rest changes per conversation or per turn (case file, current time). Where the
 * stable parts go relative to the rest decides whether the provider can reuse its cache.
 */
export interface SystemPart {
  id: string;
  text: string;
  stable: boolean;
}

export type CacheMode = "off" | "auto";

export interface ModelRequest {
  system: SystemPart[];
  tools: ToolDef[];
  messages: Message[];
  maxTokens: number;
  cache: CacheMode;
  /** Routing key for providers that cache by key (OpenAI `prompt_cache_key`). */
  cacheKey?: string;
}

export interface Usage {
  /** Input tokens neither read from nor written to the cache. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens";

export interface ModelResponse {
  content: Block[];
  stopReason: StopReason;
  usage: Usage;
  ttftMs: number;
  totalMs: number;
}

export interface CompleteOptions {
  signal?: AbortSignal;
  /** Streamed text as it arrives (the console shows it; voice would start speaking). */
  onText?: (delta: string) => void;
}

export interface Provider {
  readonly name: "anthropic" | "openai";
  readonly model: string;
  complete(req: ModelRequest, opts?: CompleteOptions): Promise<ModelResponse>;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export function text(t: string): TextBlock {
  return { type: "text", text: t };
}

export function textOf(m: Message): string {
  return m.content
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
    .filter(Boolean)
    .join("\n");
}
