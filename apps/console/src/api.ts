// Types mirror reports/results.json and the API; kept narrow to what the console reads.

export type Verdict = "hand-off" | "publish" | "iterate" | "kill";
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

export interface Arm {
  config: string;
  label: string;
  metrics: Record<MetricName, number>;
  failures: Record<string, number>;
}

export interface VariantOutcome {
  config: string;
  label: string;
  verdict: Verdict;
  reasons: string[];
  assumptions: string[];
  comparisons: Array<{ metric: MetricName; base: number; variant: number; gain: number; ci: [number, number] }>;
}

export interface BetRun {
  provider: string;
  chatterScale: number;
  baseline: Arm;
  arms: Arm[];
  variants: VariantOutcome[];
  conversations: number;
}

export interface Bet {
  id: string;
  title: string;
  question: string;
  primary: MetricName;
  also: MetricName[];
  runs: BetRun[];
  verdict: Verdict;
  headline: string;
}

export interface Results {
  scenarioSet: string;
  seeds: number;
  bets: Bet[];
}

export interface ScenarioInfo {
  id: string;
  channel: "voice" | "chat";
  tags: string[];
  goals: string[];
  fare: string;
  tier: string;
  chatter: number;
}

export interface Options {
  providers: string[];
  layouts: string[];
  tools: string[];
  contexts: string[];
}

export class ApiError extends Error {}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `The lab API answered ${r.status} for ${path}.`);
  }
  return (await r.json()) as T;
}

export const api = {
  results: () => get<Results>("/api/results"),
  scenarios: () => get<ScenarioInfo[]>("/api/scenarios"),
  options: () => get<Options>("/api/options"),
};

export const METRIC_LABEL: Record<MetricName, string> = {
  cost_per_conversation: "Cost per conversation",
  resolved_rate: "Resolved without breach",
  first_word_p50_ms: "First word, median",
  first_word_p95_ms: "First word, p95",
  cache_read_share: "Input read from cache",
  cache_write_share: "Input written to cache",
  wrong_tool_calls: "Wrong-tool calls",
  repeat_asks: "Repeat questions",
  model_calls: "Model calls",
  input_tokens: "Input tokens",
  transcript_tokens: "Transcript tokens",
  handoff_rate: "Handed to a person",
};

export function formatMetric(m: MetricName, v: number): string {
  if (m === "cost_per_conversation") return `$${v.toFixed(4)}`;
  if (m === "resolved_rate" || m === "cache_read_share" || m === "cache_write_share" || m === "handoff_rate") return `${(v * 100).toFixed(1)}%`;
  if (m.endsWith("_ms")) return `${Math.round(v).toLocaleString("en-US")} ms`;
  if (m.endsWith("_tokens")) return Math.round(v).toLocaleString("en-US");
  return v.toFixed(2);
}
