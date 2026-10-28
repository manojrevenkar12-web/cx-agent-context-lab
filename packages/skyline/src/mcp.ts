import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SkylineBackend } from "./backend";
import { CATALOGUE } from "./catalogue";

/**
 * Skyline's tools as an MCP server on the 2026-07-28 revision: stateless (no MCP session; the
 * conversation is named by the `x-skyline-conversation` header and its booking state lives in the
 * backend store), `tools/list` carries a cache hint so clients reuse the catalogue instead of
 * fetching 140 definitions per call, and quotes can render as an MCP App card in chat clients.
 */

export const CONVERSATION_HEADER = "x-skyline-conversation";
export const QUOTE_CARD_URI = "ui://skyline/quote-card.html";

export interface McpOptions {
  backendFor: (conversationId: string) => SkylineBackend;
  toolsListTtlMs: number;
}

export function skylineServer(conversationId: string, o: McpOptions): McpServer {
  const server = new McpServer({ name: "skyline-air", version: "1.0.0" }, { cacheHints: { "tools/list": { ttlMs: o.toolsListTtlMs, cacheScope: "public" } } });
  for (const t of CATALOGUE) {
    server.registerTool(t.name, { description: t.description, inputSchema: fromJsonSchema<Record<string, unknown>>(t.inputSchema as never) }, async (args) => {
      const r = await o.backendFor(conversationId).call(t.name, (args ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text: r.content }], ...(r.isError ? { isError: true } : {}) };
    });
  }
  registerAppTool(
    server,
    "show_quote_card",
    {
      description: "Show a quote to a chat customer as a card with Accept and Decline buttons. Chat channel only.",
      inputSchema: z.object({ title: z.string(), total: z.number(), currency: z.string(), lines: z.array(z.string()) }),
      _meta: { ui: { resourceUri: QUOTE_CARD_URI } },
    },
    async (args) => ({ content: [{ type: "text", text: `Showing quote card: ${args.title}, ${args.total} ${args.currency}` }], structuredContent: args }),
  );
  registerAppResource(server, "Quote card", QUOTE_CARD_URI, { description: "Quote with Accept and Decline" }, async () => ({
    contents: [{ uri: QUOTE_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: QUOTE_CARD_HTML }],
  }));
  return server;
}

export function skylineMcpHandler(o: McpOptions) {
  return createMcpHandler((ctx) => skylineServer(ctx.requestInfo?.headers.get(CONVERSATION_HEADER) ?? "default", o));
}

// A dependency-free MCP App view: it speaks the ui/* JSON-RPC protocol over postMessage itself.
export const QUOTE_CARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--ink:#14213d;--muted:#5b6478;--line:#d8dce6;--accent:#0b6e4f;--bg:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#e8ecf4;--muted:#a3abbd;--line:#333a4a;--accent:#4cc39a;--bg:#161a22}}
body{margin:0;font:15px/1.45 system-ui,sans-serif;color:var(--ink);background:var(--bg)}
.card{padding:16px 18px;border:1px solid var(--line);border-radius:10px}
h1{font-size:15px;margin:0 0 6px}.total{font-size:26px;font-weight:650;margin:4px 0 10px;font-variant-numeric:tabular-nums}
ul{margin:0 0 14px;padding-left:18px;color:var(--muted)}button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:none;color:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style></head><body><div class="card" id="card" aria-live="polite"><p>Loading quote…</p></div>
<script>
let id=0;const pending=new Map();
const send=(m)=>window.parent.postMessage({jsonrpc:"2.0",...m},"*");
const request=(method,params)=>new Promise(r=>{const i=++id;pending.set(i,r);send({id:i,method,params});});
window.addEventListener("message",(e)=>{const m=e.data||{};
 if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);return;}
 if(m.method==="ui/notifications/tool-result"){render(m.params&&m.params.structuredContent);}});
function el(t,txt,cls){const n=document.createElement(t);if(txt!=null)n.textContent=txt;if(cls)n.className=cls;return n;}
function render(q){const c=document.getElementById("card");c.replaceChildren();if(!q){c.append(el("p","No quote to show."));return;}
 c.append(el("h1",q.title),el("div",new Intl.NumberFormat(undefined,{style:"currency",currency:q.currency}).format(q.total),"total"));
 const ul=el("ul");(q.lines||[]).forEach(l=>ul.append(el("li",l)));c.append(ul);
 const yes=el("button","Accept","primary"),no=el("button","Decline");no.style.marginLeft="8px";
 yes.onclick=()=>request("ui/message",{role:"user",content:[{type:"text",text:"Yes, go ahead."}]});
 no.onclick=()=>request("ui/message",{role:"user",content:[{type:"text",text:"No, leave it as it is."}]});
 c.append(yes,no);}
request("ui/initialize",{appInfo:{name:"skyline-quote-card",version:"1.0.0"},appCapabilities:{},protocolVersion:"2026-01-26"})
 .then(()=>send({method:"ui/notifications/initialized",params:{}}));
</script></body></html>`;
