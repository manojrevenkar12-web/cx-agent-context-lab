import { tokenize } from "./tokens";
import type { Block, ModelRequest, ToolDef } from "./types";

/**
 * A request as the provider's cache sees it: an ordered list of blocks (tools, then system, then
 * message content), each with its tokens. Both cache simulators and the cost model work on this,
 * and the real adapters send the same order, so what is measured is what would be sent.
 */
export interface RenderedBlock {
  kind: "tool" | "system" | "message";
  key: string;
  text: string;
  tokens: number[];
  /** Same in every request of every conversation (tool definitions, persona, policies). */
  stable: boolean;
}

export function toolText(t: ToolDef): string {
  return JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema });
}

export function blockText(b: Block): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "tool_use":
      return JSON.stringify({ tool_use: b.name, id: b.id, input: b.input });
    case "tool_result":
      return JSON.stringify({ tool_result: b.toolUseId, is_error: b.isError ?? false, content: b.content });
  }
}

export function render(req: ModelRequest): RenderedBlock[] {
  const out: RenderedBlock[] = [];
  for (const t of req.tools) {
    const s = toolText(t);
    out.push({ kind: "tool", key: `tool:${t.name}`, text: s, tokens: tokenize(s), stable: true });
  }
  for (const p of req.system) {
    out.push({ kind: "system", key: `system:${p.id}`, text: p.text, tokens: tokenize(p.text), stable: p.stable });
  }
  req.messages.forEach((m, mi) => {
    m.content.forEach((b, bi) => {
      const s = `${m.role}:${blockText(b)}`;
      out.push({ kind: "message", key: `msg:${mi}:${bi}`, text: s, tokens: tokenize(s), stable: false });
    });
  });
  return out;
}

export function totalTokens(blocks: readonly RenderedBlock[]): number {
  return blocks.reduce((n, b) => n + b.tokens.length, 0);
}
