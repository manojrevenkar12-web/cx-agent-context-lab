import { encode } from "gpt-tokenizer";

// Token counts with the o200k tokenizer. Exact for OpenAI's current models, an approximation for
// Claude (whose tokenizer is not public); both cache simulators work on the same counts, so the
// comparison between strategies holds even where the absolute numbers are approximate.

const memo = new Map<string, number[]>();
const MEMO_LIMIT = 50_000;

export function tokenize(s: string): number[] {
  const hit = memo.get(s);
  if (hit) return hit;
  const t = encode(s);
  if (memo.size > MEMO_LIMIT) memo.clear();
  memo.set(s, t);
  return t;
}

export function countTokens(s: string): number {
  return tokenize(s).length;
}
