import { rng } from "@cxlab/skyline";
import type { ConversationResult } from "./run";

export type MetricName =
  | "cost_per_conversation"
  | "resolved_rate"
  | "first_word_p50_ms"
  | "first_word_p95_ms"
  | "cache_read_share"
  | "cache_write_share"
  | "wrong_tool_calls"
  | "repeat_asks"
  | "model_calls"
  | "input_tokens"
  | "transcript_tokens"
  | "handoff_rate";

export const LOWER_IS_BETTER: Record<MetricName, boolean> = {
  cost_per_conversation: true,
  resolved_rate: false,
  first_word_p50_ms: true,
  first_word_p95_ms: true,
  cache_read_share: false,
  cache_write_share: true,
  wrong_tool_calls: true,
  repeat_asks: true,
  model_calls: true,
  input_tokens: true,
  transcript_tokens: true,
  handoff_rate: true,
};

export const METRIC_LABEL: Record<MetricName, string> = {
  cost_per_conversation: "Cost per conversation (USD)",
  resolved_rate: "Resolved without breach",
  first_word_p50_ms: "First word, median (ms)",
  first_word_p95_ms: "First word, p95 (ms)",
  cache_read_share: "Input read from cache",
  cache_write_share: "Input written to cache",
  wrong_tool_calls: "Wrong-tool calls per conversation",
  repeat_asks: "Repeat questions per conversation",
  model_calls: "Model calls per conversation",
  input_tokens: "Input tokens per conversation",
  transcript_tokens: "Transcript tokens per conversation",
  handoff_rate: "Handed to a person",
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}

export function metric(name: MetricName, rs: readonly ConversationResult[]): number {
  switch (name) {
    case "cost_per_conversation":
      return mean(rs.map((r) => r.costUsd));
    case "resolved_rate":
      return mean(rs.map((r) => (r.grade.success ? 1 : 0)));
    case "first_word_p50_ms":
      return quantile(
        rs.flatMap((r) => r.firstWordMs),
        0.5,
      );
    case "first_word_p95_ms":
      return quantile(
        rs.flatMap((r) => r.firstWordMs),
        0.95,
      );
    case "cache_read_share": {
      const read = rs.reduce((n, r) => n + r.tokens.read, 0);
      const all = rs.reduce((n, r) => n + r.tokens.read + r.tokens.write + r.tokens.uncached, 0);
      return all ? read / all : 0;
    }
    case "cache_write_share": {
      const write = rs.reduce((n, r) => n + r.tokens.write, 0);
      const all = rs.reduce((n, r) => n + r.tokens.read + r.tokens.write + r.tokens.uncached, 0);
      return all ? write / all : 0;
    }
    case "wrong_tool_calls":
      return mean(rs.map((r) => r.grade.wrongToolCalls));
    case "repeat_asks":
      return mean(rs.map((r) => r.repeatAsks));
    case "model_calls":
      return mean(rs.map((r) => r.modelCalls));
    case "input_tokens":
      return mean(rs.map((r) => r.tokens.read + r.tokens.write + r.tokens.uncached));
    case "transcript_tokens":
      return mean(rs.map((r) => r.transcriptTokens));
    case "handoff_rate":
      return mean(rs.map((r) => (r.handedOff ? 1 : 0)));
  }
}

export const ALL_METRICS = Object.keys(LOWER_IS_BETTER) as MetricName[];

export function summarise(rs: readonly ConversationResult[]): Record<MetricName, number> {
  return Object.fromEntries(ALL_METRICS.map((m) => [m, metric(m, rs)])) as Record<MetricName, number>;
}

export interface Comparison {
  metric: MetricName;
  base: number;
  variant: number;
  /** Relative improvement: positive is better, whichever direction the metric runs. */
  gain: number;
  ci: [number, number];
}

/**
 * Paired bootstrap: conversations are matched by scenario and seed, pairs are resampled together,
 * and the relative improvement is recomputed on each resample.
 */
export function compare(
  name: MetricName,
  base: readonly ConversationResult[],
  variant: readonly ConversationResult[],
  samples: number,
  ci: number,
  seed: string,
): Comparison {
  const key = (r: ConversationResult) => `${r.scenario}#${r.seed}`;
  const vb = new Map(variant.map((r) => [key(r), r]));
  const pairs = base.flatMap((b) => {
    const v = vb.get(key(b));
    return v ? [[b, v] as const] : [];
  });
  const rel = (b: number, v: number) => (b === 0 ? (v === 0 ? 0 : LOWER_IS_BETTER[name] ? -1 : 1) : (LOWER_IS_BETTER[name] ? b - v : v - b) / Math.abs(b));
  const B = metric(
    name,
    pairs.map((p) => p[0]),
  );
  const V = metric(
    name,
    pairs.map((p) => p[1]),
  );
  const r = rng(`bootstrap:${seed}:${name}`);
  const gains: number[] = [];
  for (let s = 0; s < samples; s++) {
    const pick = pairs.map(() => pairs[Math.floor(r() * pairs.length)] as (typeof pairs)[number]);
    gains.push(
      rel(
        metric(
          name,
          pick.map((p) => p[0]),
        ),
        metric(
          name,
          pick.map((p) => p[1]),
        ),
      ),
    );
  }
  const a = (1 - ci) / 2;
  return { metric: name, base: B, variant: V, gain: rel(B, V), ci: [quantile(gains, a), quantile(gains, 1 - a)] };
}
