import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentEvent, CONTEXTS, LAYOUTS, ROOT, SimProvider, TOOL_LOADINGS } from "@cxlab/agent";
import {
  type ConversationResult,
  loadScenarios,
  loadWorld,
  type RunConfig,
  runConfig,
  runConversation,
  type Scenario,
  SkylinePolicy,
  type World,
} from "@cxlab/lab";
import { SkylineBackend, skylineMcpHandler } from "@cxlab/skyline";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

/** A clock that runs virtual time at `speed` times real time, so a playground run can be watched. */
export class PacedClock {
  private t = 0;
  constructor(private readonly speed: number) {}
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
    await new Promise((r) => setTimeout(r, Math.min(4000, ms / this.speed)));
  }
}

export const ConfigSchema = z.strictObject({
  provider: z.enum(["anthropic", "openai"]),
  layout: z.enum(LAYOUTS as unknown as ["dynamic-first", "stable-first", "stable-tail"]),
  tools: z.enum(TOOL_LOADINGS as unknown as ["all", "search-append", "search-dispatch"]),
  context: z.enum(CONTEXTS as unknown as ["full", "window", "summary", "casefile"]),
  cache: z.enum(["off", "auto"]).default("auto"),
});
const SimulateSchema = z.strictObject({ scenario: z.string().max(80), config: ConfigSchema, seed: z.number().int().min(0).max(99).default(0) });

export interface AppOptions {
  world?: World;
  scenarios?: Scenario[];
  /** Real-time pacing for the streaming playground (virtual ms per real ms). */
  speed?: number;
}

export function createApp(o: AppOptions = {}) {
  const world = o.world ?? loadWorld();
  const scenarios = o.scenarios ?? loadScenarios("scenarios/dev");
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const app = new Hono();
  app.use("/api/*", cors({ origin: (origin) => (origin?.startsWith("http://localhost") || origin?.startsWith("http://127.0.0.1") ? origin : null) }));

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/results", (c) => {
    const p = join(ROOT, "reports/results.json");
    if (!existsSync(p)) return c.json({ error: "No results yet. Run `npm run lab -- bets`." }, 404);
    return c.body(readFileSync(p, "utf8"), 200, { "content-type": "application/json" });
  });

  app.get("/api/bets/:id/memo", (c) => {
    const id = c.req.param("id");
    if (!/^[a-z0-9-]+$/.test(id)) return c.json({ error: "bad id" }, 400);
    const p = join(ROOT, `reports/bets/${id}.md`);
    if (!existsSync(p)) return c.json({ error: `No memo for ${id}` }, 404);
    return c.text(readFileSync(p, "utf8"));
  });

  app.get("/api/scenarios", (c) =>
    c.json(
      scenarios.map((s) => ({
        id: s.id,
        channel: s.channel,
        tags: s.tags,
        reveal: s.reveal,
        chatter: s.chatter,
        goals: s.goals.map((g) => g.intent),
        fare: s.booking.fare,
        tier: s.booking.tier,
      })),
    ),
  );

  app.get("/api/options", (c) => c.json({ providers: ["anthropic", "openai"], layouts: LAYOUTS, tools: TOOL_LOADINGS, contexts: CONTEXTS }));

  app.post("/api/simulate", async (c) => {
    const body = SimulateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const s = byId.get(body.data.scenario);
    if (!s) return c.json({ error: `No scenario ${body.data.scenario}` }, 404);
    const [r] = await runConfig(world, body.data.config as RunConfig, [s], { seeds: body.data.seed + 1, trace: true }).then((rs) =>
      rs.filter((x) => x.seed === body.data.seed),
    );
    return c.json(r as ConversationResult);
  });

  app.get("/api/stream", (c) => {
    const parsed = SimulateSchema.safeParse({
      scenario: c.req.query("scenario"),
      seed: Number(c.req.query("seed") ?? 0),
      config: {
        provider: c.req.query("provider"),
        layout: c.req.query("layout"),
        tools: c.req.query("tools"),
        context: c.req.query("context"),
        cache: c.req.query("cache") ?? "auto",
      },
    });
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const s = byId.get(parsed.data.scenario);
    if (!s) return c.json({ error: `No scenario ${parsed.data.scenario}` }, 404);
    return streamSSE(c, async (stream) => {
      const clock = new PacedClock(o.speed ?? 8);
      const provider = new SimProvider(
        parsed.data.config.provider,
        world.pricing,
        world.sim,
        clock,
        new SkylinePolicy(world.sim, Number(world.rules.today.slice(0, 4))),
      );
      const send = (e: AgentEvent | { type: "customer"; text: string }) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      };
      const r = await runConversation({ world, provider, clock, config: parsed.data.config as RunConfig, scenario: s, seed: parsed.data.seed, onEvent: send });
      await stream.writeSSE({ event: "done", data: JSON.stringify({ ...r, trace: undefined }) });
    });
  });

  // Skyline itself, as an MCP server (one backend per conversation header, dev bookings)
  const sessions = new Map<string, { backend: SkylineBackend; at: number }>();
  const bookings = scenarios.map((s) => {
    const f = world.schedule.search(...(s.booking.route.split("-") as [string, string]), s.booking.date).find((x) => x.slot === s.booking.slot);
    return { ...s, flightNo: f?.flight_no ?? "" };
  });
  const mcp = skylineMcpHandler({
    toolsListTtlMs: 300_000,
    backendFor: (id) => {
      const now = Date.now();
      for (const [k, v] of sessions) if (now - v.at > 3_600_000) sessions.delete(k);
      let e = sessions.get(id);
      if (!e) {
        const list = bookings.map((s) => ({
          booking_ref: s.booking.ref,
          first_name: s.customer.first_name,
          last_name: s.customer.last_name,
          fare: s.booking.fare,
          tier: s.booking.tier,
          flight_no: s.flightNo,
          date: s.booking.date,
          paid: s.booking.paid,
          bags: s.booking.bags,
          seat: s.booking.seat,
          email: `${s.customer.first_name}@example.com`.toLowerCase(),
          phone: "+49 30 5550 1234",
          status: "confirmed" as const,
        }));
        e = { backend: new SkylineBackend(world.rules, list, () => Date.parse(`${world.rules.today}T09:00:00Z`), undefined, world.schedule), at: now };
        sessions.set(id, e);
      }
      e.at = now;
      return e.backend;
    },
  });
  app.all("/mcp", (c) => mcp.fetch(c.req.raw));

  // the console, when built
  const dist = join(ROOT, "apps/console/dist");
  app.get("*", (c) => {
    const rel = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
    if (rel.includes("..") || !existsSync(dist)) return c.notFound();
    const p = join(dist, rel);
    const file = existsSync(p) && !rel.endsWith("/") ? p : join(dist, "index.html");
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html";
    return c.body(readFileSync(file), 200, { "content-type": type });
  });
  return app;
}
