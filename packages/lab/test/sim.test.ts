import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSim, type Message, type ModelRequest, ROOT, SUMMARIZER_PROMPT, text } from "@cxlab/agent";
import { CATALOGUE, STABLE_SYSTEM } from "@cxlab/skyline";
import { describe, expect, it } from "vitest";
import { activeIntent, caseFileText, extractFacts, SkylinePolicy, siblingProbability, summaryText } from "../src/index";

const sim = loadSim();
const policy = new SkylinePolicy(sim, 2026);
const req = (messages: Message[], tools = CATALOGUE): ModelRequest => ({ system: STABLE_SYSTEM, tools, messages, maxTokens: 512, cache: "auto" });
const user = (t: string): Message => ({ role: "user", content: [text(t)] });
const agent = (t: string): Message => ({ role: "assistant", content: [text(t)] });

describe("facts come only from the request", () => {
  it("reads identity, intents in spoken order, dates and preferences", () => {
    const f = extractFacts(
      [
        user(
          "Hi. I'd like to add checked bags, and I need to move my flight to a different day, to 16 November. In the evening, if possible. My booking reference is QX7M2P and the last name is Hoffmann.",
        ),
      ],
      2026,
    );
    expect(f.ref).toBe("QX7M2P");
    expect(f.last).toBe("Hoffmann");
    expect(f.intents).toEqual(["add_bag", "change_flight"]);
    expect(f.change).toEqual({ date: "2026-11-16", prefer: "evening" });
    expect(activeIntent(f)).toBe("add_bag");
  });

  it("does not take the agent's own questions as the customer's answers", () => {
    const f = extractFacts(
      [
        user("I need to move my flight to a different day, to 16 November."),
        agent("Would you prefer a morning, midday or evening departure? Or a window or an aisle seat?"),
      ],
      2026,
    );
    expect(f.change.prefer).toBeUndefined();
    expect(f.intents).toEqual(["change_flight"]);
  });

  it("reads acceptance only after the agent asked", () => {
    const f = extractFacts(
      [user("Yes, please go ahead."), agent("I can move you to SK102 on 16 November at 18:50. The total is €79. Shall I go ahead?")],
      2026,
    );
    expect(f.answer).toBeUndefined();
    const g = extractFacts(
      [agent("I can move you to SK102 on 16 November at 18:50. The total is €79. Shall I go ahead?"), user("Yes, please go ahead.")],
      2026,
    );
    expect(g.answer).toBe("yes");
    expect(g.told?.kind).toBe("change");
  });
});

describe("the simulated model", () => {
  it("asks for identity before touching a booking", () => {
    const out = policy.respond(req([user("Hi. I need to cancel my booking.")]));
    expect(out).toEqual([text("Could you tell me your booking reference and the passenger's last name?")]);
  });

  it("verifies first, saying it is checking", () => {
    const out = policy.respond(req([user("Hi. I need to cancel my booking. My booking reference is HW4C8N and the last name is Weiss.")]));
    expect(out[0]).toEqual(text("One moment while I check that."));
    expect(out[1]).toMatchObject({ type: "tool_use", name: "verify_identity", input: { booking_ref: "HW4C8N", last_name: "Weiss" } });
  });

  it("searches the catalogue when the tool is not in view, and calls through call_tool after", () => {
    const dispatch = [CATALOGUE[0], CATALOGUE[1]].map((t, i) => ({ ...(t as (typeof CATALOGUE)[number]), name: i ? "call_tool" : "tool_search" }));
    const first = policy.respond(req([user("I need to cancel my booking. My booking reference is HW4C8N and the last name is Weiss.")], dispatch));
    expect(first.at(-1)).toMatchObject({ name: "tool_search" });
    const found: Message[] = [
      user("I need to cancel my booking. My booking reference is HW4C8N and the last name is Weiss."),
      { role: "assistant", content: [first.at(-1) as never] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: (first.at(-1) as { id: string }).id,
            content: JSON.stringify({ tools: [{ name: "verify_identity", description: "", input_schema: {} }] }),
          },
        ],
      },
    ];
    const second = policy.respond(req(found, dispatch));
    expect(second.at(-1)).toMatchObject({ name: "call_tool", input: { name: "verify_identity" } });
  });

  it("summarises only the kinds of fact the config keeps", () => {
    const transcript = [
      "Customer: Hi. I need to move my flight to a different day, to 16 November. In the evening, if possible.",
      "Agent: Could you tell me your booking reference and the passenger's last name?",
      "Customer: My booking reference is QX7M2P and the last name is Hoffmann.",
      'Tool result: {"status":"changed","flight_no":"SK102"}',
    ].join("\n");
    const s = summaryText(transcript, sim.summary.keeps, 2026);
    expect(s).toContain("QX7M2P");
    expect(s).toContain("Hoffmann");
    expect(s).toContain("Done so far: change_flight");
    expect(s).not.toMatch(/evening|SK102/);
    const out = policy.respond({
      system: [{ id: "summarizer", text: SUMMARIZER_PROMPT, stable: true }],
      tools: [],
      messages: [user(transcript)],
      maxTokens: 100,
      cache: "auto",
    });
    expect(out).toEqual([text(s)]);
  });

  it("builds the case file from the transcript without preferences (schema v1)", () => {
    const cf = caseFileText(
      [
        user(
          "I need to move my flight to a different day, to 16 November. In the evening, if possible. My booking reference is QX7M2P and the last name is Hoffmann.",
        ),
      ],
      2026,
    );
    expect(cf).toBe("booking_ref: QX7M2P\nlast_name: Hoffmann\nintents: change_flight");
  });

  it("gets more confusable as more tool definitions are in view (assumption curve)", () => {
    expect(siblingProbability(sim, 2)).toBeCloseTo(sim.tool_selection.base);
    expect(siblingProbability(sim, 160)).toBeGreaterThan(siblingProbability(sim, 20));
    expect(siblingProbability(sim, 1e6)).toBe(sim.tool_selection.max);
  });

  it("never reads the scenario, the customer or the grader", () => {
    const src = readFileSync(join(ROOT, "packages/lab/src/policy.ts"), "utf8") + readFileSync(join(ROOT, "packages/lab/src/facts.ts"), "utf8");
    // type-only imports (the Intent union) are fine; values are not
    expect(src).not.toMatch(/^import (?!type )[^;]*from "\.\/(scenario|customer|grade|run|bets)"/m);
  });
});
