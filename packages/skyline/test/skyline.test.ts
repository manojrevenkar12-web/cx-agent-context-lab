import { McpToolBackend, ToolIndex } from "@cxlab/agent";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Booking,
  CATALOGUE,
  CONVERSATION_HEADER,
  CORE,
  loadSkyline,
  QUOTE_CARD_URI,
  Schedule,
  SIBLINGS,
  SkylineBackend,
  skylineMcpHandler,
} from "../src/index";

const rules = loadSkyline();
const schedule = new Schedule(rules);
const flight = schedule.search("BER", "LHR", "2026-11-14").find((f) => f.slot === "morning");
const booking: Booking = {
  booking_ref: "QX7M2P",
  first_name: "Lena",
  last_name: "Hoffmann",
  fare: "classic",
  tier: "basic",
  flight_no: flight?.flight_no ?? "",
  date: "2026-11-14",
  paid: 189,
  bags: 0,
  seat: "21B",
  email: "lena@example.com",
  phone: "+49 30 1",
  status: "confirmed",
};
const at = (iso: string) => () => Date.parse(`${iso}:00Z`);
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

describe("skyline fare rules", () => {
  it("quotes change fee plus fare difference and charges exactly the quote", async () => {
    const be = new SkylineBackend(rules, [booking], at("2026-11-10T09:00"), undefined, schedule);
    await be.call("verify_identity", { booking_ref: "QX7M2P", last_name: "hoffmann" });
    const target = schedule.search("BER", "LHR", "2026-11-16").find((f) => f.slot === "evening");
    const q = parse(await be.call("quote_change", { booking_ref: "QX7M2P", flight_no: target?.flight_no, date: "2026-11-16" }));
    expect(q.change_fee).toBe(rules.fares.classic.change_fee);
    expect(q.total).toBe(Number(q.change_fee) + Math.max(0, (target?.price ?? 0) - (flight?.price ?? 0)));
    const done = parse(await be.call("change_flight", { booking_ref: "QX7M2P", quote_id: q.quote_id }));
    expect(done.status).toBe("changed");
    expect(be.charges).toEqual([{ booking_ref: "QX7M2P", amount: q.total, reason: "change", quote_id: q.quote_id }]);
    expect(be.log.flatMap((e) => e.breaches)).toEqual([]);
  });

  it("refuses expired quotes and changes within three hours of departure", async () => {
    let now = Date.parse("2026-11-10T09:00:00Z");
    const be = new SkylineBackend(rules, [booking], () => now, undefined, schedule);
    await be.call("verify_identity", { booking_ref: "QX7M2P", last_name: "Hoffmann" });
    const q = parse(await be.call("quote_cancellation", { booking_ref: "QX7M2P" }));
    now += (rules.quote_valid_minutes + 1) * 60_000;
    const r = await be.call("cancel_booking", { booking_ref: "QX7M2P", quote_id: q.quote_id });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/expired/);
    now = Date.parse("2026-11-14T05:00:00Z");
    const late = await be.call("quote_change", { booking_ref: "QX7M2P", flight_no: flight?.flight_no, date: "2026-11-15" });
    expect(parse(late).error).toMatch(/hand over/);
  });

  it("includes one bag on classic and caps bags at the limit", async () => {
    const be = new SkylineBackend(rules, [booking], at("2026-11-10T09:00"), undefined, schedule);
    expect(parse(await be.call("quote_baggage", { booking_ref: "QX7M2P", pieces: 2 })).total).toBe(rules.bag_price);
    expect((await be.call("quote_baggage", { booking_ref: "QX7M2P", pieces: rules.max_bags + 1 })).isError).toBe(true);
  });

  it("records breaches instead of enforcing them, like the systems it stands for", async () => {
    const be = new SkylineBackend(rules, [booking], at("2026-11-10T09:00"), undefined, schedule);
    const target = schedule.search("BER", "LHR", "2026-11-16")[0];
    await be.call("change_flight_legacy", { booking_ref: "QX7M2P", flight_no: target?.flight_no, date: "2026-11-16" });
    expect(be.log[0]?.breaches).toEqual(["unverified_access", "unquoted_change"]);
    expect(be.charges[0]?.amount).toBe(rules.legacy_change_flat_fee);
  });
});

