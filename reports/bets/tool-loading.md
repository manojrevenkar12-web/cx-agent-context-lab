# Loading 150 tool definitions versus searching for them

**Verdict: HAND-OFF.** search-dispatch: cost per conversation improves 44.1% (95% CI 42.3% to 46.0%) with guardrails held (anthropic).

**Question.** Does searching the tool catalogue beat loading every definition, and does the way found tools are added matter for the cache?

## What ran

22 scenarios from `scenarios/dev`, 3 seeds each, as overlapping conversations sharing one provider cache. Costs and cache behaviour follow each provider's documented caching rules on the exact requests the real adapters would send (`packages/agent/src/cache`). Latency, tool confusion and summary loss are simulator parameters in `config/sim.yaml`; where a decision rests on them, the memo says so. Every comparison is paired by scenario and seed, with a 95% bootstrap interval.

## anthropic

| Metric | all (baseline) | search-append | search-dispatch |
|---|---:|---:|---:|
| Cost per conversation (USD) | $0.0502 | $0.0405 | $0.0281 |
| Wrong-tool calls per conversation | 0.35 | 0.05 | 0.02 |
| First word, p95 (ms) | 618 | 477 | 477 |
| Model calls per conversation | 10.15 | 13.64 | 13.62 |
| Resolved without breach | 98.5% | 98.5% | 100.0% |
| Repeat questions per conversation | 0.00 | 0.00 | 0.00 |
| Input read from cache | 99.1% | 84.8% | 93.4% |

**search-append: publish.** cost per conversation improves 19.3% (95% CI 14.2% to 24.6%): real, below the hand-off bar. Relative change on the primary metric +19.3% (positive is better).
Rests on simulator assumptions: wrong-tool calls per conversation moved (0.348 → 0.045), and it is driven by a simulator assumption.

**search-dispatch: hand-off.** cost per conversation improves 44.1% (95% CI 42.3% to 46.0%) with guardrails held. Relative change on the primary metric +44.1% (positive is better).
Rests on simulator assumptions: wrong-tool calls per conversation moved (0.348 → 0.015), and it is driven by a simulator assumption; resolved without breach moved (0.985 → 1.000), and it is driven by a simulator assumption.

Failures seen (conversations):

- all: change charged N, expected N (1); policy breach: unquoted_change (1)
- search-append: change charged N, expected N (1); policy breach: unquoted_change (1)

## openai

| Metric | all (baseline) | search-append | search-dispatch |
|---|---:|---:|---:|
| Cost per conversation (USD) | $0.0223 | $0.0170 | $0.0133 |
| Wrong-tool calls per conversation | 0.35 | 0.05 | 0.02 |
| First word, p95 (ms) | 624 | 484 | 482 |
| Model calls per conversation | 10.15 | 13.64 | 13.62 |
| Resolved without breach | 98.5% | 98.5% | 100.0% |
| Repeat questions per conversation | 0.00 | 0.00 | 0.00 |
| Input read from cache | 98.7% | 83.1% | 91.5% |

**search-append: publish.** cost per conversation improves 23.6% (95% CI 20.3% to 27.1%): real, below the hand-off bar. Relative change on the primary metric +23.6% (positive is better).
Rests on simulator assumptions: wrong-tool calls per conversation moved (0.348 → 0.045), and it is driven by a simulator assumption.

**search-dispatch: hand-off.** cost per conversation improves 40.5% (95% CI 38.8% to 42.1%) with guardrails held. Relative change on the primary metric +40.5% (positive is better).
Rests on simulator assumptions: wrong-tool calls per conversation moved (0.348 → 0.015), and it is driven by a simulator assumption; resolved without breach moved (0.985 → 1.000), and it is driven by a simulator assumption.

Failures seen (conversations):

- all: change charged N, expected N (1); policy breach: unquoted_change (1)
- search-append: change charged N, expected N (1); policy breach: unquoted_change (1)

## Next step

Hand off to product engineering: ship the change behind the normal release process, and watch the primary metric and the guardrails in production for two weeks (cache read share and first-word p95 from provider usage fields; resolved rate from QA sampling).

## Limits

- The model and the customers are simulated. The simulator only knows what is in each request, so information lost by a context strategy is really lost; but it does not make the mistakes a real model makes beyond the tool-confusion curve. A live run (`LAB_LIVE=1` with API keys) replaces the simulated model with Claude or GPT through the same adapters.
- Token counts use the o200k tokenizer for both providers; Claude's tokenizer differs, so absolute Anthropic costs are approximate while comparisons between strategies hold.
- OpenAI cache routing overflow at very high request rates on one prefix is not modelled.
