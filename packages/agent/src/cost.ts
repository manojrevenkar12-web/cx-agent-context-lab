import type { Pricing, ProviderName, SimConfig } from "./config";
import type { Usage } from "./types";

/** US dollars for one response, by the provider's list prices and cache multipliers. */
export function costUsd(p: Pricing, provider: ProviderName, u: Usage): number {
  const c = p.providers[provider];
  const inPrice = c.input_per_mtok / 1e6;
  return (
    u.inputTokens * inPrice +
    u.cacheReadTokens * inPrice * c.cache.read_multiplier +
    u.cacheWriteTokens * inPrice * c.cache.write_multiplier_5m +
    u.outputTokens * (c.output_per_mtok / 1e6)
  );
}

/**
 * Simulated latency. Prefill time scales with the tokens the provider must process; cached tokens
 * are cheap to load. Cache writes are processed like plain input.
 */
export function latencyMs(s: SimConfig, u: Usage): { ttftMs: number; totalMs: number } {
  const l = s.latency;
  const ttft = l.base_ms + (u.inputTokens + u.cacheWriteTokens) * l.prefill_ms_per_uncached_token + u.cacheReadTokens * l.prefill_ms_per_cached_token;
  return { ttftMs: ttft, totalMs: ttft + u.outputTokens * l.decode_ms_per_token };
}
