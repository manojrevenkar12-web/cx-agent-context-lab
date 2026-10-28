import type { RenderedBlock } from "../render";

/**
 * Where the agent puts Anthropic `cache_control` breakpoints. The real adapter and the simulator both
 * call this, so the simulated bill is the bill for the request the adapter would send.
 *
 * At most `max` breakpoints, in prefix order:
 *   1. the last tool definition (tools rarely change),
 *   2. the end of the leading run of stable system parts (persona, policies),
 *   3. the end of the system section (per-conversation context),
 *   4. the last message block (the conversation so far, read back on the next turn).
 * A dynamic part at the very top of the system prompt removes breakpoint 2: nothing after a changing
 * block can be read from the cache, which is the failure the layout bet measures.
 */
export function placeBreakpoints(blocks: readonly RenderedBlock[], max: number): number[] {
  const out = new Set<number>();
  let lastTool = -1;
  let firstSystem = -1;
  let lastSystem = -1;
  let lastMessage = -1;
  blocks.forEach((b, i) => {
    if (b.kind === "tool") lastTool = i;
    if (b.kind === "system") {
      if (firstSystem < 0) firstSystem = i;
      lastSystem = i;
    }
    if (b.kind === "message") lastMessage = i;
  });
  if (lastTool >= 0) out.add(lastTool);
  if (firstSystem >= 0 && blocks[firstSystem]?.stable) {
    let i = firstSystem;
    while (i + 1 <= lastSystem && blocks[i + 1]?.stable) i++;
    out.add(i);
  }
  if (lastSystem >= 0) out.add(lastSystem);
  if (lastMessage >= 0) out.add(lastMessage);
  const sorted = [...out].sort((x, y) => x - y);
  // keep the last one (the conversation) and the earliest others
  return sorted.length <= max ? sorted : [...sorted.slice(0, max - 1), sorted[sorted.length - 1] as number];
}
