import { blockText } from "./render";
import { countTokens } from "./tokens";
import type { CacheMode, Message, ModelRequest, ModelResponse } from "./types";
import { text } from "./types";

/**
 * What part of a long conversation goes into each request.
 * - `full`: everything. Exact, and the prefix only grows, so the cache keeps working; cost grows
 *   with the call.
 * - `window`: the last N customer turns. The first message changes on every turn, so nothing after
 *   the system prompt is ever read from cache, and facts from early turns are gone.
 * - `summary`: older turns are replaced by a model-written summary once they pass a budget. The
 *   prefix is stable between summaries; each summary costs a model call and keeps only the gist.
 * - `casefile`: older turns are replaced by a case file that code builds from the transcript
 *   (verified identity, booking, quotes, completed actions). Moved in steps like the summary, but
 *   without a model call and without losing what the case file's schema holds.
 */
export type ContextName = "full" | "window" | "summary" | "casefile";
export const CONTEXTS: readonly ContextName[] = ["full", "window", "summary", "casefile"];

export interface StrategyEnv {
  complete(req: ModelRequest): Promise<ModelResponse>;
  cache: CacheMode;
  maxTokens: number;
  /** Case file for the transcript so far (domain code, not a model). */
  caseFile?: (history: readonly Message[]) => string;
}

export interface ContextStrategy {
  readonly name: ContextName;
  build(history: readonly Message[], env: StrategyEnv): Promise<Message[]>;
}

export const SUMMARIZER_PROMPT =
  "You summarise a customer-service conversation for the agent who will continue it. Write a few plain sentences: who the customer is, what they want, and what has been done. Do not invent anything.";

/** One line per message for a summariser: who said it, on one line, without injected context. */
export function transcriptLine(m: Message): string {
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  if (m.role === "assistant") {
    const said = m.content.flatMap((b) => (b.type === "text" ? [b.text] : b.type === "tool_use" ? [`[calls ${b.name} ${JSON.stringify(b.input)}]`] : []));
    return `Agent: ${flat(said.join(" "))}`;
  }
  const results = m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : []));
  if (results.length) return `Tool result: ${flat(results.join(" "))}`;
  return `Customer: ${flat(m.content.flatMap((b) => (b.type === "text" && !b.text.startsWith("<context>") ? [b.text] : [])).join(" "))}`;
}

export function isTurnStart(m: Message): boolean {
  return m.role === "user" && m.content.some((b) => b.type === "text") && !m.content.some((b) => b.type === "tool_result");
}

export function turnStarts(history: readonly Message[]): number[] {
  const out: number[] = [];
  history.forEach((m, i) => {
    if (isTurnStart(m)) out.push(i);
  });
  return out;
}

export function messageTokens(ms: readonly Message[]): number {
  let n = 0;
  for (const m of ms) for (const b of m.content) n += countTokens(blockText(b));
  return n;
}

/** Start index of the last `k` customer turns (0 if there are fewer). */
function lastTurns(history: readonly Message[], k: number): number {
  const s = turnStarts(history);
  return s.length <= k ? 0 : (s[s.length - k] as number);
}

function withPreamble(preamble: string, rest: readonly Message[]): Message[] {
  const [first, ...tail] = rest;
  if (!first) return [{ role: "user", content: [text(preamble)] }];
  return [{ role: first.role, content: [text(preamble), ...first.content] }, ...tail];
}

export class FullContext implements ContextStrategy {
  readonly name = "full" as const;
  async build(history: readonly Message[]): Promise<Message[]> {
    return [...history];
  }
}

export class WindowContext implements ContextStrategy {
  readonly name = "window" as const;
  constructor(private readonly keepTurns: number) {}
  async build(history: readonly Message[]): Promise<Message[]> {
    return history.slice(lastTurns(history, this.keepTurns));
  }
}

