import type { Clock } from "./clock";
import { type ContextStrategy, messageTokens, pairingErrors } from "./context";
import { ProviderError } from "./providers/sse";
import type { ToolLoader } from "./tools/loading";
import type { Block, CacheMode, Message, ModelRequest, ModelResponse, Provider, SystemPart, ToolUseBlock, Usage } from "./types";
import { text } from "./types";

/**
 * Where the parts that change go.
 * - `dynamic-first`: current time and caller context at the top of the system prompt (common in
 *   templates). Everything after them changes on every turn, so only the tool list is ever cached.
 * - `stable-first`: persona and policies first, then caller context, then the time. The stable part
 *   is shared by every call; the conversation is never cached because the time sits in front of it.
 * - `stable-tail`: stable part, then caller context; the time rides on the customer's message, so
 *   the whole conversation so far is a growing cached prefix.
 */
export type Layout = "dynamic-first" | "stable-first" | "stable-tail";
export const LAYOUTS: readonly Layout[] = ["dynamic-first", "stable-first", "stable-tail"];

export type AgentEvent =
  | { type: "model"; purpose: "turn" | "summary"; at: number; usage: Usage; ttftMs: number; totalMs: number; requestTokens: number }
  | { type: "tool"; at: number; name: string; input: Record<string, unknown>; isError: boolean; content: string }
  | { type: "reply"; at: number; text: string };

export interface AgentOptions {
  provider: Provider;
  clock: Clock;
  stableSystem: SystemPart[];
  conversationContext: string;
  tools: ToolLoader;
  context: ContextStrategy;
  layout: Layout;
  cache: CacheMode;
  maxTokens: number;
  maxSteps: number;
  caseFile?: (history: readonly Message[]) => string;
  cacheKey?: string;
  onEvent?: (e: AgentEvent) => void;
}

export interface TurnResult {
  reply: string;
  modelCalls: number;
  toolCalls: number;
  /** Customer's message to the agent's first spoken or written word. */
  firstWordMs: number;
  exhausted: boolean;
}

export const HANDOVER_REPLY = "I'm going to pass you to a colleague who can finish this with you. One moment please.";

export class Agent {
  readonly history: Message[] = [];
  constructor(private readonly o: AgentOptions) {}

  private system(now: string): SystemPart[] {
    const conv: SystemPart = { id: "conversation", text: this.o.conversationContext, stable: false };
    const time: SystemPart = { id: "time", text: `Current time: ${now}`, stable: false };
    switch (this.o.layout) {
      case "dynamic-first":
        return [time, conv, ...this.o.stableSystem];
      case "stable-first":
        return [...this.o.stableSystem, conv, time];
      case "stable-tail":
        return [...this.o.stableSystem, conv];
    }
  }

  private async call(req: ModelRequest, purpose: "turn" | "summary"): Promise<ModelResponse> {
    const errs = pairingErrors(req.messages);
    if (errs.length) throw new Error(`broken tool pairing: ${errs.join("; ")}`);
    const at = this.o.clock.now();
    let r: ModelResponse | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await this.o.provider.complete(req);
        break;
      } catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable || attempt >= 3) throw e;
        await this.o.clock.sleep(500 * 2 ** attempt);
      }
    }
    this.o.onEvent?.({
      type: "model",
      purpose,
      at,
      usage: r.usage,
      ttftMs: r.ttftMs,
      totalMs: r.totalMs,
      requestTokens: r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens,
    });
    return r;
  }

  async turn(customerText: string, now: string): Promise<TurnResult> {
    const start = this.o.clock.now();
    const content: Block[] = this.o.layout === "stable-tail" ? [text(`<context>Current time: ${now}</context>`), text(customerText)] : [text(customerText)];
    this.history.push({ role: "user", content });
    let modelCalls = 0;
    let toolCalls = 0;
    let firstWord = -1;
    const env = {
      complete: (req: ModelRequest) => {
        modelCalls++;
        return this.call(req, "summary");
      },
      cache: this.o.cache,
      maxTokens: this.o.maxTokens,
      ...(this.o.caseFile ? { caseFile: this.o.caseFile } : {}),
    };
    for (let step = 0; step < this.o.maxSteps; step++) {
      const messages = await this.o.context.build(this.history, env);
      const req: ModelRequest = {
        system: this.system(now),
        tools: this.o.tools.visible(),
        messages,
        maxTokens: this.o.maxTokens,
        cache: this.o.cache,
        ...(this.o.cacheKey ? { cacheKey: this.o.cacheKey } : {}),
      };
      const callStart = this.o.clock.now();
      const r = await this.call(req, "turn");
      modelCalls++;
      if (firstWord < 0 && r.content.some((b) => b.type === "text" && b.text.trim())) firstWord = callStart + r.ttftMs - start;
      this.history.push({ role: "assistant", content: r.content });
      const uses = r.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        const reply = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        this.o.onEvent?.({ type: "reply", at: this.o.clock.now(), text: reply });
        return { reply, modelCalls, toolCalls, firstWordMs: firstWord, exhausted: false };
      }
      const results: Block[] = [];
      for (const u of uses) {
        const res = await this.o.tools.execute(u);
        toolCalls++;
        this.o.onEvent?.({ type: "tool", at: this.o.clock.now(), name: u.name, input: u.input, isError: res.isError ?? false, content: res.content });
        results.push(res);
      }
      this.history.push({ role: "user", content: results });
    }
    this.history.push({ role: "assistant", content: [text(HANDOVER_REPLY)] });
    this.o.onEvent?.({ type: "reply", at: this.o.clock.now(), text: HANDOVER_REPLY });
    return { reply: HANDOVER_REPLY, modelCalls, toolCalls, firstWordMs: firstWord < 0 ? this.o.clock.now() - start : firstWord, exhausted: true };
  }

  /** Tokens of the full transcript (what `full` context would send as messages). */
  transcriptTokens(): number {
    return messageTokens(this.history);
  }
}
