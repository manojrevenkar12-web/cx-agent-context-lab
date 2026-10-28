import { type ContextName, type Layout, readYaml, type ToolLoading } from "@cxlab/agent";
import { z } from "zod";
import { ALL_METRICS, type Comparison, compare, METRIC_LABEL, type MetricName, metric, summarise } from "./metrics";
import { type ConversationResult, configKey, type RunConfig, runConfig, type World } from "./run";
import { loadScenarios, type Scenario } from "./scenario";

const Metric = z.enum(ALL_METRICS as [MetricName, ...MetricName[]]);
const Partial = z.strictObject({
  layout: z.enum(["dynamic-first", "stable-first", "stable-tail"]).optional(),
  tools: z.enum(["all", "search-append", "search-dispatch"]).optional(),
  context: z.enum(["full", "window", "summary", "casefile"]).optional(),
  cache: z.enum(["off", "auto"]).optional(),
});

export const BetsSchema = z.strictObject({
  decision: z.strictObject({
    primary_min_gain: z.number(),
    primary_handoff_gain: z.number(),
    success_max_drop: z.number(),
    repeat_asks_max_rise: z.number(),
    bootstrap_samples: z.number().int(),
    ci: z.number(),
  }),
  bets: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      question: z.string(),
      scenarios: z.string(),
      tags: z.array(z.string()).optional(),
      chatter_scale: z.array(z.number().positive()).default([1]),
      providers: z.array(z.enum(["anthropic", "openai"])),
      fixed: Partial,
      baseline: Partial,
      variants: z.array(Partial).min(1),
      primary: Metric,
      also: z.array(Metric).default([]),
      assumption_metrics: z.array(Metric).default([]),
    }),
  ),
});
export type BetsConfig = z.infer<typeof BetsSchema>;
export type BetDef = BetsConfig["bets"][number];
export const loadBets = (): BetsConfig => BetsSchema.parse(readYaml("config/bets.yaml"));

export type Verdict = "hand-off" | "publish" | "iterate" | "kill";

export interface VariantOutcome {
  config: string;
  label: string;
  comparisons: Comparison[];
  verdict: Verdict;
  reasons: string[];
  assumptions: string[];
}

export interface BetRun {
  provider: string;
  chatterScale: number;
  baseline: { config: string; label: string; metrics: Record<MetricName, number>; failures: Record<string, number> };
  arms: Array<{ config: string; label: string; metrics: Record<MetricName, number>; failures: Record<string, number> }>;
  variants: VariantOutcome[];
  conversations: number;
}

export interface BetResult {
  id: string;
  title: string;
  question: string;
  scenarioSet: string;
  primary: MetricName;
  also: MetricName[];
  runs: BetRun[];
  verdict: Verdict;
  headline: string;
}

const label = (p: z.infer<typeof Partial>) =>
  Object.entries(p)
    .map(([, v]) => v)
    .join(" + ");

function failureCounts(rs: readonly ConversationResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rs)
    for (const f of r.grade.failures) {
      const k = f.replace(/\d+(\.\d+)?/g, "N").replace(/SK\w+/g, "SKN");
      out[k] = (out[k] ?? 0) + 1;
    }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** The decision rule, applied to one variant against the baseline. Thresholds from config/bets.yaml. */
export function decide(
  d: BetsConfig["decision"],
  bet: BetDef,
  cmp: Comparison[],
  base: readonly ConversationResult[],
  variant: readonly ConversationResult[],
): { verdict: Verdict; reasons: string[]; assumptions: string[] } {
  const primary = cmp.find((c) => c.metric === bet.primary) as Comparison;
  const name = METRIC_LABEL[bet.primary].replace(/ \(.*\)$/, "").toLowerCase();
  const reasons: string[] = [];
  const drop = metric("resolved_rate", base) - metric("resolved_rate", variant);
  const rise = metric("repeat_asks", variant) - metric("repeat_asks", base);
  const guardrails: string[] = [];
  if (drop > d.success_max_drop) guardrails.push(`resolved rate drops ${(drop * 100).toFixed(1)} points (limit ${(d.success_max_drop * 100).toFixed(0)})`);
  if (rise > d.repeat_asks_max_rise) guardrails.push(`repeat questions rise by ${rise.toFixed(2)} per conversation (limit ${d.repeat_asks_max_rise})`);
  const assumptions = bet.assumption_metrics
    .filter((m) => Math.abs(metric(m, variant) - metric(m, base)) > 1e-9)
    .map(
      (m) =>
        `${METRIC_LABEL[m].toLowerCase()} moved (${metric(m, base).toFixed(3)} → ${metric(m, variant).toFixed(3)}), and it is driven by a simulator assumption`,
    );
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const change = (c: Comparison) => (c.gain >= 0 ? `improves ${pct(c.gain)}` : `gets worse by ${pct(-c.gain)}`);
  let verdict: Verdict;
  if (primary.gain < d.primary_min_gain || primary.ci[1] <= 0) {
    verdict = "kill";
    reasons.push(`${name} ${change(primary)} (95% CI ${pct(primary.ci[0])} to ${pct(primary.ci[1])}); the bar is ${pct(d.primary_min_gain)}`);
    reasons.push(...guardrails);
  } else if (guardrails.length) {
    verdict = "iterate";
    reasons.push(`${name} ${change(primary)}, but a guardrail fails`, ...guardrails);
  } else if (primary.gain >= d.primary_handoff_gain && primary.ci[0] > 0) {
    verdict = "hand-off";
    reasons.push(`${name} improves ${pct(primary.gain)} (95% CI ${pct(primary.ci[0])} to ${pct(primary.ci[1])}) with guardrails held`);
  } else {
    verdict = primary.ci[0] > 0 ? "publish" : "iterate";
    reasons.push(
      `${name} improves ${pct(primary.gain)} (95% CI ${pct(primary.ci[0])} to ${pct(primary.ci[1])}): ${primary.ci[0] > 0 ? "real, below the hand-off bar" : "not yet distinguishable from noise"}`,
    );
  }
  return { verdict, reasons, assumptions };
}

