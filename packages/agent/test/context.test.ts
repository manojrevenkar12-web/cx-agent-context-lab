import { describe, expect, it } from "vitest";
import { type Block, CaseFileContext, type Message, type ModelRequest, pairingErrors, SummaryContext, text, VirtualClock, WindowContext } from "../src/index";

const firstText = (ms: Message[]) => {
  const b: Block | undefined = ms[0]?.content[0];
  return b?.type === "text" ? b.text : "";
};

function convo(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "user", content: [text(`turn ${i} ${"words ".repeat(60)}`)] });
    out.push({ role: "assistant", content: [text("checking"), { type: "tool_use", id: `t${i}`, name: "x", input: {} }] });
    out.push({ role: "user", content: [{ type: "tool_result", toolUseId: `t${i}`, content: "{}" }] });
    out.push({ role: "assistant", content: [text(`answer ${i}`)] });
  }
  return out;
}

const env = (calls: ModelRequest[] = []) => ({
  complete: async (r: ModelRequest) => {
    calls.push(r);
    return {
      content: [text("summary text")],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      ttftMs: 0,
      totalMs: 0,
    };
  },
  cache: "auto" as const,
  maxTokens: 100,
  caseFile: (h: readonly Message[]) => `turns: ${h.length}`,
});

describe("context strategies", () => {
  it("window cuts at a customer turn and keeps tool pairs intact", async () => {
    const ms = await new WindowContext(2).build(convo(5));
    expect(ms[0]?.content[0]).toMatchObject({ type: "text" });
    expect(firstText(ms)).toMatch(/^turn 3/);
    expect(pairingErrors(ms)).toEqual([]);
  });

  it("summary calls the model once per move and keeps the prefix fixed in between", async () => {
    const calls: ModelRequest[] = [];
    const s = new SummaryContext(200, 1);
    const h = convo(4);
    const a = await s.build(h, env(calls));
    expect(calls.length).toBe(1);
    expect(firstText(a)).toContain("<summary>");
    h.push({ role: "user", content: [text("short")] });
    const b = await s.build(h, env(calls));
    expect(calls.length).toBe(1);
    expect(JSON.stringify(b[0])).toBe(JSON.stringify(a[0]));
    expect(pairingErrors(b)).toEqual([]);
  });

  it("case file comes from code, not a model call", async () => {
    const calls: ModelRequest[] = [];
    const c = new CaseFileContext(200, 1);
    const ms = await c.build(convo(4), env(calls));
    expect(calls.length).toBe(0);
    expect(firstText(ms)).toBe("<case_file>\nturns: 12\n</case_file>");
  });

  it("pairing check finds orphaned results and unanswered calls", () => {
    const h = convo(2);
    expect(pairingErrors(h.slice(2))).toEqual(["message 0: tool_result t0 without a tool_use before it"]);
    const cut = h.slice(0, 2).concat([{ role: "user", content: [text("hello")] }]);
    expect(pairingErrors(cut)).toEqual(["message 1: tool_use t0 without a tool_result after it"]);
  });
});

describe("virtual clock", () => {
  it("interleaves tasks by virtual time, deterministically", async () => {
    const clock = new VirtualClock();
    const log: string[] = [];
    const task = (name: string, gaps: number[]) => async () => {
      for (const g of gaps) {
        await clock.sleep(g);
        log.push(`${name}@${clock.now()}`);
      }
      return name;
    };
    const out = await clock.run([task("a", [100, 100, 100]), task("b", [150, 10]), task("c", [0])]);
    expect(out).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["c@0", "a@100", "b@150", "b@160", "a@200", "a@300"]);
  });
});
