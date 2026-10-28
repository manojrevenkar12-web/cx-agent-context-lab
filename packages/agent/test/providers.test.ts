import { describe, expect, it } from "vitest";
import { AnthropicProvider, anthropicBody, type ModelRequest, OpenAIProvider, openaiBody, ProviderError, text } from "../src/index";

const req: ModelRequest = {
  system: [
    { id: "policies", text: "Policies.", stable: true },
    { id: "conversation", text: "Caller: gold tier.", stable: false },
  ],
  tools: [{ name: "get_booking", description: "Get a booking", inputSchema: { type: "object", properties: { booking_ref: { type: "string" } } } }],
  messages: [
    { role: "user", content: [text("Hi, booking ABC123")] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "get_booking", input: { booking_ref: "ABC123" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "tu1", content: '{"ok":true}' }] },
  ],
  maxTokens: 256,
  cache: "auto",
  cacheKey: "skyline-agent",
};

const sse = (events: Array<[string, unknown]>) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        // split mid-event to exercise buffering
        const s = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
        c.enqueue(enc.encode(s.slice(0, 37)));
        c.enqueue(enc.encode(s.slice(37)));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

describe("anthropic adapter", () => {
  it("puts cache_control on the tool list, the system end and the last message", () => {
    const body = anthropicBody(req, "claude-x") as {
      tools: Array<Record<string, unknown>>;
      system: Array<Record<string, unknown>>;
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.tools[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[2]?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1", cache_control: { type: "ephemeral" } });
    expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined();
    const marks = JSON.stringify(body).match(/cache_control/g) ?? [];
    expect(marks.length).toBeLessThanOrEqual(4);
  });

  it("sends no cache_control when caching is off", () => {
    expect(JSON.stringify(anthropicBody({ ...req, cache: "off" }, "claude-x"))).not.toContain("cache_control");
  });

  it("parses a streamed tool call, text and cache usage", async () => {
    const chunks: string[] = [];
    let sent: RequestInit | undefined;
    const p = new AnthropicProvider({
      apiKey: "k",
      model: "claude-x",
      fetch: (async (_u: string, init: RequestInit) => {
        sent = init;
        return sse([
          [
            "message_start",
            {
              type: "message_start",
              message: { usage: { input_tokens: 12, cache_read_input_tokens: 2048, cache_creation_input_tokens: 300, output_tokens: 1 } },
            },
          ],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu2", name: "get_booking", input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"booking_' } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ref":"ABC123"}' } }],
          ["content_block_stop", { type: "content_block_stop", index: 1 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } }],
          ["message_stop", { type: "message_stop" }],
        ]);
      }) as unknown as typeof fetch,
    });
    const r = await p.complete(req, { onText: (t) => chunks.push(t) });
    expect(JSON.parse(String(sent?.body)).stream).toBe(true);
    expect((sent?.headers ?? {}) as Record<string, string>).toMatchObject({ "anthropic-version": "2023-06-01" });
    expect(r.stopReason).toBe("tool_use");
    expect(r.content).toEqual([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu2", name: "get_booking", input: { booking_ref: "ABC123" } },
    ]);
    expect(r.usage).toEqual({ inputTokens: 12, cacheReadTokens: 2048, cacheWriteTokens: 300, outputTokens: 40 });
    expect(chunks.join("")).toBe("Let me check.");
  });

  it("marks rate limits and overload as retryable", async () => {
    const p = new AnthropicProvider({ apiKey: "k", model: "m", fetch: (async () => new Response("overloaded", { status: 529 })) as unknown as typeof fetch });
    const e = await p.complete(req).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).retryable).toBe(true);
  });
});

describe("openai adapter", () => {
  it("maps tool calls and results to Responses API items with a cache key", () => {
    const b = openaiBody(req, "gpt-x") as {
      input: Array<Record<string, unknown>>;
      prompt_cache_key: string;
      store: boolean;
      tools: Array<Record<string, unknown>>;
    };
    expect(b.prompt_cache_key).toBe("skyline-agent");
    expect(b.store).toBe(false);
    expect(b.input[1]).toEqual({ type: "function_call", call_id: "tu1", name: "get_booking", arguments: '{"booking_ref":"ABC123"}' });
    expect(b.input[2]).toEqual({ type: "function_call_output", call_id: "tu1", output: '{"ok":true}' });
    expect(b.tools[0]).toMatchObject({ type: "function", name: "get_booking" });
  });

  it("reads cached tokens from usage details", async () => {
    const p = new OpenAIProvider({
      apiKey: "k",
      model: "gpt-x",
      fetch: (async () =>
        sse([
          ["response.output_text.delta", { type: "response.output_text.delta", delta: "Done." }],
          [
            "response.completed",
            {
              type: "response.completed",
              response: {
                status: "completed",
                output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
                usage: { input_tokens: 3000, input_tokens_details: { cached_tokens: 2560 }, output_tokens: 4 },
              },
            },
          ],
        ])) as unknown as typeof fetch,
    });
    const r = await p.complete(req);
    expect(r.content).toEqual([{ type: "text", text: "Done." }]);
    expect(r.usage).toEqual({ inputTokens: 440, cacheReadTokens: 2560, cacheWriteTokens: 0, outputTokens: 4 });
    expect(r.stopReason).toBe("end_turn");
  });
});
