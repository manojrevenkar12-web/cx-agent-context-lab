import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

const app = createApp({ speed: 1e6 });

describe("api", () => {
  it("serves scenarios and options", async () => {
    const s = (await (await app.request("/api/scenarios")).json()) as Array<{ id: string }>;
    expect(s.length).toBeGreaterThan(10);
    const o = (await (await app.request("/api/options")).json()) as { contexts: string[] };
    expect(o.contexts).toEqual(["full", "window", "summary", "casefile"]);
  });

  it("simulates one conversation with a trace", async () => {
    const r = await app.request("/api/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "change-simple", config: { provider: "openai", layout: "stable-tail", tools: "search-dispatch", context: "full" } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { grade: { success: boolean }; trace: unknown[] };
    expect(body.grade.success).toBe(true);
    expect(body.trace.length).toBeGreaterThan(2);
  });

  it("rejects bad input with a reason", async () => {
    const r = await app.request("/api/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "x", config: { provider: "acme" } }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/config.provider/);
    expect((await app.request("/api/bets/..%2Fsecret/memo")).status).toBe(400);
  });

  it("streams a conversation as server-sent events", async () => {
    const r = await app.request("/api/stream?scenario=bags-included&provider=anthropic&layout=stable-tail&tools=all&context=full");
    const text = await r.text();
    expect(text).toContain("event: customer");
    expect(text).toContain("event: model");
    expect(text).toContain("event: done");
  });
});
