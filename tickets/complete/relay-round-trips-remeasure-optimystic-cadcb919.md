description: Re-measured what strand inserts and reads cost over a relay after optimystic cut a commit's consensus rounds. An insert now opens 4 cluster-protocol streams instead of 9, and behind a slow link an insert takes about 5 s instead of 9–10 s. The torn-write failure with a storage-node joiner did not occur in 12 concurrent insert pairs (before: 5 of 12), and the integration suite showed no new failures.
files:
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (the 2026-09-21 status paragraph holds the summary table)
  - tickets/complete/relay-round-trips-remeasure-optimystic-012573a2.md (the method and the "before" numbers)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (topology)
  - packages/integration-tests/src/harness/ws-latency.ts (frame counts)
----

# Relay round trips re-measured at optimystic cadcb919

2026-09-21. Sereus `28cbee8a`, clean apart from the temporary scenario (deleted afterwards). No code changed, so this went straight from fix to complete: there was nothing to implement or review.

## Versions

- `../optimystic` HEAD `cadcb919`. `e6e84aa1..cadcb919` changes only `tickets/.garden-report.md`, so the code under test is `e6e84aa1`, which includes `16dd8ba1` (commit round carries the coordinator's vote) and `e6e84aa1` (tail and blocks in one commit for a single coordinator). Working tree clean.
- Newest files in the `dist` folders of db-core, db-p2p and quereus-plugin-optimystic: 2026-09-20 23:12, after `e6e84aa1` (23:11:47). Nothing in `../optimystic` was rebuilt or modified. The stale-build guard passed on every run.

## Method

Same as `complete/relay-round-trips-remeasure-optimystic-012573a2`, with a newly written temporary scenario: dedicated loopback relay; A and B each one `CadreNode` with `listenAddrs: []`, `enableRelay: false`; A (always `transaction`) founds a closed strand, B forms and joins; chat schema, signed. A's `relayAddrs` point at a counting TCP proxy in front of the relay's WebSocket port (optionally delaying each chunk), and A's connection gater refuses non-circuit dials to the relay's real port. Outbound streams counted by wrapping `newStream` on every connection of each strand node; exchanges are direction changes on the proxy's sockets. Each operation runs alone, then 3 s of settle ("after" window). FRET and libp2p ping/identify streams are left out of the counts.

One difference from the earlier run: setup waits for B's `Strand.MemberPeer` row before counting starts, then `pa`/`pb` participants, then 5 s of quiet.

Every run: A's strand-node paths at setup and at the end used only the proxy port (2 proxy sockets per run), so A did not bypass the proxy.

## Config 1: both `transaction`, through the proxy, no delay (2 runs × 5 reps)

| Operation | 012573a2 | cadcb919 |
|---|---|---|
| **A inserts a message**: time | 115–228 ms | 70–195 ms |
| exchanges | 40–51 | 15–42 (run 2: 15–20) |
| streams from A | 9 `/cluster`, 1–3 `/repo` | **4 `/cluster`**, 0–2 `/repo`, 0–1 sync; 6 `/db-p2p/block-transfer` on run 1's first insert only |
| streams from B | 0–1 sync, 0–3 block-transfer | 0–1 sync |
| after | 27 block-transfer from A after the first insert | none |
| **B inserts a message**: time | 109–164 ms | 95–138 ms |
| exchanges | 44–53 | 29–42 |
| streams from B | 9 `/cluster`, 1–4 `/repo`, 0–2 sync | **4 `/cluster`**, 3–6 `/repo`, 0–2 sync |
| streams from A | none | 0–1 sync |
| after | — | occasionally A 4 `/repo` or 6 sync, B 1–5 sync |
| **A reads the table B wrote to** | 6–40 ms, 3–15 exchanges, 1–3 `/repo` | 3–12 ms, 0–3 exchanges, 0–1 `/repo` |
| **B reads unchanged `Message`** | 2–17 ms, 0–6 exchanges | 9–23 ms, 5–9 exchanges, 1 `/repo` (A 0–1 sync) |
| **B reads unchanged `Participant`** | 14–35 ms, 8–15 exchanges | 21–44 ms, 5–13 exchanges; B 0–2 sync, 0–1 `/repo`; A 0–2 sync |
| **B reads `Message` again** | 9–44 ms, 4–12 exchanges | 19–48 ms, 7–16 exchanges; B 1 `/repo`; A 1–4 sync |

Proxy totals per run: 2138 and 2254 exchanges, 2.9 MB. Errors: none. Final convergence: both runs.

B's inserts now open 3–6 `/repo` (before 1–4). A's A-insert `/repo` dropped to 0–2. Neither is large; B's rise is probably B fetching the blocks it now receives in fewer rounds.

## Delayed run: 150 ms each way on A's link, both `transaction` (3 reps)

Proxy: 1550 exchanges, 2.6 MB, 2 sockets; A's strand paths used only the proxy port.

| Operation | 012573a2 | cadcb919 (rep 1, 2, 3) | Exchanges |
|---|---|---|---|
| A inserts a message | 8.9–9.5 s | 5.08, 5.08, 4.47 s | 39–48 |
| B inserts a message | 10.1, 10.2, **37.9** s | 5.20, 5.09, 5.89 s | 60–70 |
| A reads the table B wrote to | 1.9–2.5 s | 1.87, 1.87, 1.26 s | 17–19 |
| B reads unchanged `Message` | 0.63, 0.64, **5.6** s | 0.64 s, 3 ms, 0.64 s | 0–5 |
| B reads unchanged `Participant` | 1.26–1.29 s | 1.26, 1.25, 1.26 s | 14–19 |
| B reads `Message` again | 1.28–1.30 s | 0.64, 1.28, 0.64 s | 5–14 |

Streams: A insert 4 `/cluster` + 2–3 `/repo`; B insert 4 `/cluster` + 4–9 sync. No outlier this time. At a 300 ms round trip an insert costs about 17 round trips' worth of time (~5 s), down from ~30.

## Config 2: B `storage`, no proxy (3 runs × 4 reps, 12 concurrent pairs)

| Operation | 012573a2 | cadcb919 |
|---|---|---|
| A inserts | 125–225 ms, A 9 `/cluster` | 74–144 ms, A 4 `/cluster`, 0–2 `/repo`, 1–2 sync; 0–1 block-transfer (first insert only) |
| B inserts | 93–153 ms, B 9 `/cluster`, 1–6 `/repo` | 89–158 ms, B 4 `/cluster`, 3–6 `/repo`, 0–2 sync |
| B reads unchanged `Message` | 7–11 ms | 8–14 ms, B 1 `/repo` |
| B reads unchanged `Participant` | 17–49 ms | 25–48 ms, B 1 `/repo`, A 1–2 sync |
| A reads the table B wrote to | 3–26 ms | 3–12 ms, A 0–1 `/repo` |
| Sequential pair | 211–284 ms, 9 `/cluster` each | 165–241 ms, 4 `/cluster` each |
| Concurrent pair | 483–2390 ms, A 23–71 / B 20–79 `/cluster` | 268–1097 ms, A 4–16 / B 10–22 `/cluster` |

Concurrent pair per run (ms; A/B `/cluster`): run 1: 628 (10/16), 1097 (16/22), 1036 (16/22), 600 (10/16); run 2: 313, 298, 268, 317 (all 4/10); run 3: 452, 348, 311, 295 (all 4/10). The loser of each pair re-drives its commit, which costs it 6 extra `/cluster` streams per retry.

Control run, both `transaction`, no proxy (4 reps): concurrent pairs 276–355 ms, A 10 / B 4 `/cluster` (before 612–1550 ms, 25–65 per side).

### Error tally

| Set of runs | 012573a2 | cadcb919 |
|---|---|---|
| No proxy, `storage` joiner, concurrent pairs | 5 of 12 `TornActionError` | **0 of 12** |
| Control, both `transaction` | 0 of 4 | 0 of 4 |
| Config 1 and delayed runs | 0 | 0 |

No error of any kind in any run, so there is nothing to record verbatim. The scenario checked every concurrent-pair row by id at the end: all 24 rows (12 pairs × 2) were present on both A and B, and every run's `Message` id sets matched within 30 s. The earlier "reported failed but saved anyway" outcome therefore had no chance to occur. The config-2-through-the-proxy set from the earlier run was not repeated; the ticket did not ask for it.

## Frame counts (`WS_FRAME_STATS=1 yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e`, 3 runs)

| Boundary | Before (09-20 evening, 09-21) | cadcb919 |
|---|---|---|
| Loopback journey, at the latency arm's install line | 12,219; 11,939; 12,531 | 9,338 (busiest 4,492); 8,537 (4,119); 8,910 (4,288) |
| Loopback journey, end-of-test line | 10,795 | not printed: the loopback test finished in about 3.8 s, before the 5 s progress tick, so no line falls inside it |
| 10 ms `pipelined` arm, its final (restore) line | 9,512; 12,200; 13,760 | 6,794 (busiest 3,176); 12,830 (6,111); 8,641 (4,060) |

The loopback journey is about 25% fewer frames. The 10 ms arm varies too much between runs to show a change. Worst send wait in the 10 ms arm: 118–145 ms (before 158 ms).

## Regressions to watch for

- **Stale read after a member returns.** Ran the whole integration suite (`packages/integration-tests`, all 56 scenario files plus the `test/` specs, excluding the temporary scenario), in three chunks so each stays under the tool's 10-minute limit: **60 files, 276 tests, all passed, no retries** (14 files/105 tests, 15/44, 31/127; the root `test-harness` specs were not in these chunks). That includes the scenarios that read right after a member rejoins or restarts (`control-offline-read-after-restart`, `control-write-while-alone-convergence`, `control-delete-while-alone-convergence`, `strand-late-cadre-join`, `strand-circuit-same-party-e2e`'s restart arm). One suite pass cannot rule out a flake with a low rate.
- **Three-member cohort commit certificate.** Sereus source does not use optimystic's opt-in reactivity or commit certificates (grep over `packages/*/src` for `reactivity`, `commitCertificate`), so this does not affect sereus.

## Also seen

- The 27 `/db-p2p/block-transfer` streams from A after the first insert of every run are gone. The first A insert of 3 of 7 runs opened 1–6 block-transfer streams during the insert, and 1 of those also 4 afterwards; later inserts opened none.
- The burst of 45 `/cluster` from B about 25–30 s after the join (seen in all 7 earlier runs) did not appear in any "during" or "after" window. This run waits for B's `MemberPeer` row before counting starts, so the burst was probably B's membership reconciler writes, which the earlier run counted and this one did not. Not investigated further.

## Artifacts

The temporary scenario (`zz-rrt-measure.integration.ts`) was deleted: turning it into a committed opt-in measurement would duplicate `backlog/debt-relay-scenarios-never-see-link-latency`, which already tracks a reusable latency fixture. Raw logs are in `tickets/.logs/rrt-*.log` (git-ignored, pruned automatically).
