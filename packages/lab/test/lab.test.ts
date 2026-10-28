import { SkylineBackend } from "@cxlab/skyline";
import { describe, expect, it } from "vitest";
import { type BetDef, decide, grade, loadBets, loadScenarios, loadWorld, metric, runConfig, SimCustomer } from "../src/index";
import type { RunConfig } from "../src/run";
import { bookingOf } from "../src/scenario";

const world = loadWorld();
const dev = loadScenarios("scenarios/dev");
const rec: RunConfig = { provider: "anthropic", layout: "stable-tail", tools: "search-dispatch", context: "full", cache: "auto" };

describe("lab runs", () => {
  it("are deterministic", async () => {
    const pick = dev.filter((s) => ["change-simple", "long-four-goals", "bags-light"].includes(s.id));
    const a = await runConfig(world, rec, pick, { seeds: 2 });
    const b = await runConfig(world, rec, pick, { seeds: 2 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("resolve every dev scenario with the recommended setup", async () => {
    const rs = await runConfig(world, rec, dev, { seeds: 1 });
    const failed = rs.filter((r) => !r.grade.success).map((r) => `${r.scenario}: ${r.grade.failures.join("; ")}`);
    expect(failed).toEqual([]);
    expect(rs.every((r) => r.grade.breaches.length === 0)).toBe(true);
  });

  it("hand over what policy says a person must handle", async () => {
    const rs = await runConfig(
      world,
      rec,
      dev.filter((s) => ["change-too-late", "claim-lost-bag", "assistance"].includes(s.id)),
      { seeds: 1 },
    );
    expect(rs.map((r) => [r.scenario, r.handedOff, r.grade.success])).toEqual([
      ["change-too-late", true, true],
      ["claim-lost-bag", true, true],
      ["assistance", true, true],
    ]);
  });

  it("caching off costs more than caching on, on the same conversations", async () => {
    const pick = dev.slice(0, 6);
    const on = await runConfig(world, rec, pick, { seeds: 1 });
    const off = await runConfig(world, { ...rec, cache: "off" }, pick, { seeds: 1 });
    expect(metric("cost_per_conversation", off)).toBeGreaterThan(metric("cost_per_conversation", on) * 1.5);
    expect(metric("cache_read_share", off)).toBe(0);
  });
});

describe("the grader", () => {
  it("fails a change made through the legacy endpoint: wrong fee, no quote", async () => {
    const s = dev.find((x) => x.id === "change-simple");
    if (!s) throw new Error("missing scenario");
    const flight = world.schedule.search("BER", "LHR", s.booking.date).find((f) => f.slot === s.booking.slot);
    const initial = bookingOf(s, flight?.flight_no ?? "");
    let seq = 0;
    const be = new SkylineBackend(
      world.rules,
      [initial],
      () => Date.parse("2026-11-10T09:00:00Z"),
      () => seq++,
      world.schedule,
    );
    const timeline = [{ seq: seq++, who: "customer" as const, text: "My booking reference is QX7M2P and the last name is Hoffmann." }];
    await be.call("verify_identity", { booking_ref: "QX7M2P", last_name: "Hoffmann" });
    const target = world.schedule.search("BER", "LHR", "2026-11-16").find((f) => f.slot === "evening");
    await be.call("change_flight_legacy", { booking_ref: "QX7M2P", flight_no: target?.flight_no, date: "2026-11-16" });
    const customer = new SimCustomer(s, 0, initial.flight_no, { maxRepeatAsks: 2, chatterProbability: 0 });
    customer.reply("You're now on it. Thank you for calling Skyline Air.");
    const g = grade(s, be, initial, Date.parse("2026-11-10T09:00:00Z"), timeline, customer);
    expect(g.success).toBe(false);
    expect(g.failures).toContain("policy breach: unquoted_change");
    expect(g.failures.some((f) => f.startsWith("change charged 90"))).toBe(true);
    expect(g.failures).toContain("change_flight_legacy without the customer accepting first");
    expect(g.wrongToolCalls).toBe(1);
  });

  it("flags reading a booking before verifying the caller", async () => {
    const s = dev.find((x) => x.id === "seat-aisle");
    if (!s) throw new Error("missing scenario");
    const initial = bookingOf(s, "SK000");
    const be = new SkylineBackend(world.rules, [initial], () => 0, undefined, world.schedule);
    await be.call("get_seat_map", { booking_ref: s.booking.ref }).catch(() => undefined);
    expect(be.log[0]?.breaches).toEqual(["unverified_access"]);
  });
});

describe("decision rule", () => {
  const bets = loadBets();
  const bet = bets.bets[0] as BetDef;
  const fake = (cost: number, ok: boolean, n = 20) =>
    Array.from({ length: n }, (_, i) => ({
      scenario: `s${i}`,
      seed: 0,
      costUsd: cost * (1 + (i % 3) * 0.01),
      grade: { success: ok || i > 2, failures: [], breaches: [], wrongToolCalls: 0 },
      repeatAsks: 0,
      firstWordMs: [500],
      tokens: { read: 1, write: 0, uncached: 0, output: 0 },
    })) as never[];
  const cmp = (base: never[], v: never[]) => [
    {
      metric: "cost_per_conversation" as const,
      base: metric("cost_per_conversation", base),
      variant: metric("cost_per_conversation", v),
      gain: 1 - metric("cost_per_conversation", v) / metric("cost_per_conversation", base),
      ci: [0.2, 0.4] as [number, number],
    },
  ];

  it("hands off a large, clean win", () => {
    const b = fake(1, true);
    const v = fake(0.6, true);
    expect(decide(bets.decision, bet, cmp(b, v), b, v).verdict).toBe("hand-off");
  });

  it("iterates when a guardrail breaks, however large the win", () => {
    const b = fake(1, true);
    const v = fake(0.6, false);
    const d = decide(bets.decision, bet, cmp(b, v), b, v);
    expect(d.verdict).toBe("iterate");
    expect(d.reasons.join(" ")).toMatch(/resolved rate drops/);
  });

  it("kills a gain under the bar", () => {
    const b = fake(1, true);
    const v = fake(0.97, true);
    expect(decide(bets.decision, bet, [{ ...cmp(b, v)[0], ci: [0.01, 0.05] } as never], b, v).verdict).toBe("kill");
  });
});
