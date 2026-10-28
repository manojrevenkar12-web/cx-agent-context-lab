import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

// Every number that changes a result lives in config/*.yaml. The loaders are strict: an unknown or
// missing key is an error, not a silent default.

export const ROOT = process.env.CXLAB_ROOT ? resolve(process.env.CXLAB_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function readYaml(rel: string): unknown {
  return parse(readFileSync(join(ROOT, rel), "utf8"));
}

const anthropicCache = z.strictObject({
  kind: z.literal("breakpoints"),
  write_multiplier_5m: z.number(),
  write_multiplier_1h: z.number(),
  read_multiplier: z.number(),
  min_tokens: z.number().int(),
  max_breakpoints: z.number().int(),
  lookback_blocks: z.number().int(),
  ttl_seconds: z.number(),
});

const openaiCache = z.strictObject({
  kind: z.literal("automatic"),
  read_multiplier: z.number(),
  write_multiplier_5m: z.number(),
  min_tokens: z.number().int(),
  increment_tokens: z.number().int(),
  ttl_seconds: z.number(),
});

const provider = <T extends z.ZodType>(cache: T) =>
  z.strictObject({
    model: z.string(),
    input_per_mtok: z.number(),
    output_per_mtok: z.number(),
    cache,
  });

export const PricingSchema = z.strictObject({
  providers: z.strictObject({ anthropic: provider(anthropicCache), openai: provider(openaiCache) }),
});
export type Pricing = z.infer<typeof PricingSchema>;
export type AnthropicPricing = Pricing["providers"]["anthropic"];
export type OpenAIPricing = Pricing["providers"]["openai"];
export type ProviderName = keyof Pricing["providers"];

export const SimSchema = z.strictObject({
  latency: z.strictObject({
    base_ms: z.number(),
    prefill_ms_per_uncached_token: z.number(),
    prefill_ms_per_cached_token: z.number(),
    decode_ms_per_token: z.number(),
  }),
  tool_selection: z.strictObject({
    base: z.number(),
    per_doubling_over: z.number(),
    slope_per_doubling: z.number(),
    max: z.number(),
  }),
  summary: z.strictObject({ keeps: z.array(z.string()), output_tokens: z.number().int() }),
  output: z.strictObject({ tokens_per_reply_word: z.number() }),
});
export type SimConfig = z.infer<typeof SimSchema>;

export const loadPricing = (): Pricing => PricingSchema.parse(readYaml("config/pricing.yaml"));
export const loadSim = (): SimConfig => SimSchema.parse(readYaml("config/sim.yaml"));

export const AgentSchema = z.strictObject({
  max_tokens: z.number().int(),
  max_steps_per_turn: z.number().int(),
  tool_search: z.strictObject({ top_k: z.number().int() }),
  context: z.strictObject({
    window: z.strictObject({ keep_turns: z.number().int() }),
    summary: z.strictObject({ trigger_tokens: z.number().int(), keep_turns: z.number().int() }),
    casefile: z.strictObject({ budget_tokens: z.number().int(), keep_turns: z.number().int() }),
  }),
});
export type AgentSettings = z.infer<typeof AgentSchema>;
export const loadAgent = (): AgentSettings => AgentSchema.parse(readYaml("config/agent.yaml"));
