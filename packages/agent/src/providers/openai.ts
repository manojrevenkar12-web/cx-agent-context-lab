import type { Block, CompleteOptions, ModelRequest, ModelResponse, Provider } from "../types";
import { ProviderError, readSse } from "./sse";

type Json = Record<string, unknown>;

/**
 * The Responses API body. OpenAI caches prefixes automatically; `prompt_cache_key` routes requests
 * that share a prefix to the same cache. `store: false` keeps conversations out of OpenAI's storage.
 */
export function openaiBody(req: ModelRequest, model: string): Json {
  const input: Json[] = [];
  for (const m of req.messages) {
    const texts = m.content.filter((b) => b.type === "text");
    if (texts.length) {
      input.push({
        role: m.role,
        content: texts.map((b) => ({ type: m.role === "user" ? "input_text" : "output_text", text: b.text })),
      });
    }
    for (const b of m.content) {
      if (b.type === "tool_use") input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
      if (b.type === "tool_result") input.push({ type: "function_call_output", call_id: b.toolUseId, output: b.content });
    }
  }
  return {
    model,
    stream: true,
    store: false,
    max_output_tokens: req.maxTokens,
    instructions: req.system.map((p) => p.text).join("\n\n"),
    input,
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })) } : {}),
    ...(req.cacheKey && req.cache === "auto" ? { prompt_cache_key: req.cacheKey } : {}),
  };
}

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class OpenAIProvider implements Provider {
  readonly name = "openai" as const;
  readonly model: string;
  constructor(private readonly o: OpenAIOptions) {
    this.model = o.model;
  }

  async complete(req: ModelRequest, opts: CompleteOptions = {}): Promise<ModelResponse> {
    const f = this.o.fetch ?? fetch;
    const t0 = performance.now();
    const res = await f(`${this.o.baseUrl ?? "https://api.openai.com"}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
      body: JSON.stringify(openaiBody(req, this.model)),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) throw new ProviderError(res.status, await res.text());
    return parseOpenAIStream(res.body, t0, opts);
  }
}

export async function parseOpenAIStream(body: ReadableStream<Uint8Array>, t0: number, opts: CompleteOptions = {}): Promise<ModelResponse> {
  let ttft = 0;
  let final: Json | undefined;
  for await (const ev of readSse(body)) {
    const d = JSON.parse(ev.data) as Json;
    if (d.type === "response.output_text.delta") {
      if (!ttft) ttft = performance.now() - t0;
      opts.onText?.(String(d.delta));
    } else if (d.type === "response.function_call_arguments.delta") {
      if (!ttft) ttft = performance.now() - t0;
    } else if (d.type === "response.completed" || d.type === "response.incomplete") {
      final = d.response as Json;
    } else if (d.type === "response.failed" || d.type === "error") {
      throw new ProviderError(500, ev.data);
    }
  }
  if (!final) throw new ProviderError(502, "stream ended without response.completed");
  const content: Block[] = [];
  for (const item of (final.output as Json[]) ?? []) {
    if (item.type === "message") {
      const t = ((item.content as Json[]) ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => String(c.text))
        .join("");
      if (t) content.push({ type: "text", text: t });
    } else if (item.type === "function_call") {
      content.push({ type: "tool_use", id: String(item.call_id), name: String(item.name), input: JSON.parse(String(item.arguments || "{}")) as Json });
    }
  }
  const u = (final.usage as Json) ?? {};
  const cached = Number((u.input_tokens_details as Json | undefined)?.cached_tokens ?? 0);
  const total = performance.now() - t0;
  return {
    content,
    stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : final.status === "incomplete" ? "max_tokens" : "end_turn",
    usage: { inputTokens: Number(u.input_tokens ?? 0) - cached, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: Number(u.output_tokens ?? 0) },
    ttftMs: ttft || total,
    totalMs: total,
  };
}
