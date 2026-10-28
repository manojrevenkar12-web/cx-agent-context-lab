import { placeBreakpoints } from "../cache/breakpoints";
import { render } from "../render";
import type { Block, CompleteOptions, ModelRequest, ModelResponse, Provider, StopReason } from "../types";
import { ProviderError, readSse } from "./sse";

type Json = Record<string, unknown>;
const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * The Messages API request body for a request, with `cache_control` on the blocks the shared
 * breakpoint rule picks. Pure, so tests check exactly what would be sent.
 */
export function anthropicBody(req: ModelRequest, model: string, maxBreakpoints = 4): Json {
  const bps = req.cache === "auto" ? new Set(placeBreakpoints(render(req), maxBreakpoints)) : new Set<number>();
  let i = 0;
  const mark = <T extends Json>(o: T): T => (bps.has(i++) ? { ...o, cache_control: EPHEMERAL } : o);
  const tools = req.tools.map((t) => mark({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const system = req.system.map((p) => mark({ type: "text", text: p.text }));
  const messages = req.messages.map((m) => ({ role: m.role, content: m.content.map((b) => mark(blockJson(b))) }));
  return { model, max_tokens: req.maxTokens, stream: true, ...(tools.length ? { tools } : {}), system, messages };
}

function blockJson(b: Block): Json {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
  }
}

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;
  readonly model: string;
  constructor(private readonly o: AnthropicOptions) {
    this.model = o.model;
  }

  async complete(req: ModelRequest, opts: CompleteOptions = {}): Promise<ModelResponse> {
    const f = this.o.fetch ?? fetch;
    const t0 = performance.now();
    const res = await f(`${this.o.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.o.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(anthropicBody(req, this.model)),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) throw new ProviderError(res.status, await res.text());
    return parseAnthropicStream(res.body, t0, opts);
  }
}

export async function parseAnthropicStream(body: ReadableStream<Uint8Array>, t0: number, opts: CompleteOptions = {}): Promise<ModelResponse> {
  const content: Block[] = [];
  const partial: string[] = [];
  let ttft = 0;
  let stop: StopReason = "end_turn";
  const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  for await (const ev of readSse(body)) {
    const d = JSON.parse(ev.data) as Json;
    switch (d.type) {
      case "message_start": {
        const u = (d.message as Json).usage as Json;
        usage.inputTokens = Number(u.input_tokens ?? 0);
        usage.cacheReadTokens = Number(u.cache_read_input_tokens ?? 0);
        usage.cacheWriteTokens = Number(u.cache_creation_input_tokens ?? 0);
        usage.outputTokens = Number(u.output_tokens ?? 0);
        break;
      }
      case "content_block_start": {
        const cb = d.content_block as Json;
        const idx = Number(d.index);
        content[idx] =
          cb.type === "tool_use" ? { type: "tool_use", id: String(cb.id), name: String(cb.name), input: {} } : { type: "text", text: String(cb.text ?? "") };
        partial[idx] = "";
        break;
      }
      case "content_block_delta": {
        if (!ttft) ttft = performance.now() - t0;
        const idx = Number(d.index);
        const delta = d.delta as Json;
        const b = content[idx];
        if (delta.type === "text_delta" && b?.type === "text") {
          b.text += String(delta.text);
          opts.onText?.(String(delta.text));
        } else if (delta.type === "input_json_delta") {
          partial[idx] = (partial[idx] ?? "") + String(delta.partial_json);
        }
        break;
      }
      case "content_block_stop": {
        const idx = Number(d.index);
        const b = content[idx];
        if (b?.type === "tool_use") b.input = partial[idx] ? (JSON.parse(partial[idx] as string) as Json) : {};
        break;
      }
      case "message_delta": {
        const r = (d.delta as Json).stop_reason;
        if (r === "tool_use" || r === "max_tokens" || r === "end_turn") stop = r;
        const u = d.usage as Json | undefined;
        if (u?.output_tokens !== undefined) usage.outputTokens = Number(u.output_tokens);
        break;
      }
      case "error":
        throw new ProviderError(500, ev.data);
    }
  }
  const total = performance.now() - t0;
  return { content: content.filter(Boolean), stopReason: stop, usage, ttftMs: ttft || total, totalMs: total };
}
