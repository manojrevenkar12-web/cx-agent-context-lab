import {
  Agent,
  type AgentEvent,
  type AgentSettings,
  type CacheMode,
  type ContextName,
  costUsd,
  type Layout,
  loadAgent,
  loadPricing,
  loadSim,
  makeContext,
  type Pricing,
  type Provider,
  type ProviderName,
  readYaml,
  type SimConfig,
  SimProvider,
  ToolLoader,
  type ToolLoading,
  VirtualClock,
} from "@cxlab/agent";
import { CATALOGUE, conversationContext, loadSkyline, rng, Schedule, SkylineBackend, type SkylineRules, STABLE_SYSTEM } from "@cxlab/skyline";
import { z } from "zod";
import { SimCustomer } from "./customer";
import { caseFileText } from "./facts";
import { type Grade, grade, type TimelineEvent } from "./grade";
import { SkylinePolicy } from "./policy";
import { bookingOf, type Scenario } from "./scenario";

export const LabSchema = z.strictObject({
  seeds: z.number().int().min(1),
  arrival_gap_seconds: z.number().positive(),
  think_seconds: z.strictObject({ voice: z.tuple([z.number(), z.number()]), chat: z.tuple([z.number(), z.number()]) }),
  max_customer_turns: z.number().int(),
  max_repeat_asks: z.number().int(),
  chatter_probability: z.number().min(0).max(1),
  wall_clock_start: z.string().regex(/^\d\d:\d\d$/),
});
export type LabSettings = z.infer<typeof LabSchema>;
export const loadLab = (): LabSettings => LabSchema.parse(readYaml("config/lab.yaml"));

export interface RunConfig {
  provider: ProviderName;
  layout: Layout;
  tools: ToolLoading;
  context: ContextName;
  cache: CacheMode;
}

export const configKey = (c: RunConfig) => `${c.provider}/${c.layout}/${c.tools}/${c.context}/cache-${c.cache}`;

export interface TurnTrace {
  customer: string;
  reply: string;
  firstWordMs: number;
  calls: Array<{ purpose: string; read: number; write: number; uncached: number; output: number; ttftMs: number }>;
  tools: Array<{ name: string; isError: boolean }>;
}

export interface ConversationResult {
  scenario: string;
  tags: string[];
  seed: number;
  config: string;
  grade: Grade;
  turns: number;
  repeatAsks: number;
  handedOff: boolean;
  exhausted: number;
  modelCalls: number;
  summaryCalls: number;
  toolCalls: number;
  tokens: { uncached: number; read: number; write: number; output: number };
  costUsd: number;
  firstWordMs: number[];
  durationMs: number;
  transcriptTokens: number;
  trace?: TurnTrace[];
}

export interface World {
  pricing: Pricing;
  sim: SimConfig;
  agent: AgentSettings;
  lab: LabSettings;
  rules: SkylineRules;
  schedule: Schedule;
}

export function loadWorld(): World {
  const rules = loadSkyline();
  return { pricing: loadPricing(), sim: loadSim(), agent: loadAgent(), lab: loadLab(), rules, schedule: new Schedule(rules) };
}

export interface ConversationOptions {
  world: World;
  provider: Provider;
  clock: VirtualClock | { now(): number; sleep(ms: number): Promise<void> };
  config: RunConfig;
  scenario: Scenario;
  seed: number;
  trace?: boolean;
  onEvent?: (e: AgentEvent | { type: "customer"; text: string }) => void;
}