const RANK: Record<Verdict, number> = { "hand-off": 3, publish: 2, iterate: 1, kill: 0 };

function scale(s: Scenario, k: number): Scenario {
  return k === 1 ? s : { ...s, chatter: Math.round(s.chatter * k) };
}

export async function runBet(world: World, cfg: BetsConfig, bet: BetDef, scenarioDir: string, onProgress?: (msg: string) => void): Promise<BetResult> {
  const all = loadScenarios(scenarioDir).filter((s) => !bet.tags?.length || bet.tags.some((t) => s.tags.includes(t)));
  const runs: BetRun[] = [];
  for (const provider of bet.providers) {
    for (const k of bet.chatter_scale) {
      const scenarios = all.map((s) => scale(s, k));
      const mk = (p: z.infer<typeof Partial>): RunConfig => ({
        provider,
        layout: (p.layout ?? bet.fixed.layout ?? "stable-tail") as Layout,
        tools: (p.tools ?? bet.fixed.tools ?? "all") as ToolLoading,
        context: (p.context ?? bet.fixed.context ?? "full") as ContextName,
        cache: p.cache ?? bet.fixed.cache ?? "auto",
      });
      const baseCfg = mk(bet.baseline);
      onProgress?.(`${bet.id} ${provider} x${k} ${configKey(baseCfg)}`);
      const base = await runConfig(world, baseCfg, scenarios);
      const arms: BetRun["arms"] = [];
      const variants: VariantOutcome[] = [];
      for (const v of bet.variants) {
        const vc = mk(v);
        onProgress?.(`${bet.id} ${provider} x${k} ${configKey(vc)}`);
        const res = await runConfig(world, vc, scenarios);
        arms.push({ config: configKey(vc), label: label(v), metrics: summarise(res), failures: failureCounts(res) });
        const metrics = [...new Set<MetricName>([bet.primary, ...bet.also, "resolved_rate", "repeat_asks"])];
        const comparisons = metrics.map((m) =>
          compare(m, base, res, cfg.decision.bootstrap_samples, cfg.decision.ci, `${bet.id}:${provider}:${k}:${configKey(vc)}`),
        );
        const d = decide(cfg.decision, bet, comparisons, base, res);
        variants.push({ config: configKey(vc), label: label(v), comparisons, ...d });
      }
      runs.push({
        provider,
        chatterScale: k,
        baseline: { config: configKey(baseCfg), label: label(bet.baseline), metrics: summarise(base), failures: failureCounts(base) },
        arms,
        variants,
        conversations: base.length,
      });
    }
  }
  const best = runs
    .flatMap((r) => r.variants.map((v) => ({ r, v })))
    .sort((a, b) => RANK[b.v.verdict] - RANK[a.v.verdict] || (b.v.comparisons[0]?.gain ?? 0) - (a.v.comparisons[0]?.gain ?? 0))[0];
  const verdict = best?.v.verdict ?? "kill";
  const headline = best
    ? `${verdict === "kill" ? "No variant clears the bar" : `${best.v.label}`}: ${best.v.reasons[0] ?? ""} (${best.r.provider}${best.r.chatterScale !== 1 ? `, ${best.r.chatterScale}x call length` : ""}).`
    : "Nothing ran.";
  return { id: bet.id, title: bet.title, question: bet.question, scenarioSet: scenarioDir, primary: bet.primary, also: bet.also, runs, verdict, headline };
}
