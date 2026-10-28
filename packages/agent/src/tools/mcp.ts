import { Client, InMemoryResponseCacheStore, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ToolDef } from "../types";
import type { ToolBackend } from "./loading";

/**
 * Tools from an MCP server on the 2026-07-28 revision (negotiated, falling back to 2025 servers).
 * The SDK's response cache honours the server's `tools/list` cache hint, so a 150-tool catalogue is
 * not downloaded again on every turn.
 */
export class McpToolBackend implements ToolBackend {
  private client = new Client(
    { name: "cx-agent-context-lab", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" }, responseCacheStore: new InMemoryResponseCacheStore() },
  );
  /** Cache lifetime the server announced for its tool list. */
  ttlMs = 0;

  constructor(
    private readonly url: URL,
    private readonly headers: Record<string, string> = {},
  ) {}

  get era(): string | undefined {
    return this.client.getProtocolEra?.();
  }

  async connect(): Promise<void> {
    await this.client.connect(new StreamableHTTPClientTransport(this.url, { requestInit: { headers: this.headers } }));
  }

  async tools(): Promise<ToolDef[]> {
    const out: ToolDef[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) out.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> });
      this.ttlMs = Number((page as { ttlMs?: number }).ttlMs ?? 0);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async call(name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
    const r = await this.client.callTool({ name, arguments: input });
    const content = ((r.content as Array<{ type: string; text?: string }>) ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return { content, ...(r.isError ? { isError: true } : {}) };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
