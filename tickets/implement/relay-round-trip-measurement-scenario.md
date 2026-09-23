description: Keep the relay round-trip measurement as a committed, opt-in test instead of rewriting it from scratch for every optimystic change (it has been rebuilt three times), and use it to check whether concurrent inserts between two ordinary parties got slower at optimystic 9e5c1e85.
files:
  - tickets/complete/relay-round-trips-remeasure-optimystic-9e5c1e85.md (the method; the most recent rewrite of the scenario)
  - tickets/complete/relay-round-trips-remeasure-optimystic-cadcb919.md, relay-round-trips-remeasure-optimystic-012573a2.md (earlier runs, same method)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (topology to reuse)
  - packages/integration-tests/src/harness/ (existing fixtures: dedicated relay, ws-latency)
  - docs/testing.md ("Where measurements live")
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (record the control-pair result here)
----

# Commit the relay round-trip measurement as an opt-in scenario

## Why

The relay round-trip method (counting TCP proxy with a gater on A, `newStream` counts per protocol, exchanges on A's link, the 150 ms delayed run, the storage-joiner concurrent pairs) has been rewritten from scratch for each of the three re-measures (`012573a2`, `cadcb919`, `9e5c1e85`), because each copy was deleted afterwards. The 9e5c1e85 completion notes the rewrite means results "cannot rule out a scenario difference" between runs. Optimystic is still changing relay traffic, so more re-measures are coming. The reason given for deleting it, that it would duplicate `backlog/debt-relay-scenarios-never-see-link-latency`, doesn't hold. That ticket is about asymmetric latency (one slow machine, one fast), not about keeping this measurement.

## Do

1. Commit the measurement as `packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts`, **skipped unless an environment variable is set** (for example `RELAY_RRT_MEASURE=1`; `describe.runIf` or equivalent). The default `yarn test` run must not execute it or become slower. Put reusable pieces (the counting proxy with its gater, the per-protocol stream counter, the exchange counter) in `packages/integration-tests/src/harness/` if they are more than a few lines, so other scenarios can use them.
2. Select configurations by environment variable, so one config can be run alone: config 1 (both `transaction`, proxied), the delayed run, config 2 (storage joiner, concurrent pairs), and the control pairs. It prints per-operation tables in the form the complete tickets use. It asserts only what makes a run invalid, such as A bypassing the proxy (the relay's real port appearing in A's paths). Don't assert on counts or timings; this is a measurement, not a budget.
3. Document it in `docs/testing.md` under "Where measurements live": how to run it, and what each config measures.
4. **Settle the control-pair question.** At `9e5c1e85` the concurrent pairs with both parties `transaction` took 481–1109 ms with 10–22 `/cluster` per side, against 276–355 ms at `cadcb919`, from one run of 4 pairs each. Run the control config 3 times (12 pairs) against the current linked optimystic and report the range. If it is still slower than the storage-joiner pairs, say so plainly, with the per-side `/cluster` counts, so it can go to optimystic. Record the result as a dated paragraph on the blocked round-trip ticket.

Do not rebuild or modify `../optimystic`. If the stale-build guard trips, stop and report it.

## Edge cases

- The proxy gater must still stop A dialing the relay's real port. Check it by inspection, and by the invalid-run assertion above.
- Leaked sockets or nodes after the scenario must not affect the next file. Use the harness's existing teardown.
- The typecheck coverage checks (`test:test-file-typecheck-coverage`) must include the new file.
