description: The test that measures what a chat message costs two people talking through a relay is now committed and runs only when asked for, instead of being rewritten from scratch every time the storage library changes. Running it settled an open question: the slowdown someone spotted last time was run-to-run noise, not a real regression.
architecture: docs/testing.md#where-measurements-live
files:
  - packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts (new — the measurement, opt-in)
  - packages/integration-tests/src/harness/counting-proxy.ts (new — counting TCP proxy, delay injection, the bypass gater)
  - packages/integration-tests/src/harness/stream-counter.ts (new — per-protocol outbound stream counting)
  - packages/integration-tests/src/harness/index.ts (two barrel exports added)
  - docs/testing.md ("Where measurements live" — how to run it, what each configuration measures)
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (the dated result paragraph, and the updated "Reproducing" recipe)
----

# Review: the relay round-trip measurement, committed as an opt-in scenario

## What this is

`packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts` measures what one chat-shaped strand operation costs two parties who reach each other only through a relay: wall-clock time, streams opened per protocol per side, and direction changes ("exchanges") on the relayed party's link. It is the method the three previous re-measures used, written once and committed instead of rewritten and deleted each time.

It runs only under `RELAY_RRT_MEASURE=1`. Four configurations, selectable one at a time:

| Name | Joiner's profile | A's link | Measures |
|---|---|---|---|
| `config1` | `transaction` | counting proxy | The per-operation baseline (5 reps of two inserts and four reads). |
| `delayed` | `transaction` | proxy, 150 ms each way | The same at a 300 ms round trip (3 reps). |
| `config2` | `storage` | direct | Concurrent insert pairs with a storage-profile joiner (4 reps). |
| `control` | `transaction` | direct | `config2`'s control: the same pairs, both parties `transaction`. |

`RELAY_RRT_RUNS=<n>` repeats each selected configuration as separate runs (fresh relay, fresh nodes); `RELAY_RRT_REPS` and `RELAY_RRT_DELAY_MS` override a configuration's repetitions and its injected delay.

## How to validate it

Reproduce a run — about 30 s for the shortest one:

```
RELAY_RRT_MEASURE=1 RELAY_RRT_CONFIG=config1 RELAY_RRT_REPS=1 yarn workspace @serfab/integration-tests exec vitest run relay-round-trip-measure
```

What to check, in rough order of importance:

- **It is skipped by default.** `yarn workspace @serfab/integration-tests exec vitest run relay-round-trip-measure` with no environment variable reports 4 skipped, 0 run.
- **The bypass assertion actually bites.** Delete the `connectionGater` line from A's config and run `config1`: the run must FAIL on "A bypassed the counting proxy", not quietly report a faster link. (This is the check the previous re-measures did by reading the exchange counter afterwards; here it is an assertion.)
- **Nothing else asserts.** Grep the file for `expect(` — the only ones are the bypass check and the "A opened at least one socket through the proxy" check. A run whose numbers are bad is still a passing run; that is the design.
- **Failures are recorded, not thrown.** An insert that raises (a `TornActionError` on a concurrent pair, historically) is appended to the run's error list and printed on the operation's own line and in the `errors (n):` line. Worth reading `measure()` for whether that is airtight — the concurrent pair uses `Promise.allSettled` and pushes each rejection itself, which is a second path into the same list.
- **The printed table is the deliverable.** Each run ends with a per-operation table of ranges over its reps; that is what the ticket paragraphs are written from. A protocol a rep did not open counts as zero for that rep, so `0–2` and `2` mean different things.

## The control-pair question, settled

The 9e5c1e85 re-measure flagged one number moving the wrong way: concurrent pairs with both parties `transaction` took 481–1109 ms against 276–355 ms at `cadcb919`, and were slower than that session's `storage`-joiner pairs — the opposite of the expected ordering. It asked for a second run.

