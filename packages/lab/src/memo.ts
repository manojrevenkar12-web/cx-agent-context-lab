import type { BetResult, Verdict } from "./bets";
import { METRIC_LABEL, type MetricName } from "./metrics";

const NEXT: Record<Verdict, string> = {
  "hand-off":
    "Hand off to product engineering: ship the change behind the normal release process, and watch the primary metric and the guardrails in production for two weeks (cache read share and first-word p95 from provider usage fields; resolved rate from QA sampling).",
  publish:
    "Publish as internal guidance: the effect is real but below the hand-off bar. Fold it into the agent template and the solution-engineering playbook; no dedicated build.",
  iterate:
    "Iterate: the idea pays but breaks a guardrail, or the result rests on a simulator assumption. The memo names which; fix that and re-run, or confirm with a live run (LAB_LIVE=1) before anyone builds on it.",
  kill: "Kill: the variants do not clear the bar. Record why, so the idea is not re-run without new evidence.",
};

export function fmt(m: MetricName, v: number): string {
  if (m === "cost_per_conversation") return `$${v.toFixed(4)}`;
  if (m === "resolved_rate" || m === "cache_read_share" || m === "cache_write_share" || m === "handoff_rate") return `${(v * 100).toFixed(1)}%`;
  if (m.endsWith("_ms") || m.endsWith("_tokens")) return Math.round(v).toLocaleString("en-US");
  return v.toFixed(2);
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

export function memo(b: BetResult, meta: { seeds: number; scenarios: number }): string {
  const out: string[] = [];
  out.push(`# ${b.title}`, "");
  out.push(`**Verdict: ${b.verdict.toUpperCase()}.** ${b.headline}`, "");
  out.push(`**Question.** ${b.question}`, "");
  out.push("## What ran", "");
  out.push(
    `${meta.scenarios} scenarios from \`${b.scenarioSet}\`, ${meta.seeds} seeds each, as overlapping conversations sharing one provider cache. Costs and cache behaviour follow each provider's documented caching rules on the exact requests the real adapters would send (\`packages/agent/src/cache\`). Latency, tool confusion and summary loss are simulator parameters in \`config/sim.yaml\`; where a decision rests on them, the memo says so. Every comparison is paired by scenario and seed, with a ${(0.95 * 100).toFixed(0)}% bootstrap interval.`,
    "",
  );
  for (const r of b.runs) {
    out.push(`## ${r.provider}${r.chatterScale !== 1 ? `, calls ${r.chatterScale}x longer` : ""}`, "");
    const metrics: MetricName[] = [...new Set<MetricName>([b.primary, ...b.also, "resolved_rate", "repeat_asks", "cache_read_share"])];
    const arms = [r.baseline, ...r.arms];
    out.push(`| Metric | ${arms.map((a, i) => `${a.label}${i === 0 ? " (baseline)" : ""}`).join(" | ")} |`);
    out.push(`|---|${arms.map(() => "---:").join("|")}|`);
    for (const m of metrics) out.push(`| ${METRIC_LABEL[m]} | ${arms.map((a) => fmt(m, a.metrics[m])).join(" | ")} |`);
    out.push("");
    for (const v of r.variants) {
      const p = v.comparisons.find((c) => c.metric === b.primary);
      out.push(
        `**${v.label}: ${v.verdict}.** ${v.reasons.join("; ")}.${p ? ` Relative change on the primary metric ${pct(p.gain)} (positive is better).` : ""}`,
      );
      if (v.assumptions.length) out.push(`Rests on simulator assumptions: ${v.assumptions.join("; ")}.`);
      out.push("");
    }
    const fails = arms.filter((a) => Object.keys(a.failures).length);
    if (fails.length) {
      out.push("Failures seen (conversations):", "");
      for (const a of fails)
        out.push(
          `- ${a.label}: ${Object.entries(a.failures)
            .slice(0, 4)
            .map(([k, n]) => `${k} (${n})`)
            .join("; ")}`,
        );
      out.push("");
    }
  }
  out.push("## Next step", "", NEXT[b.verdict], "");
  out.push("## Limits", "");
  out.push(
    "- The model and the customers are simulated. The simulator only knows what is in each request, so information lost by a context strategy is really lost; but it does not make the mistakes a real model makes beyond the tool-confusion curve. A live run (`LAB_LIVE=1` with API keys) replaces the simulated model with Claude or GPT through the same adapters.",
    "- Token counts use the o200k tokenizer for both providers; Claude's tokenizer differs, so absolute Anthropic costs are approximate while comparisons between strategies hold.",
    "- OpenAI cache routing overflow at very high request rates on one prefix is not modelled.",
    "",
  );
  return out.join("\n");
}
