# 1. Bill every request by the provider's documented caching rules

**Decision.** Cost and cache effects are computed by simulators that implement each provider's
documented rules. They run on the same rendered request the real adapter sends:

- Anthropic breakpoints, the 20-block lookback, minimum length, TTL refresh, and the write and read
  multipliers;
- OpenAI automatic caching from 1,024 tokens in 128-token steps.

Both share one breakpoint-placement function with the Anthropic adapter.

**Why.** Prompt caching is where most of an agent's input bill goes. Its behaviour is documented
precisely enough to compute, so live calls are not needed to measure layout and context choices. A
live run costs money, is noisy, and cannot be repeated in CI.

**Cost.** The lab inherits any error in the documentation, or in our reading of it. Live runs
(`LAB_LIVE=1`) are the check, and the adapters report the providers' own usage fields so the two
can be compared.
