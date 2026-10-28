import type { ToolDef } from "../types";

// BM25 over tool names and descriptions: the same kind of search Anthropic's server-side tool
// search offers, run client-side so both providers can use it and the lab is deterministic.

const STOP = new Set(["a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with", "is", "my", "i", "me", "this", "that", "it"]);

export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export class ToolIndex {
  private docs: Array<{ tool: ToolDef; tf: Map<string, number>; len: number }>;
  private df = new Map<string, number>();
  private avg: number;

  constructor(readonly tools: readonly ToolDef[]) {
    this.docs = tools.map((tool) => {
      // the name counts twice: it is the most specific text a tool has
      const ws = [...words(tool.name.replace(/_/g, " ")), ...words(tool.name.replace(/_/g, " ")), ...words(tool.description)];
      const tf = new Map<string, number>();
      for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      return { tool, tf, len: ws.length };
    });
    this.avg = this.docs.reduce((n, d) => n + d.len, 0) / Math.max(1, this.docs.length);
  }

  search(query: string, k: number): ToolDef[] {
    const q = [...new Set(words(query))];
    const N = this.docs.length;
    const scored = this.docs.map((d, i) => {
      let s = 0;
      for (const w of q) {
        const f = d.tf.get(w);
        if (!f) continue;
        const df = this.df.get(w) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.len) / this.avg));
      }
      return { s, i };
    });
    return scored
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, k)
      .map((x) => (this.docs[x.i] as (typeof this.docs)[number]).tool);
  }
}