Ran against the same optimystic build (`9e5c1e85`; the two commits since it touch only that repo's tickets, and its `dist` is unchanged from the earlier measurement), three runs of each configuration, 12 pairs each:

- **Control (both `transaction`)**: run 1 — 299, 277, 262, 260 ms (A 10 / B 4 `/cluster` every rep); run 2 — 488, 484, 485, 556 (A 16 / B 10); run 3 — 907, 554, 517, 490 (A 16–22 / B 10–16). Range 260–907 ms.
- **`storage` joiner**: run 1 — 331, 255, 300, 281 (A 10 / B 4); run 2 — 252, 258, 262, 282 (A 4 / B 10); run 3 — 486, 477, 519, 600 (A 10–16 / B 10–16). Range 252–600 ms.

**The control pairs are not slower than the `storage`-joiner pairs.** The spread is between RUNS, not between configurations: a run settles into one retry pattern at bring-up and every pair in it repeats that pattern — same loser, same number of re-drives, 6 extra `/cluster` per re-drive. Both configurations produced all three patterns. The 481–1109 ms was one control run in a slow pattern against one joiner run in the fastest one. Nothing to carry upstream as a regression; what IS worth carrying is that identical work costs up to 3.5× more depending on a retry pattern fixed once per run. Sequential pairs are unaffected (114–168 ms control, 115–151 ms joiner, 4 `/cluster` per side in every rep of every run). Errors: 0 of 24 pairs, all 48 rows present on both sides by id, every run converged. Recorded as a dated paragraph on the blocked ticket.

## Tests added

**None.** Every line of new code is instrument or measurement: the proxy, the gater and the stream counter have no branch a unit test would pin that the measurement itself does not exercise, and the scenario asserts only run validity by design. The one behaviour worth a guard — that the gater really stops the bypass — is asserted inside the scenario on every run rather than in a separate test, because a test of the gater in isolation would not prove the thing that matters (that a live cadre node cannot get around it).

## Known gaps — please look at these

- **One number does not reproduce the deleted scenario.** This file records the joiner's insert as 1 `/repo` plus 1–3 `/db-p2p/sync`; the deleted 9e5c1e85 scenario recorded 2–3 `/repo` plus 0–1 sync, for the same total of 2–4 streams. Everything else matches: 4 `/cluster` per insert from either party, per-operation timings, exchanges, and proxy totals (2,173 exchanges / 2.9 MB per `config1` run against 2,181 and 2,191 before). I could not attribute the difference — the deleted source is unrecoverable (the prior agent's log truncated it at 50 lines) — so it is recorded as a caveat in the file header and on the blocked ticket rather than explained. If you can see what would move a fetch between those two protocols, that is worth knowing.
- **The file still costs the default suite one file slot.** `describe.runIf` skips the tests but Vitest still imports the module: 11 s on this machine, the same as any other scenario file, with no test body run. Excluding it in `vitest.config.ts` unless the variable is set would buy that back, at the cost of dropping it out of `check-test-file-typecheck-coverage`, which only sees files Vitest collects — and the ticket asked for it to stay inside that gate. Tradeoff is stated in the file header; say if you would rather have the 11 s.
- **The gater implements one hook.** `denyDirectPortGate` uses `denyDialMultiaddr` only. `filterMultiaddrForPeer` would also keep the relay's real address out of the address book, which I left off deliberately: it changes what the node knows rather than what it may do, and every published measurement was taken with the dial hook alone. Verified by inspection that cadre-core composes a test gater under its own (control: membership gate; closed strand: revocation gater) and passes other hooks through, and by the bypass assertion on twelve runs.
- **"Exchanges" is coarse.** It is direction changes on a socket that multiplexes every stream the node has, so a burst of requests answered in a burst counts as two, not two per request. Documented at the top of `counting-proxy.ts`; the number is comparable between runs of this scenario and means little in absolute terms.
- **Regression checking was narrow.** The change is additive (two new harness modules, two barrel exports, one new scenario) so I ran `blind-relay-phone-to-phone-e2e` (2 tests) and `harness-topology` (7 tests) rather than the suite, plus `yarn lint`, the integration-tests `typecheck`, and `yarn check:test-file-typecheck-coverage` (360 files, 0 allowlisted) — all pass. The full suite was not run.
- **Timings are one Windows developer machine's**, taken in one session: config1 ×1 run (5 reps), delayed and config2 smoke runs (1 rep), control ×3 and config2 ×3 (4 reps each). Raw logs: `tickets/.logs/rrt-commit-*.log` (git-ignored, pruned automatically).
- **`strandFirstSync` is widened to 120 s on the joiner** so the delayed configuration's bring-up is not cut off by the 30 s default. It cannot change a run that would have succeeded anyway, but it is a difference from the default posture and worth an eye.

## Stale-build guard

Passed on every run. `../optimystic` was neither rebuilt nor modified: HEAD `4b78e970`, working tree clean, and `9e5c1e85..HEAD` touches only `tickets/.garden-report.md`, so the code under test is `9e5c1e85` with its 2026-09-23 03:24 `dist` — the same build the previous re-measure used.
