# Working in this repository

## Fast feedback

- `npx vitest run`: agent, skyline, lab and api tests, in seconds.
- `npx biome check . && npx tsc -p . && npx tsc -p apps/console`: lint and types.
- `npm run lab -- bets`: regenerates `reports/`, about 20 s. CI fails if the committed reports differ from a fresh run.
- `npm run lab -- gate`: the release gate.
- `cd apps/console && npx vitest run && npx playwright test`: console tests.

## Invariants (each has a test or a CI check)

1. **The simulated model reads only the request.** `Responder.respond(req)` gets a `ModelRequest`
   and nothing else. `policy.ts` and `facts.ts` never import scenarios, customers, the grader or the
   runner as values (`packages/lab/test/sim.test.ts`). If a context strategy drops a fact, the model
   does not have it.
2. **One rule places cache breakpoints.** `placeBreakpoints` is used by both the Anthropic adapter
   and the simulator, so the simulated bill is the bill for the request that would be sent.
   Never give either of them its own placement.
3. **Every tool call is answered before the next request.** The loop checks `pairingErrors` on
   every request after the context strategy has cut it.
4. **Assumptions are marked.** Anything not taken from a provider's documentation lives in
   `config/sim.yaml` with a comment saying what it is based on. Bets list the metrics that rest on
   assumptions (`assumption_metrics`), and the memo says so.
5. **Settings live in `config/`, not in code.** This covers prices, cache rules, agent settings,
   bets, decision thresholds and the gate.
6. **Reports are generated.** Never edit `reports/` by hand. Runs are deterministic (seeded and on a
   virtual clock), and CI checks a fresh run matches the committed one byte for byte.
7. **The backend records policy and does not enforce it.** Breaches (`unverified_access`,
   `unquoted_change`) are logged and graded, the way real systems are. Don't add enforcement to
   Skyline to make a number look better.

## Held-out sets

`heldout/<set>/scenarios.yaml` is written by someone who has seen only
`heldout/WRITING_SCENARIOS.md`, never the code. `npm run lab -- heldout <set>` records the first run
in `reports/heldout/<set>/first_run.json`. That file is never rewritten, and the run refuses to go
on if the scenarios changed after it.

Never change the agent, the simulated model or the customer to pass a held-out set. If you study a
set's failures, do three things:

1. Write `regression` to `heldout/<set>/STATUS`.
2. Move what you learned into `scenarios/dev`.
3. Have a new set written blind.
