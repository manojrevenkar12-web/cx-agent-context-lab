# 3. A simulated model that only knows its request

**Decision.** The model under test in CI is a deterministic policy. It is a careful Skyline agent
that reads facts only from the request it receives: customer words, tool results, summaries and the
case file. It has two sources of error:

- **Context loss**, which is real: what a strategy dropped is gone.
- **Tool confusion**, which follows an assumption curve in `config/sim.yaml`.

**Why.** The bets are about what the model sees. A context-faithful simulator measures that
directly, for free and repeatably. A real model would add noise that needs hundreds of paid runs to
average out.

**Cost.**
- The simulator does not make the other mistakes real models make.
- It shares a vocabulary with the simulated customer.
- The held-out gap (100% on dev, 76.5% blind) shows how much that matters.
- Memos flag every metric driven by an assumption.
