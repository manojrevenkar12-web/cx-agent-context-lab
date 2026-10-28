# What to keep from a long call

**Verdict: KILL.** No variant clears the bar: cost per conversation improves 0.6% (95% CI -2.1% to 3.5%); the bar is 10.0% (anthropic).

**Question.** On long calls, which context strategy keeps the agent right and the bill down?

## What ran

6 scenarios from `scenarios/dev`, 3 seeds each, as overlapping conversations sharing one provider cache. Costs and cache behaviour follow each provider's documented caching rules on the exact requests the real adapters would send (`packages/agent/src/cache`). Latency, tool confusion and summary loss are simulator parameters in `config/sim.yaml`; where a decision rests on them, the memo says so. Every comparison is paired by scenario and seed, with a 95% bootstrap interval.

## anthropic

| Metric | full (baseline) | window | summary | casefile |
|---|---:|---:|---:|---:|
| Cost per conversation (USD) | $0.0530 | $0.0797 | $0.0878 | $0.0527 |
| Repeat questions per conversation | 0.00 | 0.39 | 1.33 | 0.50 |
| First word, p95 (ms) | 482 | 725 | 1,339 | 464 |
| Transcript tokens per conversation | 4,627 | 5,122 | 6,398 | 4,680 |
| Resolved without breach | 100.0% | 100.0% | 100.0% | 100.0% |
| Input read from cache | 94.4% | 85.9% | 87.2% | 91.3% |

**window: kill.** cost per conversation gets worse by 50.4% (95% CI -73.7% to -26.3%); the bar is 10.0%; repeat questions rise by 0.39 per conversation (limit 0.1). Relative change on the primary metric -50.4% (positive is better).
Rests on simulator assumptions: repeat questions per conversation moved (0.000 → 0.389), and it is driven by a simulator assumption.

**summary: kill.** cost per conversation gets worse by 65.8% (95% CI -75.0% to -58.1%); the bar is 10.0%; repeat questions rise by 1.33 per conversation (limit 0.1). Relative change on the primary metric -65.8% (positive is better).
Rests on simulator assumptions: repeat questions per conversation moved (0.000 → 1.333), and it is driven by a simulator assumption.

**casefile: kill.** cost per conversation improves 0.6% (95% CI -2.1% to 3.5%); the bar is 10.0%; repeat questions rise by 0.50 per conversation (limit 0.1). Relative change on the primary metric +0.6% (positive is better).
Rests on simulator assumptions: repeat questions per conversation moved (0.000 → 0.500), and it is driven by a simulator assumption.

## anthropic, calls 4x longer

| Metric | full (baseline) | window | summary | casefile |
|---|---:|---:|---:|---:|
| Cost per conversation (USD) | $0.0620 | $0.0992 | $0.1213 | $0.0673 |
| Repeat questions per conversation | 0.00 | 0.50 | 1.72 | 0.61 |
| First word, p95 (ms) | 537 | 867 | 1,487 | 636 |
| Transcript tokens per conversation | 5,992 | 6,667 | 8,213 | 6,053 |
| Resolved without breach | 100.0% | 100.0% | 88.9% | 100.0% |
| Input read from cache | 93.8% | 84.0% | 81.3% | 87.2% |

**window: kill.** cost per conversation gets worse by 60.0% (95% CI -84.2% to -34.5%); the bar is 10.0%; repeat questions rise by 0.50 per conversation (limit 0.1). Relative change on the primary metric -60.0% (positive is better).
Rests on simulator assumptions: repeat questions per conversation moved (0.000 → 0.500), and it is driven by a simulator assumption.

**summary: kill.** cost per conversation gets worse by 95.7% (95% CI -117.0% to -74.6%); the bar is 10.0%; resolved rate drops 11.1 points (limit 2); repeat questions rise by 1.72 per conversation (limit 0.1). Relative change on the primary metric -95.7% (positive is better).
Rests on simulator assumptions: resolved without breach moved (1.000 → 0.889), and it is driven by a simulator assumption; repeat questions per conversation moved (0.000 → 1.722), and it is driven by a simulator assumption.

**casefile: kill.** cost per conversation gets worse by 8.6% (95% CI -13.5% to -3.9%); the bar is 10.0%; repeat questions rise by 0.61 per conversation (limit 0.1). Relative change on the primary metric -8.6% (positive is better).
Rests on simulator assumptions: repeat questions per conversation moved (0.000 → 0.611), and it is driven by a simulator assumption.

Failures seen (conversations):

- summary: customer gave up and asked for a person (2); email not updated (1); bags are N, expected N (1); baggage charged N, expected N (1)

## Next step

Kill: the variants do not clear the bar. Record why, so the idea is not re-run without new evidence.

## Limits

- The model and the customers are simulated. The simulator only knows what is in each request, so information lost by a context strategy is really lost; but it does not make the mistakes a real model makes beyond the tool-confusion curve. A live run (`LAB_LIVE=1` with API keys) replaces the simulated model with Claude or GPT through the same adapters.
- Token counts use the o200k tokenizer for both providers; Claude's tokenizer differs, so absolute Anthropic costs are approximate while comparisons between strategies hold.
- OpenAI cache routing overflow at very high request rates on one prefix is not modelled.
