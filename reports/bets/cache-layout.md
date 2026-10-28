# Where the changing parts of the prompt go

**Verdict: PUBLISH.** stable-tail: cost per conversation improves 14.6% (95% CI 12.4% to 16.6%): real, below the hand-off bar (anthropic).

**Question.** How much of an agent's input bill and first-word latency is lost to a prompt layout that breaks the provider's cache?

## What ran

22 scenarios from `scenarios/dev`, 3 seeds each, as overlapping conversations sharing one provider cache. Costs and cache behaviour follow each provider's documented caching rules on the exact requests the real adapters would send (`packages/agent/src/cache`). Latency, tool confusion and summary loss are simulator parameters in `config/sim.yaml`; where a decision rests on them, the memo says so. Every comparison is paired by scenario and seed, with a 95% bootstrap interval.

## anthropic

| Metric | dynamic-first (baseline) | stable-first | stable-tail |
|---|---:|---:|---:|
| Cost per conversation (USD) | $0.0588 | $0.0523 | $0.0502 |
| First word, p95 (ms) | 761 | 660 | 618 |
| Input read from cache | 97.5% | 98.9% | 99.1% |
| Resolved without breach | 100.0% | 100.0% | 98.5% |
| Repeat questions per conversation | 0.00 | 0.00 | 0.00 |

**stable-first: publish.** cost per conversation improves 11.1% (95% CI 9.5% to 12.8%): real, below the hand-off bar. Relative change on the primary metric +11.1% (positive is better).

**stable-tail: publish.** cost per conversation improves 14.6% (95% CI 12.4% to 16.6%): real, below the hand-off bar. Relative change on the primary metric +14.6% (positive is better).

Failures seen (conversations):

- stable-tail: change charged N, expected N (1); policy breach: unquoted_change (1)

## openai

| Metric | dynamic-first (baseline) | stable-first | stable-tail |
|---|---:|---:|---:|
| Cost per conversation (USD) | $0.0251 | $0.0230 | $0.0223 |
| First word, p95 (ms) | 766 | 668 | 624 |
| Input read from cache | 97.1% | 98.4% | 98.7% |
| Resolved without breach | 100.0% | 100.0% | 98.5% |
| Repeat questions per conversation | 0.00 | 0.00 | 0.00 |

**stable-first: kill.** cost per conversation improves 8.2% (95% CI 6.9% to 9.7%); the bar is 10.0%. Relative change on the primary metric +8.2% (positive is better).

**stable-tail: publish.** cost per conversation improves 11.1% (95% CI 9.3% to 12.9%): real, below the hand-off bar. Relative change on the primary metric +11.1% (positive is better).

Failures seen (conversations):

- stable-tail: change charged N, expected N (1); policy breach: unquoted_change (1)

## Next step

Publish as internal guidance: the effect is real but below the hand-off bar. Fold it into the agent template and the solution-engineering playbook; no dedicated build.

## Limits

- The model and the customers are simulated. The simulator only knows what is in each request, so information lost by a context strategy is really lost; but it does not make the mistakes a real model makes beyond the tool-confusion curve. A live run (`LAB_LIVE=1` with API keys) replaces the simulated model with Claude or GPT through the same adapters.
- Token counts use the o200k tokenizer for both providers; Claude's tokenizer differs, so absolute Anthropic costs are approximate while comparisons between strategies hold.
- OpenAI cache routing overflow at very high request rates on one prefix is not modelled.
