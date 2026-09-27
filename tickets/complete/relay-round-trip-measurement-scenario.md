----
description: The test that measures what a chat message costs two people talking through a relay is now committed and runs only when asked for, instead of being rewritten from scratch every time. Running it settled two open questions: a slowdown spotted earlier was run-to-run noise, and a stream count that looked like it had changed had not.
architecture: docs/testing.md#where-measurements-live
files: packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts, packages/integration-tests/src/harness/counting-proxy.ts, packages/integration-tests/src/harness/stream-counter.ts, packages/integration-tests/src/harness/index.ts, docs/testing.md, tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md, tickets/backlog/debt-relay-scenarios-never-see-link-latency.md
----

# The relay round-trip measurement, committed as an opt-in scenario

Implement commit `44c89efa`; review fixes in the commit carrying this ticket.

## What is true now

- **The measurement is a file, not a habit.** `packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts` measures what one chat-shaped strand operation costs two parties who reach each other only through a relay: wall-clock time, streams opened per protocol per side, and direction changes ("exchanges") on the relayed party's link. The same measurement had been written from scratch and deleted three times, which is why the third re-measure could not tell a real change from a difference between throwaway scenarios.
- **It runs only under `RELAY_RRT_MEASURE=1`.** Verified: the default run reports 4 skipped, 0 run. Four configurations — `config1` (per-operation baseline through the counting proxy), `delayed` (the same at 150 ms each way), `config2` (concurrent insert pairs with a `storage`-profile joiner) and `control` (`config2`'s both-`transaction` control). `RELAY_RRT_CONFIG`, `RELAY_RRT_RUNS`, `RELAY_RRT_REPS` and `RELAY_RRT_DELAY_MS` select and override.
- **Two reusable instruments.** `harness/counting-proxy.ts` is a per-link counting TCP proxy with optional per-chunk delay, plus the gater that refuses direct dials to the relay's real port; `harness/stream-counter.ts` counts the streams each node opens, per protocol, skipping libp2p's and FRET's own upkeep. Unlike `ws-latency.ts`, which swaps the process-wide `WebSocket` constructor, these are per-link — one party can be slow while the other is not.
- **Nothing asserts a count or a duration.** The only two assertions guard run validity (the measured party went through the proxy). A run whose numbers are bad is still a passing run, by design; failures are recorded and printed, because an error rate is part of the measurement.
- **The control-pair question is settled.** The 481–1109 ms the previous re-measure flagged was run-to-run variance, not a regression: each run settles into one commit-retry pattern at bring-up and every pair in that run repeats it, and both configurations produced all three patterns. Recorded as a dated paragraph on `tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips`.

## Review findings

### Fixed in this pass

- **A mistyped numeric override reported a passing test that had measured nothing.** `RELAY_RRT_RUNS=three` became `NaN`, `run <= NaN` was false, and the run finished green in 2 ms having printed nothing at all — the one failure mode a measurement tool cannot have. Reproduced before the fix and after. The three numeric variables are now parsed strictly and fail the run by name; parsing is gated on `RELAY_RRT_MEASURE=1`, so a variable left set in a shell still cannot break the skipped default run (both checked).
- **The bypass assertion threw away the evidence for its own failure.** It ran before the proxy totals, the error list and the summary table, so a run that failed it printed none of them. Moved after the printing.
- **The summary table dropped the settle window, although that window exists to attribute trailing traffic to the operation.** The per-operation lines showed it, the table did not, and the table is what the tickets are quoted from — for a concurrent pair the discarded tail was `A db-p2p/sync 0–4, A repo 0–2, B db-p2p/sync 0–2, B repo 0–2`. Added `settle exch` and `settle streams` columns; the existing columns are untouched, so numbers published from earlier runs stay comparable. `printSummary` lost its inline grouping and cell-building to `groupByLabel` and `streamCell`.
- **The handoff's one unexplained caveat was not a caveat.** It recorded that the file "does NOT reproduce" the earlier split between `/repo` and `/db-p2p/sync` on the joiner's insert (1 `/repo` + 1–3 sync here, 2–3 `/repo` + 0–1 sync before) and asked for an explanation. Two `config1` runs of two reps produced `repo=3–4, sync=0` in one run and `repo=1, sync=1–3` in the other — one file reproducing both published bands. It is the same per-run pattern the ticket had already established for the `/cluster` counts: fixed once at bring-up, repeated by every rep of that run. Corrected in the file header and in the blocked ticket, which no longer tells readers to treat the older counts as a separate baseline.
- **The gater's necessity was stated as fact and does not reproduce.** The handoff's own validation step — delete the `connectionGater` line and the run "must FAIL on 'A bypassed the counting proxy'" — does not fail. Removing the gater and running `config1` at 1 and 3 reps and `delayed` at 2 reps left every one of A's paths on the proxy port; libp2p had no reason to re-dial a peer it was already connected to. The gater stays (the failure is silent when it does happen, and every published number was taken with it) but the header, `counting-proxy.ts`, `docs/testing.md` and the blocked ticket now call it insurance rather than a demonstrated mechanism, and say not to expect deleting it to fail a run.
- **A backlog ticket now rejects a design that has since landed.** `tickets/backlog/debt-relay-scenarios-never-see-link-latency.md` carried a "Rejected, with the reason recorded" section ruling out exactly the delaying per-link TCP proxy plus `denyDialMultiaddr` gater that is now `harness/counting-proxy.ts`. All three of its reasons have moved: the bypass no longer reproduces, the gater no longer produces the `cohort-unreachable` failures it was blamed for (six gated runs, no error of any kind, after the upstream cohort fixes), and chunk order does survive — but only because the delay is constant. The ticket now records what landed and narrows itself to what is genuinely still missing (an *asserting* fixture, not the instrument); the original rejection is kept below it, dated, as the record of why. Its `description`, `files` and "what is still missing" section were stale in the same way and were corrected.

### Parked as tripwires, not tickets

- **Chunk order in the delaying proxy survives only because the delay is constant** — node keeps one timer list per duration and fires it in insertion order. A jittered or per-chunk delay would silently reorder the stream and would need the hand-written due-time queue. `NOTE:` at the `setTimeout` in `counting-proxy.ts`.
- **The bypass assertion samples two instants**, setup and end, so a direct connection that opened and closed between them would slip past it. The proxy totals are the cross-check. Noted in the scenario header rather than made into a polling check, because the condition has never been observed at all.

### Checked and found sound

- **Resource cleanup.** Every handle is released in `finally` in the right order — the stream tally unwraps before the nodes stop, the proxy and relay stop after. A throw anywhere in bring-up leaves nothing running.
- **The double error path the handoff asked about.** `measure()` catches a rejecting `run()` and `conc-pair` pushes its own `Promise.allSettled` rejections; the two paths are disjoint (the concurrent arm never rejects), both land in one list, and `errorsBefore`/`slice` attributes them to the right operation either way. No change needed.
- **The stream counter's wrap and unwrap.** One wrapper per connection, guarded against double-wrapping, counting the negotiated protocol rather than the offered list, restoring the original on `stop()`, and a `counting` flag so a wrapper that outlives `stop()` cannot write into a stale tally.
- **The gater's circuit handling.** Circuit dials are exempted before the port test, so a peer reachable only through the relay is not cut off.
- **Source hygiene.** 513 lines for the scenario against a 1,812-line neighbour; 151 and 101 for the harness modules. The comments say why rather than narrating statements. The two barrel exports pull in nothing at import time.
- **The documented anchor.** `docs/testing.md` has the "Where measurements live" section the ticket names, and its new subsection matches what the file actually does after these fixes.

### Tests

**None added, none cut.** The new code is instrument and measurement: the proxy, the gater and the stream counter have no branch a unit test would pin that a run does not already exercise, and the scenario asserts only run validity by design. The one defect this pass found — the silent no-op on a mistyped override — is a module-load throw that a test would only restate, and it is verified by running the command two ways. A test of the gater in isolation would prove less than the in-scenario assertion does, and after this pass we know the isolated test would be pinning behaviour the scenario cannot even produce.

### Not run

**The full 57-file integration suite.** At real-network scenario runtimes it is well past the point where a command is agent-runnable, and the implement stage skipped it for the same reason. In its place: `yarn lint`, the integration-tests `typecheck`, `yarn check:test-file-typecheck-coverage` (360 files, 0 allowlisted), `blind-relay-phone-to-phone-e2e` and `harness-topology` (9 tests), and six end-to-end runs of the measurement itself. The blast radius supports that: nothing outside the barrel and the new scenario imports either harness module, and the only behavioural edits in this pass are inside the opt-in scenario.

**No pre-existing failures surfaced.** Everything run passed.

### No tickets filed

Nothing found reached the filing bar. The two conditional concerns are tripwires by definition ("fine now; only matters if a jittered delay is added" / "only matters if a bypass ever happens"), and every other finding was a wrong statement in a comment, a document or a ticket, or a defect small enough to fix here — all fixed.
