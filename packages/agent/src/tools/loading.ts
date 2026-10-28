import type { ToolDef, ToolResultBlock, ToolUseBlock } from "../types";
import { ToolIndex } from "./search";

/**
 * How tool definitions reach the model.
 * - `all`: every definition in every request (simple; large and confusable at 100+ tools).
 * - `search-append`: the model searches, and found definitions are appended to the request's tool
 *   list. The tool list sits at the very front of the cached prefix, so every newly loaded tool
 *   invalidates the cache for everything after it.
 * - `search-dispatch`: two fixed tools, `tool_search` and `call_tool`. Found definitions arrive as a
 *   tool result inside the conversation and are called through `call_tool`, so the prefix never
 *   changes. (Anthropic's server-side tool search keeps the cache the same way, by expanding found
 *   tools inline rather than in the tool list.)
 */
export type ToolLoading = "all" | "search-append" | "search-dispatch";
export const TOOL_LOADINGS: readonly ToolLoading[] = ["all", "search-append", "search-dispatch"];

export interface ToolBackend {
  call(name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>;
}

export const TOOL_SEARCH: ToolDef = {
  name: "tool_search",
  description:
    "Search the airline's tool catalogue. Describe the task in plain words (for example 'change flight date' or 'add checked bag'). Returns the best matching tools.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

export const CALL_TOOL: ToolDef = {
  name: "call_tool",
  description: "Call a tool returned by tool_search. Pass its exact name and the arguments its input_schema asks for.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, arguments: { type: "object" } },
    required: ["name", "arguments"],
  },
};

export function missingRequired(def: ToolDef, input: Record<string, unknown>): string[] {
  const req = (def.inputSchema.required as string[] | undefined) ?? [];
  return req.filter((k) => input[k] === undefined || input[k] === null || input[k] === "");
}

export class ToolLoader {
  private readonly byName: Map<string, ToolDef>;
  private readonly index: ToolIndex;
  readonly loaded: string[] = [];

  constructor(
    readonly mode: ToolLoading,
    readonly catalogue: readonly ToolDef[],
    private readonly backend: ToolBackend,
    private readonly topK: number,
  ) {
    this.byName = new Map(catalogue.map((t) => [t.name, t]));
    this.index = new ToolIndex(catalogue);
  }

  /** The tool list for the next request. */
  visible(): ToolDef[] {
    if (this.mode === "all") return [...this.catalogue];
    if (this.mode === "search-dispatch") return [TOOL_SEARCH, CALL_TOOL];
    return [TOOL_SEARCH, ...this.loaded.map((n) => this.byName.get(n) as ToolDef)];
  }

  async execute(use: ToolUseBlock): Promise<ToolResultBlock> {
    const result = (content: string, isError = false): ToolResultBlock => ({
      type: "tool_result",
      toolUseId: use.id,
      content,
      ...(isError ? { isError: true } : {}),
    });
    if (this.mode !== "all" && use.name === TOOL_SEARCH.name) {
      const found = this.index.search(String(use.input.query ?? ""), this.topK);
      if (this.mode === "search-append") {
        for (const t of found) if (!this.loaded.includes(t.name)) this.loaded.push(t.name);
        return result(JSON.stringify({ loaded: found.map((t) => ({ name: t.name, description: t.description })) }));
      }
      return result(JSON.stringify({ tools: found.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }));
    }
    let name = use.name;
    let input = use.input;
    if (this.mode === "search-dispatch") {
      if (use.name !== CALL_TOOL.name) return result(`Unknown tool ${use.name}. Use tool_search, then call_tool.`, true);
      name = String(use.input.name ?? "");
      input = (use.input.arguments as Record<string, unknown> | undefined) ?? {};
    } else if (this.mode === "search-append" && !this.loaded.includes(name)) {
      return result(`Tool ${name} is not loaded. Find it with tool_search first.`, true);
    }
    const def = this.byName.get(name);
    if (!def) return result(`Unknown tool ${name}.`, true);
    const missing = missingRequired(def, input);
    if (missing.length) return result(`Missing required arguments for ${name}: ${missing.join(", ")}.`, true);
    const r = await this.backend.call(name, input);
    return result(r.content, r.isError ?? false);
  }
}