/** One customer conversation with the agent, start to finish, graded. */
export async function runConversation(o: ConversationOptions): Promise<ConversationResult> {
  const { world, scenario: s, config: cfg, clock } = o;
  const t0 = clock.now();
  const year = Number(world.rules.today.slice(0, 4));
  const startWall = s.call_at ? Date.parse(`${s.call_at}:00Z`) : Date.parse(`${world.rules.today}T${world.lab.wall_clock_start}:00Z`) + t0;
  const wallNow = () => startWall + (clock.now() - t0);
  const flight = world.schedule.search(...(s.booking.route.split("-") as [string, string]), s.booking.date).find((f) => f.slot === s.booking.slot);
  if (!flight) throw new Error(`${s.id}: no ${s.booking.slot} flight on ${s.booking.route} ${s.booking.date}`);
  const initial = bookingOf(s, flight.flight_no);
  let seq = 0;
  const next = () => seq++;
  const backend = new SkylineBackend(world.rules, [initial], wallNow, next, world.schedule);
  const timeline: TimelineEvent[] = [];
  const traces: TurnTrace[] = [];
  let current: TurnTrace | undefined;
  const tokens = { uncached: 0, read: 0, write: 0, output: 0 };
  let cost = 0;
  let summaryCalls = 0;
  const agent = new Agent({
    provider: o.provider,
    clock,
    stableSystem: STABLE_SYSTEM,
    conversationContext: conversationContext({ channel: s.channel, tier: s.booking.tier, callerId: `caller-${s.id}-${o.seed}`, language: "en" }),
    tools: new ToolLoader(cfg.tools, CATALOGUE, backend, world.agent.tool_search.top_k),
    context: makeContext(cfg.context, world.agent.context),
    layout: cfg.layout,
    cache: cfg.cache,
    maxTokens: world.agent.max_tokens,
    maxSteps: world.agent.max_steps_per_turn,
    caseFile: (h) => caseFileText(h, year),
    cacheKey: "skyline-cx-agent",
    onEvent: (e) => {
      o.onEvent?.(e);
      if (e.type === "model") {
        tokens.uncached += e.usage.inputTokens;
        tokens.read += e.usage.cacheReadTokens;
        tokens.write += e.usage.cacheWriteTokens;
        tokens.output += e.usage.outputTokens;
        cost += costUsd(world.pricing, cfg.provider, e.usage);
        if (e.purpose === "summary") summaryCalls++;
        current?.calls.push({
          purpose: e.purpose,
          read: e.usage.cacheReadTokens,
          write: e.usage.cacheWriteTokens,
          uncached: e.usage.inputTokens,
          output: e.usage.outputTokens,
          ttftMs: Math.round(e.ttftMs),
        });
      } else if (e.type === "tool") current?.tools.push({ name: e.name === "call_tool" ? String(e.input.name) : e.name, isError: e.isError });
    },
  });
  const customer = new SimCustomer(s, o.seed, flight.flight_no, {
    maxRepeatAsks: world.lab.max_repeat_asks,
    chatterProbability: world.lab.chatter_probability,
  });
  const think = rng(`think:${s.id}:${o.seed}`);
  const [lo, hi] = world.lab.think_seconds[s.channel];
  let msg: string | null = customer.opening();
  let modelCalls = 0;
  let toolCalls = 0;
  let exhausted = 0;
  const firstWord: number[] = [];
  while (msg !== null && customer.turns <= world.lab.max_customer_turns) {
    timeline.push({ seq: next(), who: "customer", text: msg });
    o.onEvent?.({ type: "customer", text: msg });
    current = { customer: msg, reply: "", firstWordMs: 0, calls: [], tools: [] };
    const r = await agent.turn(msg, new Date(wallNow()).toISOString().slice(0, 16).replace("T", " "));
    timeline.push({ seq: next(), who: "agent", text: r.reply });
    current.reply = r.reply;
    current.firstWordMs = Math.round(r.firstWordMs);
    if (o.trace) traces.push(current);
    modelCalls += r.modelCalls;
    toolCalls += r.toolCalls;
    if (r.exhausted) exhausted++;
    firstWord.push(r.firstWordMs);
    await clock.sleep((lo + think() * (hi - lo)) * 1000);
    msg = customer.reply(r.reply);
  }
  const g = grade(s, backend, initial, startWall, timeline, customer);
  if (exhausted) g.failures.push(`agent ran out of steps ${exhausted} time(s)`);
  g.success = g.failures.length === 0;
  return {
    scenario: s.id,
    tags: s.tags,
    seed: o.seed,
    config: configKey(cfg),
    grade: g,
    turns: customer.turns,
    repeatAsks: customer.repeatAsks,
    handedOff: backend.handoffs.length > 0 || customer.handedOff,
    exhausted,
    modelCalls,
    summaryCalls,
    toolCalls,
    tokens,
    costUsd: cost,
    firstWordMs: firstWord,
    durationMs: clock.now() - t0,
    transcriptTokens: agent.transcriptTokens(),
    ...(o.trace ? { trace: traces } : {}),
  };
}

/**
 * Every scenario x seed under one configuration, as overlapping conversations on one virtual
 * clock that share one provider (and so one prompt cache), like a contact centre's traffic.
 */
export async function runConfig(
  world: World,
  cfg: RunConfig,
  scenarios: Scenario[],
  opts: { seeds?: number; trace?: boolean } = {},
): Promise<ConversationResult[]> {
  const clock = new VirtualClock(0);
  const provider = new SimProvider(cfg.provider, world.pricing, world.sim, clock, new SkylinePolicy(world.sim, Number(world.rules.today.slice(0, 4))));
  const seeds = opts.seeds ?? world.lab.seeds;
  const jobs: Array<{ s: Scenario; seed: number }> = [];
  for (let seed = 0; seed < seeds; seed++) for (const s of scenarios) jobs.push({ s, seed });
  const gap = world.lab.arrival_gap_seconds * 1000;
  return clock.run(
    jobs.map((j, k) => async () => {
      await clock.sleep(k * gap);
      return runConversation({ world, provider, clock, config: cfg, scenario: j.s, seed: j.seed, ...(opts.trace ? { trace: true } : {}) });
    }),
  );
}
