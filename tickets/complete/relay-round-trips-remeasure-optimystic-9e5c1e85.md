description: Re-measured what saving and reading a chat message costs over a relay, after the storage library landed three fixes aimed at relay traffic. The fix that mattered most is visible: the joining party now makes 2 to 3 requests per save instead of 3 to 6. Everything else is roughly where it was, and there were no errors of any kind in seven runs.
files:
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (the 2026-09-23 status paragraph holds the summary table)
  - tickets/complete/relay-round-trips-remeasure-optimystic-cadcb919.md (the method and the "before" numbers)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (topology, and the frame counts)
----

# Relay round trips re-measured at optimystic 9e5c1e85

2026-09-23. Sereus `fff9f777`, clean apart from the temporary scenario (deleted afterwards). No sereus code changed, so this went straight from fix to complete: there was nothing to implement or review.

## Versions

- `../optimystic` HEAD `2697540f`; `9e5c1e85..HEAD` changes only `tickets/.garden-report.md`, so the code under test is `9e5c1e85`. Working tree clean. The three fixes named in the ticket are all ancestors: `9270de5e` (a received replica records its source as a holder), `dcf8ac32` (rebalance skips blocks it already holds), `9e5c1e85` (a write after another handle's commit fetches the log tail once).
- Newest files in the `dist` folders of db-core, db-p2p and quereus-plugin-optimystic: 2026-09-23 03:24, after `9e5c1e85` (03:23:57). Nothing in `../optimystic` was rebuilt or modified. The stale-build guard passed on every run.

## Method

Same as `complete/relay-round-trips-remeasure-optimystic-cadcb919`, same runs and reps. The temporary scenario had to be rewritten — the earlier one was deleted and the agent log that recorded it truncated its source — so it is a fresh implementation of the same method, not the same file. Anything that turns on an implementation detail of the scenario is therefore weaker evidence than a within-file comparison would be; the topology, the counted quantities, the operation list and the run table all match.

Dedicated loopback relay; A and B each one `CadreNode` with `listenAddrs: []`, `enableRelay: false`; A (always `transaction`) founds a closed strand, B forms and joins; chat schema, signed. A's `relayAddrs` point at a counting TCP proxy in front of the relay's WebSocket port (optionally delaying each chunk, pipelined), and A's connection gater refuses dials to the relay's real port. Outbound streams counted by wrapping `newStream` on every connection of each node; exchanges are direction changes on the proxy's sockets. Setup waits for B's `Strand.MemberPeer` row, then the `pa`/`pb` participants, then 5 s of quiet, before counting starts. Each operation runs alone, then 3 s of settle ("after" window). FRET and libp2p ping/identify streams are excluded.

Every run: A's strand-node paths at setup and at the end used only the proxy port (2 proxy sockets per run), so A did not bypass the proxy.

| Label | B profile | Proxy | Delay | Reps | Insert pairs |
|---|---|---|---|---|---|
| Config 1, 2 runs | transaction | yes | 0 | 5 each | no |
| Delayed, 1 run | transaction | yes | 150 ms each way | 3 | no |
| Config 2, 3 runs | storage | no | — | 4 each | yes |
| Control for the pairs, 1 run | transaction | no | — | 4 | yes |

## The three things the ticket asked for

**1. `/repo` streams per insert.** The log-tail fix is the one that shows.

| | cadcb919 | 9e5c1e85 |
|---|---|---|
| B insert, through the proxy (10 reps) | 3–6 `/repo` | **2–3 `/repo`** |
| A insert, through the proxy (10 reps) | 0–2 `/repo` | 0–2 `/repo` |
| B insert, `storage` joiner, no proxy (12 reps) | 3–6 `/repo` | 0–4 `/repo` (run 2: **0** on all four reps, only 1–4 sync) |
| A insert, `storage` joiner, no proxy | 0–2 `/repo` | 0–2 `/repo` |

Through the proxy the count is tight and per-run stable: run 1 opened 3 on its first insert and 2 on each of the other four; run 2 opened 3 every rep. A's count is unchanged, which is expected — A is the coordinator and was not the case the fix addressed.

**2. `/db-p2p/block-transfer` and `/db-p2p/sync` after the first `Message` insert.** Every block-transfer stream in every run came **from A**, the founder and coordinator. B opened none, in any window, in any run.

| Window | cadcb919 | 9e5c1e85 |
|---|---|---|
| During the first `Message` insert of a run | 6 from A, on 1 of 7 runs | 5–7 from A, on **each of the 6 runs that had an A insert** |
| In the 3 s after that insert | none | 2–6 from A, on each of those 6 runs |
| During or after every later insert | none | **none**, in every run |

So the 27-streams-after-the-first-insert figure from `012573a2` is still gone, and nothing accumulates: after the first insert of a run, block-transfer is zero for the rest of the run. But the first insert now reliably costs 5–7 during plus a 2–6 tail, where the `cadcb919` run recorded it on one run out of seven with no tail. Two readings are available and this measurement cannot separate them: the fixes changed what the first insert does, or the earlier run happened to sample a quantity that varies run to run. The rewritten scenario makes the second reading harder to rule out. Optimystic wanted to know whether these are pushes rather than the rebalance fetch — the counts here say only that A sends them and B never does, which fits "A pushes to B" and does not fit "B fetches".

`/db-p2p/sync` stays small and is sent by both sides: 0–2 from either side during an insert, and occasionally 2–6 from one side in a settle window. Unchanged from `cadcb919`.

**3. The delayed run (150 ms each way on A's link, 3 reps).**

| Operation | cadcb919 (reps 1, 2, 3) | 9e5c1e85 (reps 1, 2, 3) | Exchanges |
|---|---|---|---|
| A inserts a message | 5.08, 5.08, 4.47 s | 4.46, 4.43, 3.84 s | 37–44 |
| B inserts a message | 5.20, 5.09, 5.89 s | 5.11, 5.09, 6.09 s | 50–60 |
| A reads the table B wrote to | 1.87, 1.87, 1.26 s | 1.87, 1.89, 1.25 s | 11–28 |
| B reads unchanged `Message` | 0.64 s, 3 ms, 0.64 s | 0.64 s, 3 ms, 0.63 s | 0–8 |
| B reads unchanged `Participant` | 1.26, 1.25, 1.26 s | 1.24, 1.26, 1.25 s | 9–15 |
| B reads `Message` again | 0.64, 1.28, 0.64 s | 0.63, 1.27, 0.62 s | 5–12 |

Streams: A insert 4 `/cluster` + 2 `/repo`; B insert 4 `/cluster` + 1 `/repo` + 4–6 sync (at `cadcb919`, B's insert opened 4–9 sync and no `/repo` was recorded separately). No block-transfer in any window of this run. Proxy: 1436 exchanges, 2.68 MB, 2 sockets. A's insert is about half a second faster; B's is unchanged. At a 300 ms round trip an insert is still 4–6 s, so the per-round cost a relayed phone pays has not moved.

## Config 1: both `transaction`, through the proxy, no delay (2 runs × 5 reps)

| Operation | cadcb919 | 9e5c1e85 |
|---|---|---|
| **A inserts a message**: time | 70–195 ms | 57–165 ms |
| exchanges | 15–42 | 15–28 |
| streams from A | 4 `/cluster`, 0–2 `/repo`, 0–1 sync | 4 `/cluster`, 0–2 `/repo`, 0–1 sync |
| **B inserts a message**: time | 95–138 ms | 78–153 ms |
| exchanges | 29–42 | 28–33 |
| streams from B | 4 `/cluster`, 3–6 `/repo`, 0–2 sync | 4 `/cluster`, **2–3 `/repo`**, 0–2 sync |
| **A reads the table B wrote to** | 3–12 ms, 0–3 exchanges, 0–1 `/repo` | 9–21 ms, 3–7 exchanges, 1 `/repo` |
| **B reads unchanged `Message`** | 9–23 ms, 5–9 exchanges, 1 `/repo` | 8–25 ms, 4–9 exchanges, 1 `/repo` |
| **B reads unchanged `Participant`** | 21–44 ms, 5–13 exchanges | 23–57 ms, 8–14 exchanges, B 1 `/repo`, A 1–2 sync |
| **B reads `Message` again** | 19–48 ms, 7–16 exchanges | 18–53 ms, 4–13 exchanges, B 1 `/repo` |

Proxy totals per run: 2191 and 2181 exchanges, 2.9 MB each (before: 2138 and 2254, 2.9 MB). Errors: none. Final convergence: both runs.

The commit itself is still **4 `/cluster` streams per insert from either party**, in every rep of every run — the `cadcb919` result holds.

## Config 2: B `storage`, no proxy (3 runs × 4 reps, 12 concurrent pairs)

| Operation | cadcb919 | 9e5c1e85 |
|---|---|---|
| A inserts | 74–144 ms, A 4 `/cluster`, 0–2 `/repo`, 1–2 sync | 72–151 ms, A 4 `/cluster`, 0–2 `/repo`, 0–2 sync |
| B inserts | 89–158 ms, B 4 `/cluster`, 3–6 `/repo`, 0–2 sync | 63–111 ms, B 4 `/cluster`, 0–4 `/repo`, 0–4 sync |
| B reads unchanged `Message` | 8–14 ms, B 1 `/repo` | 3–11 ms, B 0–1 `/repo` |
| B reads unchanged `Participant` | 25–48 ms | 10–36 ms |
| A reads the table B wrote to | 3–12 ms, A 0–1 `/repo` | 15–25 ms, A 2–3 `/repo` |
| Sequential pair | 165–241 ms, 4 `/cluster` each | 125–175 ms, 4 `/cluster` each |
| Concurrent pair | 268–1097 ms, A 4–16 / B 10–22 `/cluster` | 250–324 ms, one side 4 / the other 10 |

Concurrent pair per run (ms): run 1: 294, 278, 301, 262 (A 10 / B 4 every rep); run 2: 318, 258, 284, 277 (A 10 / B 4); run 3: 324, 250, 289, 265 (A 4 / B 10). The loser of each pair re-drives its commit at 6 extra `/cluster` streams; here exactly one side loses every time within a run, and which side it is is fixed per run.

**Control run, both `transaction`, no proxy (4 reps): concurrent pairs 481, 1109, 621, 481 ms, with 10–22 `/cluster` per side** — worse than the `cadcb919` control (276–355 ms, A 10 / B 4) and worse than this run's own `storage`-joiner pairs. This is one run of four pairs against one run of four pairs, so it is weak evidence either way, but it is the one number in this re-measure that moved in the wrong direction and it is the opposite of the expected ordering (the `storage` joiner used to be the harder case). Worth a second control run before anything is concluded from it; nothing here says the three fixes caused it.

### Error tally

| Set of runs | cadcb919 | 9e5c1e85 |
|---|---|---|
| No proxy, `storage` joiner, concurrent pairs | 0 of 12 `TornActionError` | **0 of 12** |
| Control, both `transaction` | 0 of 4 | 0 of 4 |
| Config 1 and delayed runs | 0 | 0 |

**No error of any kind occurred in any of the seven runs, so there is nothing to record verbatim.** Each concurrent pair's two rows were checked by id immediately afterwards: all 24 rows (12 pairs × 2) were present on both A and B, and every run ended with A's and B's `Message` id sets matching within 30 s.

## Frame counts

`WS_FRAME_STATS=1 yarn vitest run blind-relay-phone-to-phone-e2e`, 3 runs.

| Boundary | cadcb919 | 9e5c1e85 |
|---|---|---|
| Loopback journey (the line reporting the delay-0 counters, printed after that arm) | 9,338; 8,537; 8,910 | 8,739 (busiest socket 4,187); 7,548 (3,643); 8,275 (4,003) |
| 10 ms `pipelined` arm, its final (restore) line | 6,794; 12,830; 8,641 | 6,405 (3,001); 6,442 (3,016); 8,025 (3,756) |

Worst send wait in the 10 ms arm: 116–120 ms (before 118–145). Both arms are slightly lower and the 10 ms arm no longer shows the 12.8k outlier, but the spread between runs is wide enough that this is not a measured improvement.

## Regression check

Ran the scenarios that the `cadcb919` re-measure flagged as the ones to watch — anything that reads right after a member returns, restarts or joins late, plus the two circuit end-to-end journeys and the chat-convergence scenario whose "writes IMMEDIATELY" arm exercises the joiner's first write: `control-offline-read-after-restart`, `control-write-while-alone-convergence`, `control-delete-while-alone-convergence`, `strand-late-cadre-join`, `strand-circuit-same-party-e2e`, `strand-chat-participants-converge`, `control-cohort-auto-convergence`. **7 files, 13 tests, all passed.** This is narrower than the `cadcb919` re-measure's full-suite pass (60 files, 276 tests); it covers the paths the three upstream fixes touch, not the whole suite.

## Artifacts

The temporary scenario (`zz-rrt-measure.integration.ts`) was deleted, for the same reason as last time: a committed opt-in measurement would duplicate `backlog/debt-relay-scenarios-never-see-link-latency`, which tracks a reusable latency fixture. Having now had to rewrite it from scratch because the previous copy left no recoverable source, the case for that fixture is stronger than it was. Raw logs are in `tickets/.logs/rrt9-*.log` (git-ignored, pruned automatically).
