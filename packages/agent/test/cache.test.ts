import { describe, expect, it } from "vitest";
import { AnthropicCacheSim, loadPricing, type ModelRequest, OpenAICacheSim, placeBreakpoints, render, type SystemPart, text } from "../src/index";

const pricing = loadPricing();
const A = pricing.providers.anthropic.cache;
const O = pricing.providers.openai.cache;

const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 97}`).join(" ");
const tools = Array.from({ length: 6 }, (_, i) => ({
  name: `tool_${i}`,
  description: words(120, `t${i}x`),
  inputSchema: { type: "object", properties: {} },
}));
const stable: SystemPart = { id: "policies", text: words(900, "p"), stable: true };

function req(time: string, turns: number, layout: "dynamic" | "stable" = "stable"): ModelRequest {
  const timePart: SystemPart = { id: "time", text: `Current time: ${time}`, stable: false };
  const messages = Array.from({ length: turns }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    content: [text(`message ${i} ${words(40, `m${i}`)}`)],
  }));
  return {
    system: layout === "dynamic" ? [timePart, stable] : [stable, timePart],
    tools,
    messages,
    maxTokens: 100,
    cache: "auto",
  };
}

describe("anthropic cache simulator", () => {
  it("reads the whole prefix up to the last breakpoint on an identical repeat", () => {
    const sim = new AnthropicCacheSim(A);
    const r = req("10:00", 3);
    const first = sim.apply(render(r), true, 0);
    expect(first.read).toBe(0);
    expect(first.write).toBeGreaterThan(0);
    expect(first.uncached).toBe(0);
    const again = sim.apply(render(r), true, 1000);
    expect(again.read).toBe(first.write);
    expect(again.write).toBe(0);
  });

  it("caches only the tool list when a changing part opens the system prompt", () => {
    const sim = new AnthropicCacheSim(A);
    sim.apply(render(req("10:00", 3, "dynamic")), true, 0);
    const next = render(req("10:01", 5, "dynamic"));
    const s = sim.apply(next, true, 1000);
    const toolTokens = next.filter((b) => b.kind === "tool").reduce((n, b) => n + b.tokens.length, 0);
    expect(s.read).toBe(toolTokens);
  });

  it("keeps the stable system prompt when the time comes after it", () => {
    const sim = new AnthropicCacheSim(A);
    sim.apply(render(req("10:00", 3)), true, 0);
    const next = render(req("10:01", 5));
    const s = sim.apply(next, true, 1000);
    const upToPolicies = next.slice(0, tools.length + 1).reduce((n, b) => n + b.tokens.length, 0);
    expect(s.read).toBe(upToPolicies);
  });

  it("does not cache prefixes below the minimum", () => {
    const sim = new AnthropicCacheSim(A);
    const small: ModelRequest = {
      system: [{ id: "s", text: "short", stable: true }],
      tools: [],
      messages: [{ role: "user", content: [text("hi")] }],
      maxTokens: 10,
      cache: "auto",
    };
    sim.apply(render(small), true, 0);
    const s = sim.apply(render(small), true, 1);
    expect(s.read).toBe(0);
    expect(s.write).toBe(0);
  });

  it("expires entries after the TTL and refreshes them on a hit", () => {
    const sim = new AnthropicCacheSim(A);
    const r = render(req("10:00", 3));
    const ttl = A.ttl_seconds * 1000;
    sim.apply(r, true, 0);
    expect(sim.apply(r, true, ttl - 1).read).toBeGreaterThan(0); // refreshed at ttl-1
    expect(sim.apply(r, true, 2 * ttl - 2).read).toBeGreaterThan(0);
    expect(sim.apply(r, true, 4 * ttl).read).toBe(0);
  });

  it("misses the conversation when more than the lookback window of blocks was added", () => {
    const sim = new AnthropicCacheSim(A);
    const base = req("10:00", 3);
    base.system = [stable]; // no time part: everything but new messages is identical
    sim.apply(render(base), true, 0);
    const grown = {
      ...base,
      messages: [
        ...base.messages,
        ...Array.from({ length: A.lookback_blocks + 2 }, (_, i) => ({
          role: (i % 2 ? "user" : "assistant") as "user" | "assistant",
          content: [text(`more ${i}`)],
        })),
      ],
    };
    const blocks = render(grown);
    const s = sim.apply(blocks, true, 1000);
    const upToSystem = blocks.slice(0, tools.length + 1).reduce((n, b) => n + b.tokens.length, 0);
    expect(s.read).toBe(upToSystem);
    const near = { ...base, messages: [...base.messages, { role: "assistant" as const, content: [text("one more")] }] };
    const sim2 = new AnthropicCacheSim(A);
    sim2.apply(render(base), true, 0);
    expect(sim2.apply(render(near), true, 1000).read).toBeGreaterThan(upToSystem);
  });

  it("shares the stable prefix between conversations", () => {
    const sim = new AnthropicCacheSim(A);
    sim.apply(render(req("10:00", 3)), true, 0);
    const other = req("11:00", 1);
    other.messages = [{ role: "user", content: [text("a different customer")] }];
    expect(sim.apply(render(other), true, 1000).read).toBeGreaterThan(0);
  });

  it("bills nothing as cached when caching is off", () => {
    const sim = new AnthropicCacheSim(A);
    const r = render(req("10:00", 3));
    sim.apply(r, false, 0);
    const s = sim.apply(r, false, 1);
    expect(s.read + s.write).toBe(0);
  });
});

describe("breakpoints", () => {
  it("places at most four, ending with the last message", () => {
    const blocks = render(req("10:00", 4));
    const bps = placeBreakpoints(blocks, 4);
    expect(bps.length).toBeLessThanOrEqual(4);
    expect(bps.at(-1)).toBe(blocks.length - 1);
    expect(bps[0]).toBe(tools.length - 1);
    expect(bps).toContain(tools.length); // end of the stable run
  });

  it("drops the stable-run breakpoint when a dynamic part comes first", () => {
    const blocks = render(req("10:00", 4, "dynamic"));
    expect(placeBreakpoints(blocks, 4)).toEqual([tools.length - 1, tools.length + 1, blocks.length - 1]);
  });
});

describe("openai cache simulator", () => {
  it("reads in 128-token steps from 1024 tokens", () => {
    const sim = new OpenAICacheSim(O);
    const r = render(req("10:00", 3));
    const total = r.reduce((n, b) => n + b.tokens.length, 0);
    sim.apply(r, true, 0);
    const s = sim.apply(r, true, 1);
    expect(s.read).toBe(O.min_tokens + Math.floor((total - O.min_tokens) / O.increment_tokens) * O.increment_tokens);
    expect(s.write).toBe(0);
    expect(s.read + s.uncached).toBe(total);
  });

  it("stops the read at the first changed token", () => {
    const sim = new OpenAICacheSim(O);
    sim.apply(render(req("10:00", 3, "dynamic")), true, 0);
    const s = sim.apply(render(req("10:01", 3, "dynamic")), true, 1);
    const toolTokens = render(req("10:00", 3, "dynamic"))
      .filter((b) => b.kind === "tool")
      .reduce((n, b) => n + b.tokens.length, 0);
    expect(s.read).toBeLessThanOrEqual(toolTokens + 20);
    expect(s.read).toBeGreaterThan(toolTokens - O.increment_tokens - 1);
  });

  it("caches nothing under the minimum", () => {
    const sim = new OpenAICacheSim(O);
    const small: ModelRequest = {
      system: [{ id: "s", text: "short", stable: true }],
      tools: [],
      messages: [{ role: "user", content: [text("hi")] }],
      maxTokens: 10,
      cache: "auto",
    };
    sim.apply(render(small), true, 0);
    expect(sim.apply(render(small), true, 1).read).toBe(0);
  });
});
