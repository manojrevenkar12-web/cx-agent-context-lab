import { Agent, FullContext, McpToolBackend, SimProvider, ToolLoader, VirtualClock } from "@cxlab/agent";
import { CONVERSATION_HEADER, conversationContext, SkylineBackend, STABLE_SYSTEM, skylineMcpHandler } from "@cxlab/skyline";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { bookingOf, grade, loadScenarios, loadWorld, SimCustomer, SkylinePolicy } from "../src/index";

it("the agent resolves a journey against Skyline over MCP", async () => {
  const world = loadWorld();
  const s = loadScenarios("scenarios/dev").find((x) => x.id === "change-simple");
  if (!s) throw new Error("missing");
  const flight = world.schedule.search("BER", "LHR", s.booking.date).find((f) => f.slot === s.booking.slot);
  const initial = bookingOf(s, flight?.flight_no ?? "");
  const start = Date.parse("2026-11-10T09:00:00Z");
  let seq = 0;
  const backend = new SkylineBackend(
    world.rules,
    [initial],
    () => start,
    () => seq++,
    world.schedule,
  );
  const handler = skylineMcpHandler({ backendFor: () => backend, toolsListTtlMs: 300_000 });
  const app = new Hono().all("/mcp", (c) => handler.fetch(c.req.raw));
  let port = 0;
  const server = await new Promise<ReturnType<typeof serve>>((ok) => {
    const srv = serve({ fetch: app.fetch, port: 0 }, (info) => {
      port = info.port;
      ok(srv);
    });
  });
  try {
    const mcp = new McpToolBackend(new URL(`http://127.0.0.1:${port}/mcp`), { [CONVERSATION_HEADER]: "e2e" });
    await mcp.connect();
    const catalogue = (await mcp.tools()).filter((t) => t.name !== "show_quote_card");
    // a plain clock: MCP calls are real I/O, which a virtual clock cannot wait for
    const clock = { now: () => 0, sleep: async () => {} };
    const provider = new SimProvider("anthropic", world.pricing, world.sim, clock, new SkylinePolicy(world.sim, 2026));
    const agent = new Agent({
      provider,
      clock,
      stableSystem: STABLE_SYSTEM,
      conversationContext: conversationContext({ channel: "voice", tier: "basic", callerId: "e2e", language: "en" }),
      tools: new ToolLoader("search-dispatch", catalogue, mcp, 5),
      context: new FullContext(),
      layout: "stable-tail",
      cache: "auto",
      maxTokens: 512,
      maxSteps: 12,
    });
    const customer = new SimCustomer(s, 0, initial.flight_no, { maxRepeatAsks: 2, chatterProbability: 0 });
    const timeline: Array<{ seq: number; who: "customer" | "agent"; text: string }> = [];
    let msg: string | null = customer.opening();
    while (msg) {
      timeline.push({ seq: seq++, who: "customer", text: msg });
      const r = await agent.turn(msg, "2026-11-10 09:00");
      timeline.push({ seq: seq++, who: "agent", text: r.reply });
      msg = customer.reply(r.reply);
    }
    const g = grade(s, backend, initial, start, timeline, customer);
    expect(g.failures).toEqual([]);
    expect(backend.log.map((e) => e.tool)).toEqual(["verify_identity", "get_booking", "search_flights", "quote_change", "change_flight"]);
    await mcp.close();
  } finally {
    server.close();
  }
  void VirtualClock;
});
