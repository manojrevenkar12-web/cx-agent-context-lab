# cx-agent-context-lab

An applied-AI lab for contact-centre agents. It works on one question that decides how much an
LLM agent costs and how fast it answers on a call: **what goes into each model request, and in what
order.** That covers three things:

- the prompt layout, which decides whether the provider's cache can be used;
- whether 150 tool definitions are loaded on every call or searched for;
- what is kept from a long call.

The lab runs these as bets. Each bet ends in a memo with a decision: hand off to product engineering,
publish as guidance, iterate, or kill.

The agent loop is written from scratch in TypeScript, without a framework. It has Anthropic and
OpenAI adapters (fetch plus server-sent events) and talks to tools over MCP. Its backend is
**Skyline Air**, a fictional airline with 154 tools, served as an MCP server on the 2026-07-28
revision. Simulated customers call it, and a grader checks what actually happened in the backend.

## What the lab found (dev set, 22 scenarios × 3 seeds, generated in `reports/`)

| Bet | Decision | Effect on cost per conversation |
|---|---|---|
| [Where the changing parts of the prompt go](reports/bets/cache-layout.md) | **Publish** | Time stamp on the customer's message instead of the top of the system prompt: −14.6% on Anthropic, −11.1% on OpenAI; first word p95 761 → 618 ms. Small because the 154 tool definitions, cached either way, dominate the prompt |
| [Loading 154 tools versus searching for them](reports/bets/tool-loading.md) | **Hand off** | Search plus a fixed `call_tool` dispatcher: −44.1% (CI −42.3% to −46.0%). Adding found tools to the tool list breaks the cache (84.8% vs 93.4% of input read from cache) and saves only 19% |
| [What to keep from a long call](reports/bets/long-call-context.md) | **Kill** | With a cache-friendly layout, the full transcript is cheapest. A sliding window costs +50% (the cache breaks every turn). A model-written summary costs +66% and adds 1.3 repeated questions per call. A code-built case file breaks even and still loses preferences |
| [Template agent versus recommendation](reports/bets/combined.md) | **Hand off** | −52.3% on Anthropic and −47.1% on OpenAI. First word p95 761 → 477 ms. 100% resolved on both setups |

The finding that changes design advice is the third one. Once the layout lets the provider cache
the conversation, trimming context costs more than it saves for calls of this length:

- each move of a summary or checkpoint rewrites the cache at 1.25× the input price;
- each lost fact costs a repeated question.

The memo says when to revisit: calls several times longer than these.

**Held-out set (`heldout/blind-1`).** This set has 34 scenarios, written by an agent that only had
`heldout/WRITING_SCENARIOS.md`. Its first run was recorded once (sha256 `949e8543f0c3…`) and is never
rewritten. The recommended setup resolved **76.5%** on both providers, against 100% on the dev set.
That gap is the honest measure of how far the simulated agent and customers generalise. The failures
have not been studied; studying them would turn the set into a regression set.

## How the numbers are made, and what is assumed

**Measured by documented rules.** Cost and cache behaviour come from each provider's published
caching rules. They are applied to the exact request the real adapter would send (`packages/agent/src/cache`):

- **Anthropic:**
  - explicit breakpoints, at most 4;
  - the prefix runs tools → system → messages;
  - the lookback reaches 20 blocks;
  - there is a minimum cacheable length;
  - entries live 5 minutes and are refreshed on a hit;
  - writes cost 1.25× and reads 0.1× the input price.
- **OpenAI:**
  - caching is automatic from 1,024 tokens, in 128-token steps;
  - there is no write surcharge.

The cache is shared by every conversation. Conversations overlap on a virtual clock, as they do in a
contact centre.

**Assumed, and marked.** These come from `config/sim.yaml`:

- the latency model;
- how often a model picks a confusable sibling tool as more definitions are in view (the curve is shaped after Anthropic's published tool-search results);
- what a model summary keeps.

Every memo names the metrics that rest on these assumptions.

**The simulated model only knows what is in each request.** It reads facts from the request it gets,
so a fact a context strategy dropped is really gone. It does not make the other mistakes a real model
makes. `LAB_LIVE=1` runs the same agent through the real adapters with API keys; that has not been
run here.

## Run it

```bash
npm install
npm run lab -- bets                 # all bets: reports/bets/*.md, reports/results.json (about 20 s)
npm run lab -- run --scenario long-four-goals --config anthropic/stable-tail/search-dispatch/casefile/cache-auto
npm run lab -- heldout blind-1      # first run is kept; later runs go to latest.json
npm run lab -- gate                 # release gate (config/gate.yaml)
npx vitest run                      # agent, skyline, lab, api: 57 tests
npm run api                         # http://localhost:8787 (console, /api, Skyline at /mcp)
cd apps/console && npx vite build && npx vitest run && npx playwright test
```

Docker: `docker build -f deploy/Dockerfile -t cx-agent-context-lab . && docker run -p 8787:8787 cx-agent-context-lab`.

## Layout

| Path | What it is |
|---|---|
| `packages/agent` | **Agent loop.** It checks tool-call pairing before every request and retries rate limits. |
| | **Request rendering.** One shared breakpoint rule decides cache placement for both the real adapters and the simulator. |
| | **Cache simulators.** Anthropic and OpenAI, by their documented rules. |
| | **Providers.** Anthropic Messages and OpenAI Responses adapters, plus a simulated provider. |
| | **Context strategies.** Full, window, summary and case file. |
| | **Tool loading.** All, search-append and search-dispatch, with BM25 tool search. |
| | **MCP tool client.** Version negotiation, plus a response cache that honours `ttlMs`. |
| | **Virtual clock.** |
| `packages/skyline` | The fictional airline: timetable, fare rules (`config/skyline.yaml`) and a backend that records policy breaches instead of enforcing them. The 154-tool catalogue includes legacy and partner look-alikes. The MCP server is stateless, with `tools/list` cache hints and a quote card as an MCP App. |
| `packages/lab` | Simulated customers, the simulated model (it reads only the request), the grader (backend end state, money, consent before writes), bets, paired bootstrap statistics, decision rule and memos. |
| `apps/api` | Hono. Serves results and memos, simulates conversations and streams them (SSE), and hosts Skyline over MCP. |
| `apps/console` | React 19, TanStack Query and motion. Shows the bets and their decisions, and a playground that draws each model call as a ribbon of cached, written and fresh input. |
| `config/` | Every setting: prices, cache rules, simulator assumptions, agent, bets and decision thresholds, gate. |
| `scenarios/dev`, `heldout/` | Dev scenarios (tunable). The blind held-out set and its writing guide. |

## Limits

- **Customers and model are simulated.** They share a vocabulary, so real speech and a real model
  will do worse. The held-out gap is a first measure of this.
- **Token counts are approximate for Claude.** Counts use the o200k tokenizer for both providers, so
  absolute Anthropic costs are approximate. Comparisons between strategies hold.
- **OpenAI cache routing overflow is not modelled.** At very high request rates on one prefix,
  requests can spill to machines without the cached entry.
- **Prices are illustrative list prices.** Set contract prices in `config/pricing.yaml`.