describe("catalogue", () => {
  it("is large, uniquely named, and every sibling exists", () => {
    const names = CATALOGUE.map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(140);
    expect(new Set(names).size).toBe(names.length);
    for (const sibs of Object.values(SIBLINGS)) for (const s of sibs) expect(names).toContain(s);
  });

  it("finds every core tool by a plain-words search", () => {
    const idx = new ToolIndex(CATALOGUE);
    const queries: Record<string, string> = {
      verify_identity: "verify caller identity booking reference last name",
      quote_change: "quote price of changing flight",
      change_flight: "change flight on booking with quote",
      quote_baggage: "quote price adding checked bags",
      add_baggage: "add checked bags with baggage quote",
      get_seat_map: "seat map free seats",
      handoff_to_agent: "hand over conversation to human agent",
    };
    for (const [tool, q] of Object.entries(queries)) expect(idx.search(q, 5).map((t) => t.name)).toContain(tool);
  });
});

describe("skyline over MCP (2026-07-28, stateless)", () => {
  const sessions = new Map<string, SkylineBackend>();
  const backendFor = (id: string) => {
    let b = sessions.get(id);
    if (!b) {
      b = new SkylineBackend(rules, [booking], at("2026-11-10T09:00"), undefined, schedule);
      sessions.set(id, b);
    }
    return b;
  };
  const handler = skylineMcpHandler({ backendFor, toolsListTtlMs: 300_000 });
  const methods: string[] = [];
  const app = new Hono().all("/mcp", async (c) => {
    const body =
      c.req.method === "POST"
        ? ((await c.req.raw
            .clone()
            .json()
            .catch(() => ({}))) as { method?: string })
        : {};
    if (body.method) methods.push(body.method);
    return handler.fetch(c.req.raw);
  });
  let server: ReturnType<typeof serve>;
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((ok) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        port = info.port;
        ok();
      });
    });
  });
  afterAll(() => server.close());

  it("lists every tool once, with a cache hint, and keeps state per conversation", async () => {
    const client = new McpToolBackend(new URL(`http://127.0.0.1:${port}/mcp`), { [CONVERSATION_HEADER]: "conv-1" });
    await client.connect();
    const tools = await client.tools();
    expect(tools.length).toBe(CATALOGUE.length + 1);
    expect(tools.map((t) => t.name)).toContain("show_quote_card");
    expect(client.era).toBe("modern");
    expect(client.ttlMs).toBe(300_000);
    await client.tools();
    expect(methods.filter((m) => m === "tools/list").length).toBe(1); // the second list came from the cache hint
    const v = await client.call("verify_identity", { booking_ref: "QX7M2P", last_name: "Hoffmann" });
    expect(JSON.parse(v.content)).toEqual({ verified: true, booking_ref: "QX7M2P" });
    expect(sessions.get("conv-1")?.verified.has("QX7M2P")).toBe(true);
    const bad = await client.call("get_booking_v1", { booking_ref: "QX7M2P" });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it("validates arguments against each tool's schema", async () => {
    const client = new McpToolBackend(new URL(`http://127.0.0.1:${port}/mcp`), { [CONVERSATION_HEADER]: "conv-2" });
    await client.connect();
    const r = await client.call("quote_baggage", { booking_ref: "QX7M2P" }).catch((e: unknown) => ({ content: String(e), isError: true }));
    expect(r.isError).toBe(true);
    await client.close();
  });

  it("core tools come first so a client can pin them", () => {
    expect(CATALOGUE.slice(0, CORE.length)).toEqual(CORE);
    expect(QUOTE_CARD_URI.startsWith("ui://")).toBe(true);
  });
});
