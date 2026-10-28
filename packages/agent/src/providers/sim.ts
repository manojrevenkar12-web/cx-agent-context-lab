import { AnthropicCacheSim, type CacheSim, type CacheSplit, OpenAICacheSim } from "../cache/sim";
import type { Clock } from "../clock";
import type { Pricing, ProviderName, SimConfig } from "../config";
import { latencyMs } from "../cost";
import { blockText, render } from "../render";
import { countTokens } from "../tokens";
import type { Block, CompleteOptions, ModelRequest, ModelResponse, Provider } from "../types";

/**
 * What the simulated model says. A responder sees only the request, as a real model would: it
 * must find every fact it uses in the system prompt, the tools or the messages it is given.
 */
export interface Responder {
  respond(req: ModelRequest): Block[];
}

export interface SimCall {
  at: number;
  split: CacheSplit;
  blocks: number;
  response: ModelResponse;
}

/**
 * A provider that bills each request by that provider's documented caching rules on the exact
 * blocks the real adapter would send, takes time on the given clock, and answers with a responder.
 */
export class SimProvider implements Provider {
  readonly model: string;
  readonly cache: CacheSim;
  readonly calls: SimCall[] = [];

  constructor(
    readonly name: ProviderName,
    pricing: Pricing,
    private readonly sim: SimConfig,
    private readonly clock: Clock,
    private readonly responder: Responder,
    cache?: CacheSim,
  ) {
    const p = pricing.providers[name];
    this.model = `sim:${p.model}`;
    this.cache =
      cache ?? (name === "anthropic" ? new AnthropicCacheSim(pricing.providers.anthropic.cache) : new OpenAICacheSim(pricing.providers.openai.cache));
  }

  async complete(req: ModelRequest, opts: CompleteOptions = {}): Promise<ModelResponse> {
    const at = this.clock.now();
    const blocks = render(req);
    const split = this.cache.apply(blocks, req.cache === "auto", at);
    const content = this.responder.respond(req);
    const outputTokens = content.reduce((n, b) => n + countTokens(blockText(b)), 0);
    const usage = { inputTokens: split.uncached, cacheReadTokens: split.read, cacheWriteTokens: split.write, outputTokens };
    const { ttftMs, totalMs } = latencyMs(this.sim, usage);
    await this.clock.sleep(ttftMs);
    for (const b of content) if (b.type === "text") opts.onText?.(b.text);
    await this.clock.sleep(totalMs - ttftMs);
    const response: ModelResponse = {
      content,
      stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      usage,
      ttftMs,
      totalMs,
    };
    this.calls.push({ at, split, blocks: blocks.length, response });
    return response;
  }
}
