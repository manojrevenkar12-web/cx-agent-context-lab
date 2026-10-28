import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AnthropicProvider, OpenAIProvider, type Provider, ROOT, readYaml, realClock } from "@cxlab/agent";
import { z } from "zod";
import { type BetResult, loadBets, runBet } from "./bets";
import { memo } from "./memo";
import { summarise } from "./metrics";
import { configKey, loadWorld, type RunConfig, runConfig, runConversation } from "./run";
import { loadScenarios } from "./scenario";

const GateSchema = z.strictObject({
  recommended: z.strictObject({ layout: z.string(), tools: z.string(), context: z.string(), cache: z.string() }),
  min_resolved_rate: z.number(),
  max_policy_breaches: z.number().int(),
  min_cache_read_share: z.number(),
  heldout_required: z.array(z.string()),
});

const write = (rel: string, body: string) => {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body.endsWith("\n") ? body : `${body}\n`);
};
const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

function parseConfig(s: string): RunConfig {
  const [provider, layout, tools, context, cache] = s.split("/");
  return { provider, layout, tools, context, cache: (cache ?? "cache-auto").replace("cache-", "") } as RunConfig;
}

async function bets(): Promise<void> {
  const world = loadWorld();
  const cfg = loadBets();
  const only = arg("only");
  const set = arg("set", "scenarios/dev") as string;
  const results: BetResult[] = [];
  for (const bet of cfg.bets.filter((b) => !only || b.id === only)) {
    const r = await runBet(world, cfg, bet, set, (m) => console.error(`  running ${m}`));
    results.push(r);
    const n = loadScenarios(set).filter((s) => !bet.tags?.length || bet.tags.some((t) => s.tags.includes(t))).length;
    write(`reports/bets/${bet.id}.md`, memo(r, { seeds: world.lab.seeds, scenarios: n }));
    console.log(`${bet.id}: ${r.verdict.toUpperCase()} — ${r.headline}`);
  }
  if (!only) write("reports/results.json", JSON.stringify({ scenarioSet: set, seeds: world.lab.seeds, bets: results }, null, 1));
}

async function heldout(): Promise<void> {
  const set = process.argv[3];
  if (!set) throw new Error("usage: lab heldout <set>");
  const dir = `heldout/${set}`;
  const world = loadWorld();
  const gate = GateSchema.parse(readYaml("config/gate.yaml"));
  const scenarios = loadScenarios(dir);
  const files = readFileSync(join(ROOT, dir, "scenarios.yaml"));
  const configs: RunConfig[] = (["anthropic", "openai"] as const).map((provider) => ({ provider, ...gate.recommended }) as RunConfig);
  const out: Record<string, unknown> = { set, scenarios_sha256: createHash("sha256").update(files).digest("hex"), seeds: world.lab.seeds, configs: {} };
  for (const c of configs) {
    const rs = await runConfig(world, c, scenarios);
    (out.configs as Record<string, unknown>)[configKey(c)] = {
      metrics: summarise(rs),
      failed: rs.filter((r) => !r.grade.success).map((r) => ({ scenario: r.scenario, seed: r.seed, failures: r.grade.failures })),
    };
  }
  const first = `reports/heldout/${set}/first_run.json`;
  const status = existsSync(join(ROOT, dir, "STATUS")) ? readFileSync(join(ROOT, dir, "STATUS"), "utf8").trim() : "heldout";
  if (!existsSync(join(ROOT, first))) {
    write(first, JSON.stringify(out, null, 1));
    console.log(`first run recorded: ${first}`);
  } else {
    const prev = JSON.parse(readFileSync(join(ROOT, first), "utf8")) as { scenarios_sha256: string };
    if (prev.scenarios_sha256 !== out.scenarios_sha256) throw new Error(`${dir} changed after its first run; write a new set instead`);
    write(`reports/heldout/${set}/latest.json`, JSON.stringify(out, null, 1));
    console.log(`latest run written (first run kept); status: ${status}`);
  }
  for (const [k, v] of Object.entries(out.configs as Record<string, { metrics: { resolved_rate: number } }>))
    console.log(`${k}: resolved ${(v.metrics.resolved_rate * 100).toFixed(1)}%`);
}

async function gate(): Promise<void> {
  const g = GateSchema.parse(readYaml("config/gate.yaml"));
  const world = loadWorld();
  const scenarios = loadScenarios("scenarios/dev");
  const problems: string[] = [];
  for (const provider of ["anthropic", "openai"] as const) {
    const c = { provider, ...g.recommended } as RunConfig;
    const rs = await runConfig(world, c, scenarios);
    const m = summarise(rs);
    const breaches = rs.reduce((n, r) => n + r.grade.breaches.length, 0);
    console.log(`${configKey(c)}: resolved ${(m.resolved_rate * 100).toFixed(1)}%, breaches ${breaches}, cache read ${(m.cache_read_share * 100).toFixed(1)}%`);
    if (m.resolved_rate < g.min_resolved_rate) problems.push(`${provider}: resolved ${(m.resolved_rate * 100).toFixed(1)}% < ${g.min_resolved_rate * 100}%`);
    if (breaches > g.max_policy_breaches) problems.push(`${provider}: ${breaches} policy breaches`);
    if (m.cache_read_share < g.min_cache_read_share) problems.push(`${provider}: cache read share ${(m.cache_read_share * 100).toFixed(1)}%`);
  }
  for (const set of g.heldout_required)
    if (!existsSync(join(ROOT, `reports/heldout/${set}/first_run.json`))) problems.push(`held-out set ${set} has no first run on record`);
  if (problems.length) {
    console.error(`GATE FAILED\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("gate passed");
}

async function run(): Promise<void> {
  const id = arg("scenario");
  const c = parseConfig(arg("config", "anthropic/stable-tail/search-dispatch/full/cache-auto") as string);
  const world = loadWorld();
  const s = loadScenarios(arg("set", "scenarios/dev") as string).find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  let provider: Provider | undefined;
  if (process.env.LAB_LIVE === "1") {
    provider =
      c.provider === "anthropic"
        ? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5" })
        : new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY ?? "", model: process.env.OPENAI_MODEL ?? "gpt-5" });
    const r = await runConversation({ world, provider, clock: realClock, config: c, scenario: s, seed: 0, trace: true });
    console.log(JSON.stringify(r, null, 1));
    return;
  }
  const [r] = await runConfig(world, c, [s], { seeds: 1, trace: true });
  if (!r) return;
  for (const t of r.trace ?? []) {
    console.log(`customer: ${t.customer}`);
    for (const k of t.calls) console.log(`  model ${k.purpose}: read ${k.read} write ${k.write} uncached ${k.uncached} out ${k.output} ttft ${k.ttftMs}ms`);
    if (t.tools.length) console.log(`  tools: ${t.tools.map((x) => `${x.name}${x.isError ? " (error)" : ""}`).join(", ")}`);
    console.log(`agent:    ${t.reply}\n`);
  }
  console.log(`${r.grade.success ? "RESOLVED" : `FAILED: ${r.grade.failures.join("; ")}`} — $${r.costUsd.toFixed(4)}, ${r.modelCalls} model calls`);
}

const cmd = process.argv[2];
const commands: Record<string, () => Promise<void>> = { bets, heldout, gate, run };
const fn = cmd ? commands[cmd] : undefined;
if (!fn) {
  console.error("usage: lab <bets|run|heldout|gate> [--only id] [--set dir] [--scenario id --config p/layout/tools/context/cache-auto]");
  process.exit(2);
}
fn().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