export class SummaryContext implements ContextStrategy {
  readonly name = "summary" as const;
  private summary = "";
  private covered = 0;
  summaries = 0;
  constructor(
    private readonly triggerTokens: number,
    private readonly keepTurns: number,
  ) {}

  async build(history: readonly Message[], env: StrategyEnv): Promise<Message[]> {
    if (messageTokens(history.slice(this.covered)) > this.triggerTokens) {
      const cut = lastTurns(history, this.keepTurns);
      if (cut > this.covered) {
        const transcript = history.slice(this.covered, cut).map(transcriptLine).join("\n");
        const r = await env.complete({
          system: [{ id: "summarizer", text: SUMMARIZER_PROMPT, stable: true }],
          tools: [],
          messages: [{ role: "user", content: [text(`${this.summary ? `Earlier summary: ${this.summary}\n\n` : ""}${transcript}`)] }],
          maxTokens: env.maxTokens,
          cache: env.cache,
        });
        this.summary = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        this.covered = cut;
        this.summaries++;
      }
    }
    const rest = history.slice(this.covered);
    return this.covered > 0 ? withPreamble(`<summary>\n${this.summary}\n</summary>`, rest) : [...rest];
  }
}

export class CaseFileContext implements ContextStrategy {
  readonly name = "casefile" as const;
  private checkpoint = 0;
  private file = "";
  moves = 0;
  constructor(
    private readonly budgetTokens: number,
    private readonly keepTurns: number,
  ) {}

  async build(history: readonly Message[], env: StrategyEnv): Promise<Message[]> {
    if (!env.caseFile) throw new Error("casefile context needs a caseFile builder");
    if (messageTokens(history.slice(this.checkpoint)) > this.budgetTokens) {
      const cut = lastTurns(history, this.keepTurns);
      if (cut > this.checkpoint) {
        this.checkpoint = cut;
        this.file = env.caseFile(history.slice(0, cut));
        this.moves++;
      }
    }
    const rest = history.slice(this.checkpoint);
    return this.checkpoint > 0 ? withPreamble(`<case_file>\n${this.file}\n</case_file>`, rest) : [...rest];
  }
}

export function makeContext(
  name: ContextName,
  s: { window: { keep_turns: number }; summary: { trigger_tokens: number; keep_turns: number }; casefile: { budget_tokens: number; keep_turns: number } },
): ContextStrategy {
  switch (name) {
    case "full":
      return new FullContext();
    case "window":
      return new WindowContext(s.window.keep_turns);
    case "summary":
      return new SummaryContext(s.summary.trigger_tokens, s.summary.keep_turns);
    case "casefile":
      return new CaseFileContext(s.casefile.budget_tokens, s.casefile.keep_turns);
  }
}

/**
 * Every tool_use must be answered by a tool_result in the next message, and every tool_result
 * must answer a tool_use in the message before it. Both APIs reject requests that break this, so
 * the loop checks it before every call, whatever the context strategy cut.
 */
export function pairingErrors(ms: readonly Message[]): string[] {
  const errs: string[] = [];
  ms.forEach((m, i) => {
    const uses = m.content.filter((b) => b.type === "tool_use").map((b) => (b.type === "tool_use" ? b.id : ""));
    const results = m.content.filter((b) => b.type === "tool_result").map((b) => (b.type === "tool_result" ? b.toolUseId : ""));
    if (results.length) {
      const prev = ms[i - 1];
      const prevUses = new Set(prev?.role === "assistant" ? prev.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : [])) : []);
      for (const r of results) if (!prevUses.has(r)) errs.push(`message ${i}: tool_result ${r} without a tool_use before it`);
    }
    if (uses.length) {
      const next = ms[i + 1];
      const answered = new Set(next?.role === "user" ? next.content.flatMap((b) => (b.type === "tool_result" ? [b.toolUseId] : [])) : []);
      for (const u of uses) if (!answered.has(u) && i + 1 < ms.length) errs.push(`message ${i}: tool_use ${u} without a tool_result after it`);
    }
  });
  return errs;
}
