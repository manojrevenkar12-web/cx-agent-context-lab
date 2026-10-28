# The template agent versus the lab's recommendation

**Verdict: HAND-OFF.** stable-tail + search-dispatch + full: cost per conversation improves 52.3% (95% CI 50.4% to 54.1%) with guardrails held (anthropic).

**Question.** Taken together, what does the recommended setup change for a contact centre's traffic?

## What ran

22 scenarios from `scenarios/dev`, 3 seeds each, as overlapping conversations sharing one provider cache. Costs and cache behaviour follow each provider's documented caching rules on the exact requests the real adapters would send (`packages/agent/src/cache`). Latency, tool confusion and summary loss are simulator parameters in `config/sim.yaml`; where a decision rests on them, the memo says so. Every comparison is paired by scenario and seed, with a 95% bootstrap interval.

## anthropic

| Metric | dynamic-first + all + full (baseline) | stable-tail + search-dispatch + full |
|---|---:|---:|
| Cost per conversation (USD) | $0.0588 | $0.0281 |
| First word, p95 (ms) | 761 | 477 |
| Resolved without breach | 100.0% | 100.0% |
| Wrong-tool calls per conversation | 0.48 | 0.02 |
| Repeat questions per conversation | 0.00 | 0.00 |
| Input read from cache | 97.5% | 93.4% |

**stable-tail + search-dispatch + full: hand-off.** cost per conversation improves 52.3% (95% CI 50.4% to 54.1%) with guardrails held. Relative change on the primary metric +52.3% (positive is better).
Rests on simulator assumptions: wrong-tool calls per conversation moved (0.485 → 0.015), and it is driven by a simulator assumption.

## openai

| Metric | dynamic-first + all + full (baseline) | stable-tail + search-dispatch + full |
|---|---:|---:|
| Cost per conversation (USD) | $0.0251 | $0.0133 |
| First word, p95 (ms) | 766 | 482 |
| Resolved without breach | 100.0% | 100.0% |
| Wrong-tool calls per conversation | 0.48 | 0.02 |
| Repeat questions per conversation | 0.00 | 0.00 |
| Input read from cache | 97.1% | 91.5% |

**stable-tail + search-dispatch + full: hand-off.** cost per conversation improves 47.1% (95% CI 45.4% to 48.9%) with guardrails held. Relative change on the primary metric +47.1% (positive is better).
Rests on simulator assumptions: wrong-tool calls per conversation moved (0.485 → 0.015), and it is driven by a simulator assumption.

## Next step

Hand off to product engineering: ship the change behind the normal release process, and watch the primary metric and the guardrails in production for two weeks (cache read share and first-word p95 from provider usage fields; resolved rate from QA sampling).

## Limits

- The model and the customers are simulated. The simulator only knows what is in each request, so information lost by a context strategy is really lost; but it does not make the mistakes a real model makes beyond the tool-confusion curve. A live run (`LAB_LIVE=1` with API keys) replaces the simulated model with Claude or GPT through the same adapters.
- Token counts use the o200k tokenizer for both providers; Claude's tokenizer differs, so absolute Anthropic costs are approximate while comparisons between strategies hold.
- OpenAI cache routing overflow at very high request rates on one prefix is not modelled.
