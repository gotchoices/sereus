description: Saving one chat message between two parties takes 50 to 130 back-and-forth network exchanges, and even re-reading unchanged messages asks the other party several times. Over a relay to a phone that multiplies into seconds per action, and the fix belongs in the optimystic storage library, not in sereus. Also, commits sometimes fail when the joining party runs as a storage node.
files:
  - ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (live read arm refreshes each tree from the network, ~line 1215)
  - ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts (`collectPromises`, the "Failed to get super-majority" shortfall)
  - ../optimystic/tickets/complete/1-a-two-member-cohort-refuses-a-commit-both-members-hold.md (fixed upstream after 1.0.0; see 2026-09-18 status)
  - packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts (the committed, opt-in measurement — every re-measure from 2026-09-23 on)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (its topology, and where the pre-2026-09-23 measurements were taken from)
repro: verified
----

# Optimystic: strand reads and commits cost dozens of round trips, which a relay turns into seconds

Blocked because the code is in `../optimystic`, a separate repository with its own ticket board. Sereus has already reduced how often it reads (`complete/0-rn-chat-poll-overlaps-slow-reads`), but not what one read or commit costs.

**Carried upstream 2026-09-17:** optimystic `tickets/fix/strand-reads-and-commits-cost-dozens-of-round-trips-over-a-relay.md` (`c5540380`). Unblock when that lands: re-measure with the scenario below and re-run the device relay chat.

**Upstream status 2026-09-17:** two fixes landed at optimystic `012573a2` (unchanged-table refresh, no push-back of commit copies). Remeasure: `complete/relay-round-trips-remeasure-optimystic-012573a2` — reads and B inserts roughly halved or better, 9 `/cluster` per commit remains the main cost, and `TornActionError` with a `storage` joiner rose to 7 of 16 concurrent pairs (2 of them saved despite reporting failure). Stays blocked on those two.

**Upstream status 2026-09-18:** optimystic main `e6ab12c6` + `30f04bd4` (after 1.0.0, not yet published) fixes the two-member `commit-not-durable: 1 of 2 … (local-executed)` refusal: when the coordinator lacks the base block, it now gets one more fetch-and-restore after a remote member reports holding the write. Its ticket is now complete (`bug-a-two-member-cohort-refuses-a-commit-both-members-hold`, `3647c95a`). Checked here at sereus `a4a1bff9` against the local link: `strand-chat-participants-converge` "writes IMMEDIATELY" passed 3 of 3 with no `commit-not-durable` or `local-executed` in the `optimystic:db-p2p:*` debug log. Upstream still open: the joiner never stores the log-tail block it reads through the host, and the "1/2 approvals" shortfall through the delaying relay proxy. Re-measure the round-trip counts and the `storage`-joiner `TornActionError` rate when those land, or when the next optimystic release ships.

**Upstream status 2026-09-20:** the consensus-round reduction is promoted to optimystic `plan/feat-a-commit-pays-three-consensus-rounds-of-three-calls-each` (candidates: coordinator signs its commit vote first; tail and sweep in one round). Stays blocked here until that lands; then re-measure with the latency fixture.

**Upstream status 2026-09-20 (night):** both candidates landed on optimystic main (`16dd8ba1` commit round carries the coordinator's vote; `e6e84aa1` tail and blocks in one round for a single coordinator), gate green, HEAD `cadcb919`, not yet published (npm still `1.1.0`). Upstream expects about 4 `/cluster` streams per two-party insert instead of 9. Re-measure: `fix/relay-round-trips-remeasure-optimystic-cadcb919`.

**Upstream status 2026-09-21: re-measured at optimystic `cadcb919`** (dist built after `e6e84aa1`), sereus `28cbee8a`, same method as the 012573a2 re-measure. Full numbers: `complete/relay-round-trips-remeasure-optimystic-cadcb919`. Upstream's expectation holds: **4 `/cluster` streams per insert from either party, down from 9.**

| Measure | 012573a2 | cadcb919 |
|---|---|---|
| A insert, through the proxy (10 reps) | 115–228 ms, 40–51 exchanges, 9 `/cluster` + 1–3 `/repo` | 70–195 ms, 15–42 exchanges, 4 `/cluster` + 0–2 `/repo` |
| B insert, through the proxy (10 reps) | 109–164 ms, 44–53 exchanges, 9 `/cluster` + 1–4 `/repo` | 95–138 ms, 29–42 exchanges, 4 `/cluster` + 3–6 `/repo` |
| Unchanged reads by B | 0–1 `/repo`, 0–15 exchanges | unchanged: 0–1 `/repo`, 5–16 exchanges |
| Insert, 150 ms each way on A's link (3 reps) | A 8.9–9.5 s, B 10.1–37.9 s | A 4.5–5.1 s, B 5.1–5.9 s |
| Reads, 150 ms each way | A 1.9–2.5 s; B 0.6–1.3 s (one 5.6 s) | A 1.3–1.9 s; B 0.6–1.3 s (one 3 ms) |
| Concurrent pair, `storage` joiner, no proxy (12 pairs) | 483–2390 ms, 20–92 `/cluster` per side | 268–1097 ms, 4–22 `/cluster` per side |
| `TornActionError`, `storage` joiner, concurrent pairs | 5 of 12 (7 of 16 with the proxied run) | **0 of 12**; every row landed on both sides |
| Control pairs, both `transaction` | 0 of 4 | 0 of 4 |
| Frames, loopback journey at the latency arm's install line (3 runs) | 11,939–12,531 | 8,537–9,338 |
| Frames, 10 ms arm at its final line (3 runs) | 9,512–13,760 | 6,794–12,830 (no clear change) |

The 27 block-transfer streams after the first insert of every run are now 0–6, and the 45-`/cluster` burst from B about 30 s after the join was not seen (this run waits for B's membership rows before counting, which may be what it was). The full integration suite passed with no failures, including every scenario that reads right after a member returns; sereus does not use the opt-in reactivity that the three-member commit-certificate change affects. At 300 ms round trip an insert still costs about 5 s, so each remaining `/cluster` round is still ~1.2 s on a relayed phone. Nothing in sereus is left to do here; this ticket stays blocked only as the record for gotchoices/sereus#13 until the optimystic release that carries `cadcb919` ships.

**Upstream status 2026-09-23: re-measured at optimystic `9e5c1e85`** (dist built after it), sereus `fff9f777`, same method and the same runs and reps as the `cadcb919` re-measure. Full numbers: `complete/relay-round-trips-remeasure-optimystic-9e5c1e85`. Three upstream fixes were in scope: a received replica records its source as a holder so it is not pushed back (`9270de5e`), rebalance no longer fetches blocks it already holds (`dcf8ac32`), and a write after another handle's commit fetches the log tail once instead of twice (`9e5c1e85`). **The log-tail fix is the one that shows: the joiner's `/repo` streams per insert fell from 3–6 to 2–3.** The commit is still 4 `/cluster` streams per insert from either party.

| Measure | cadcb919 | 9e5c1e85 |
|---|---|---|
| B insert, through the proxy (10 reps) | 95–138 ms, 29–42 exchanges, 4 `/cluster` + 3–6 `/repo` | 78–153 ms, 28–33 exchanges, 4 `/cluster` + **2–3 `/repo`** |
| A insert, through the proxy (10 reps) | 70–195 ms, 15–42 exchanges, 4 `/cluster` + 0–2 `/repo` | 57–165 ms, 15–28 exchanges, 4 `/cluster` + 0–2 `/repo` |
| Unchanged reads by B | 1 `/repo`, 5–16 exchanges | unchanged: 1 `/repo`, 4–14 exchanges |
| Insert, 150 ms each way (3 reps) | A 4.5–5.1 s, B 5.1–5.9 s | A 3.8–4.5 s, B 5.1–6.1 s |
| Reads, 150 ms each way | A 1.3–1.9 s; B 3 ms–1.3 s | A 1.25–1.89 s; B 3 ms–1.27 s |
| Concurrent pair, `storage` joiner, no proxy (12 pairs) | 268–1097 ms, 4–22 `/cluster` per side | 250–324 ms, one side 4 / the other 10 |
| `TornActionError`, `storage` joiner, concurrent pairs | 0 of 12 | **0 of 12**; every row landed on both sides |
| Control pairs, both `transaction` (4 pairs) | 276–355 ms, A 10 / B 4 `/cluster` | 481–1109 ms, 10–22 `/cluster` per side |
| Frames, loopback journey (3 runs) | 8,537–9,338 | 7,548–8,739 |
| Frames, 10 ms arm at its final line (3 runs) | 6,794–12,830 | 6,405–8,025 |

Not one error of any kind occurred in seven runs. Two things optimystic asked about specifically. **`/db-p2p/block-transfer` is sent only by A** (the founder and coordinator) and never by B, which fits "A pushes to B" and does not fit "B fetches" — so the rebalance-fetch reading of the earlier counts looks wrong. The count itself is 5–7 during the first `Message` insert of a run plus a 2–6 tail in the next 3 s, then **zero for every later insert**; the 27-after-the-first-insert figure from `012573a2` is still gone, and nothing accumulates. But `cadcb919` recorded this on one run out of seven with no tail, where this re-measure sees it on every run, and the temporary scenario had to be rewritten from scratch (the earlier copy left no recoverable source), so a scenario difference cannot be ruled out as the cause of that particular change.

The one number that moved the wrong way is the control concurrent pair, both parties `transaction`, which went from 276–355 ms to 481–1109 ms and is now slower than the `storage`-joiner pairs in the same session — the opposite of the expected ordering. One run of four pairs against one run of four pairs is weak evidence, and nothing here attributes it to the three fixes; a second control run would settle it. Regression check: the scenarios that read right after a member returns, restarts or joins late, plus both circuit journeys, all pass (7 files, 13 tests) — narrower than the full-suite pass the `cadcb919` re-measure ran. Nothing in sereus is left to do here; this ticket stays blocked as the record for gotchoices/sereus#13.

**Status 2026-09-23 (later): the control-pair slowdown was run-to-run variance, not a regression.** The measurement is now a committed, opt-in scenario (`packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts`, run with `RELAY_RRT_MEASURE=1`; see `docs/testing.md` → "Where measurements live"), so this and every later re-measure use the same file. Re-run against the same optimystic build as the re-measure above (`9e5c1e85`; the two commits since it touch only that repo's tickets, and its `dist` is unchanged), this time three runs of each configuration instead of one.

| Concurrent pair | 9e5c1e85, one run each | 2026-09-23 later, three runs each (12 pairs each) |
|---|---|---|
| Both parties `transaction` (the control) | 481–1109 ms, 10–22 `/cluster` per side | 260–907 ms |
| `storage` joiner | 250–324 ms, one side 4 / the other 10 | 252–600 ms |

Per run, in milliseconds, with the `/cluster` streams each side opened:

- Control: run 1 — 299, 277, 262, 260 (A 10 / B 4 every rep); run 2 — 488, 484, 485, 556 (A 16 / B 10); run 3 — 907, 554, 517, 490 (A 16–22 / B 10–16).
- `storage` joiner: run 1 — 331, 255, 300, 281 (A 10 / B 4); run 2 — 252, 258, 262, 282 (A 4 / B 10); run 3 — 486, 477, 519, 600 (A 10–16 / B 10–16).

**So the control pairs are not slower than the `storage`-joiner pairs, and there is nothing here to carry upstream as a regression.** The spread is BETWEEN RUNS, not between the two configurations: each run settles into one retry pattern at bring-up and every pair in that run repeats it — the same side loses each time, and it re-drives its commit the same number of times. Three patterns appeared, in both configurations: one side re-driving once (4 and 10 `/cluster`, 250–330 ms), both sides re-driving (16 and 10, 480–560 ms), and one run where a side re-drove three times (22, 907 ms on its first pair). Each re-drive costs 6 extra `/cluster` streams. The 481–1109 ms figure above was one control run that landed in a slower pattern, measured against one `storage`-joiner run that landed in the fastest one.

What is worth carrying upstream is the pattern itself rather than either number: **for identical work, a run costs up to 3.5× another because of how many times a commit is re-driven, and that is decided once per run rather than per pair.** Sequential pairs are unaffected (114–168 ms control, 115–151 ms `storage` joiner, 4 `/cluster` per side in every rep of every run) — the variation is entirely in the contended path.

Errors: **0 of 24 concurrent pairs**, no error of any kind in six runs, all 48 rows present on both sides by id, and every run's `Message` id sets matched within 30 s.

The committed scenario reproduces the earlier numbers for the commit itself (4 `/cluster` per insert from either party), for timings, for exchanges on the relayed link and for the proxy totals (2,173 exchanges and 2.9 MB per `config1` run, against 2,181 and 2,191 before).

**The one figure that first looked like a scenario difference turned out to be the same per-run pattern.** The split between `/repo` and `/db-p2p/sync` on the joiner's insert was recorded as 1 `/repo` plus 1–3 sync in the first session with this file, where the deleted scenario had recorded 2–3 `/repo` plus 0–1 sync — the same total of 2–4 streams either way. Two further `config1` runs on 2026-09-23 produced `repo=3–4, sync=0` in one run and `repo=1, sync=1–3` in the other, so ONE file reproduces BOTH published bands. Like the `/cluster` retry pattern above, the split is fixed once per run at bring-up and every rep of that run repeats it. Nothing to reconcile: the pre-2026-09-23 counts are comparable, provided the comparison is run-band against run-band rather than rep against rep.

**Draft follow-up for #13** (post after the sereus release that raises the `@optimystic/*` floor; posting is the maintainer's call):

> Follow-up on the round-trip cost: the sereus release <version> requires `@optimystic/*` <version>, which cuts a commit's consensus rounds. In the same two-party relay topology, an insert now opens 4 cluster-protocol streams instead of 9. With 150 ms added each way on one party's link, an insert takes about 5 s, where it took 9–10 s (one run took 38 s). The loopback journey's frame count dropped from about 12k to about 9k. Each remaining round still costs a relayed phone roughly one round trip, so we're keeping this open to look at further reductions.

## How it was measured

2026-09-17, sereus `25a5010`, optimystic `ab67fa47` (dist built). Two parties, each a single `CadreNode` with `listenAddrs: []`, connected only through the dedicated loopback relay (the `blind-relay-phone-to-phone-e2e` topology). Chat schema (`Participant`, `Message` with a foreign key to `Participant`). Party A (founder, the phone's role) on `profile: 'transaction'`. A's relay connection went through a counting TCP proxy. Each operation below ran alone, with no polling. Outbound streams were counted by wrapping `newStream` on each strand node's connections. "Exchanges" means how many times traffic on A's relay socket changed direction, roughly one request plus its response per two.

Both parties `transaction`, no added delay, sequential operations:

| Operation | Time | Exchanges on A's link | Streams opened |
|---|---|---|---|
| A inserts a message | 220–250 ms | 48–64 | 9 `/cluster`, 0–3 `/repo`, 0–2 `/db-p2p/sync`, plus FRET neighbour/ping |
| B inserts a message | 300–620 ms | 84–130 | 9 `/cluster`, 12 `/repo`, 0–20 `/db-p2p/block-transfer` |
| B reads `App.Message` (nothing changed) | 45–80 ms | 18–30 | 2–7 `/repo` from B |
| B reads `App.Participant` (nothing changed) | 32–70 ms | 16–18 | 4 `/repo` from B |
| A reads a table B just wrote to | 5–14 ms | 0 | none (B's commit had already pushed it to A) |

So the joiner (B) re-asks the founder for blocks on every read, even when nothing changed. Every commit runs 9 cluster-protocol streams plus block fetches.

With 150 ms added each way on A's link (a stand-in for a phone on Wi-Fi behind a relay; the device run's path was also tunnelled over USB), the same work took: reads 2–33 s, commits 6–45 s (chat-shaped polling that waits for the previous read, both parties `transaction`). The device run measured PC inserts at 6.5–16 s and PC reads at 18–24 s, which is the same order.

## Commit failures when the joiner is a storage node

The device's PC party ran `profile: 'storage'`. With B switched to `storage` (A still `transaction`):

- No proxy, 3 runs of sequential then concurrent inserts: 2 passed (concurrent commits 0.9–3.2 s, against 0.3 s sequential). 1 failed on the concurrent pair with `TornActionError: collection default/app/Data: action … is torn at rev 7 — its log entry is stored but block(s) … do not hold that revision, and the write cannot be finished: stale revision`.
- Through the proxy with no added delay, 4 of 4 runs failed: 3 with `Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)` on an insert, 1 with `Block default/app/Message is unavailable (cohort-unreachable)` on a read. Treat these as weaker evidence. The proxy adds an async hop, and A had a connection gater that refused direct dials to the relay's real port. Neither is present on a device.
- A `storage` joiner also generates much more traffic: one A insert set off 32 `/db-p2p/sync` and 15 `/db-p2p/block-transfer` streams from B.

The device phone ran optimystic `7cd71341`, from before `a-write-whose-log-entry-landed-alone-is-reported-saved`. There, refusals like these were retried rather than raised, which would show up as latency rather than errors. That fits the device log (no errors, minutes of delay). It has not been confirmed.

## What to carry to optimystic

- Does a live read have to go to the network for every tree on every statement? Could a read skip the refresh when a recent refresh, or a push from the cohort, already proved the tree current? The joiner's 2–9 requests per unchanged read are the cost that polling multiplies.
- Why does a commit need 9 `/cluster` streams and up to 15 `/repo` fetches in a two-member cohort, and can the round trips be batched? **Answered below** — see "Static inventory of the write path": 3 repo messages × 3 consensus rounds, of which two rounds look removable before any batching is attempted.
- The `storage`-joiner commit failures, especially the `TornActionError` without a proxy, as evidence for `bug-a-two-member-cohort-refuses-a-commit-both-members-hold` or as a new ticket.

## Reproducing

**The measurement is committed** as `packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts` and runs only under `RELAY_RRT_MEASURE=1`; `docs/testing.md` → "Where measurements live" has the configurations and the command. What follows is the recipe it implements, kept because it explains the shape: copy the `blind-relay-phone-to-phone-e2e` topology and replace its "Data BOTH ways" section with timed inserts and reads; for the latency cases point A's `relayAddrs` at a local TCP proxy in front of the relay's WebSocket port that delays each chunk in order. With the throwaway versions, A soon opened a direct connection to the relay's real port and bypassed the proxy (exchange count dropped to 0), so a gater refusing direct dials to that port was added and every published number was taken with it. That bypass does NOT reproduce in the committed scenario: removing the gater on 2026-09-23 and running `config1` and `delayed` left every one of A's paths on the proxy port. The scenario still asserts against a bypass, because the failure is silent when it happens, but that assertion has never been seen to fire — do not use it to prove the gater is doing anything. Up to 2026-09-23 each re-measure rewrote this from scratch and deleted it afterwards, which is what made the third re-measure unable to tell a change from a scenario difference. `backlog/debt-relay-scenarios-never-see-link-latency` tracks the separate asymmetric-latency fixture (one slow machine, one fast).

## Corroborating measurement 2026-09-20: outbound WebSocket frame counts

From the investigation of gotchoices/sereus#13 (replied 2026-09-20, issue left open), counted by wrapping the global `WebSocket` constructor that `@libp2p/websockets` dials with, so every frame each node writes to the relay is counted. Same `blind-relay-phone-to-phone-e2e` topology as the exchange counts above, four nodes in one process.

A plain passing run — formation, first sync, the joiner's membership rows, and one App row written each way — costs **4,735 outbound frames across 4 dialed sockets, 2,192 of them on the busiest socket**, in 3.5 s. The busiest socket is one node's single connection to the relay, which carries every circuit stream that node has: control, every strand, and FRET maintenance.

With constant one-way latency added, the same work costs substantially more frames, not merely slower ones: ~13,400 frames at 10 ms, and 16,400–21,500 at 50 ms. Four to five times the frames for identical work suggests retry or re-request churn that grows with delay; which layer produces it was not identified and is worth finding.

Two consequences for this ticket's thesis. Any per-frame cost — a real link's per-packet overhead, or a slow device's per-frame crypto — multiplies by roughly 2,200 on the node that carries the most traffic. And because that node has exactly ONE outbound socket, a burst of frames on any one stream head-of-line-blocks every other stream it has, including the FRET maintenance RPCs whose budget is 2 s (`MAINTENANCE_RPC_TIMEOUT_MS` in `../Fret/packages/fret/src/service/fret-service.ts`). An injector that serializes frames makes this visible immediately: worst observed frame wait reached 2.36 s at a 2 ms configured delay.

Reproduce the baseline count with `WS_FRAME_STATS=1 yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e` (`packages/integration-tests/src/harness/ws-latency.ts`). That file now holds two tests — the loopback journey and a committed 10 ms latency arm — and the baseline total is the FIRST summary line printed after the loopback test passes.

**The frames-vs-delay ratio above is unconfirmed.** The counts in this section were read off the fixture's periodic 5 s progress line, which is a running subtotal rather than a total; the environment path has no end-of-run hook, because vitest recycles its forked workers rather than exiting them. Re-measured on 2026-09-21 at the one boundary in that file which declares a total — the latency arm's install, which prints the accumulated counters before zeroing them — the loopback journey costs 11,939 and 12,531 frames over two runs and the 10 ms `pipelined` arm 12,200 and 13,760. On that hardware adding 10 ms does not multiply the frame count at all, which is the opposite of the "four to five times the frames for identical work" above. The windows are not identical (the boundary-declared one also covers the loopback arm's teardown), so neither pair of numbers is settled — but the retry-or-re-request-churn hypothesis this paragraph rests on should be re-measured at a declared boundary before it is relied on. The per-frame multiplier argument in the paragraph below is unaffected: it needs only that the busiest socket carries thousands of frames, which every measurement agrees on.

**Re-measured 2026-09-20 (evening), same command:** loopback journey 10,795 frames (busiest socket 5,200) at its end-of-test line, 12,219 at the latency arm's install boundary; the 10 ms `pipelined` arm 9,512 (busiest 4,512, worst send wait 158 ms). This agrees with the 2026-09-21 figures: the loopback journey is ~11–12k frames, and 10 ms of latency does not multiply it. The "4,735 / 2,192" figure above matches the latency arm's own mid-run subtotal (4,698 / 2,144), not the baseline.

**Release: follow-up, not the current one** (maintainer, 2026-09-20). This ticket is where the exchange/frame volume gets addressed.

**Reporter is waiting on this.** gotchoices/sereus#13 was told (2026-09-20) that the 48–130 exchanges per insert are under root-cause investigation, with the fix planned for a release after the current one. When this lands or is re-measured, post the new counts on #13.

## Static inventory of the write path, 2026-09-20 — where the 48–130 exchanges come from

Read off the code rather than measured, at optimystic `e6ab12c6`. It accounts for the
measured numbers above without a residual, so there is no unexplained multiplier hiding
in the stack. The cost factorizes into four independent multipliers:

```
round trips per write  =  C collections  ×  3 repo messages  ×  3 consensus rounds
```

**1. Three consensus rounds per repo message** (`ClusterCoordinator.executeTransaction`).
Each round is a separate `ICluster.update` RPC to every cohort member, and
`ProtocolClient.processMessage` opens a NEW libp2p stream per RPC:

- `collectPromises` — members sign an approve/reject/conflict/held vote.
- `commitTransaction` — members sign a commit vote.
- `broadcastMergedRecord` — members finally APPLY.

Members apply only in round 3 because `getTransactionPhase` reaches
`TransactionPhase.Consensus` only on a record already carrying a majority of commit
signatures (`cluster-repo.ts:1148`), and round 2's payload is sent with `record.commits`
empty. Round 3 is awaited on the critical path.

**2. Two-phase commit at the repo layer** (`TransactorSource.transact`): `pend` then
`commit`, each its own cluster transaction. Paid even by a single-collection,
single-block write, where there is nothing to make atomic.

**3. The commit itself is split in two** (`NetworkTransactor.commit`): `commitBlock(tailId)`
runs to completion, then `commitBlocks(everything else)`. Two sequential cluster
transactions, in practice against the same cohort.

3 × 3 = **9 sequential `/cluster` streams per collection per write** — exactly the
"9 `/cluster` per commit" measured above, which confirms the arithmetic.

**4. Collections, not tables, are the unit.** The main tree, every declared secondary
index and every synthesized UNIQUE-enforcement index is a separate `Collection` with its
own header, log, tail block and full 9-round pipeline
(`IndexManager.initialize` / `setUniqueEnforcementIndexes`; registered individually by
`OptimysticVirtualTable.registerCollections`). `TransactionCoordinator.pendPhase` and
`commitPhase` fan out over them concurrently, so C multiplies MESSAGES but not DEPTH.

Depth is therefore 9 round trips regardless of C; width is 9 × C streams. GATHER is free
(`queryClusterNominees` resolves from the local FRET ring), as is coordinator lookup
(`findCoordinator` is ring-hash plus cache, never a DHT walk).

The reads on top: a live read refreshes EVERY tree it touches from the network before
scanning (`OptimysticModule.runQuery`'s non-committed arm awaits `tree.update()` per
tree), and each `update()` costs at least one `get` of `[headerId, tailId]`
(`Collection.readLogEnds`) before `tailShowsNothingNewer` can short-circuit. Per
statement, per tree, with no memo of a refresh already proven current — which is the
"2–9 requests per unchanged read" measured above.

### Verdict: structural cost, not a correctness flaw — but three of the four are avoidable

Nothing here is accidental chattiness and nothing is incorrect. Each multiplier is
individually defensible; the problem is that they multiply.

- **Round 3 looks removable for the common case, and is the cheapest win.** The record
  `commitTransaction` sends to the remote members carries no commit signatures only
  because the coordinator's own member is asked in the same parallel fan-out rather than
  first. Collect the local member's commit signature before the fan-out and a 2-member
  cohort's remote member sees 1 commit, adds its own, and `hasMajority(2, 2)` holds — it
  reaches `Consensus` and applies within round 2. The phase fixpoint documented at
  `cluster-repo.ts:1120` already permits exactly this. `broadcastMergedRecord` would
  become the repair path it already is for behind members, not a mandatory round.
  `broadcastMergedRecord`'s own doc comment asserts the opposite ("on the first pass the
  record it carries has no commit signatures yet, so no member can reach consensus") as
  if it were a requirement; it is a consequence of the ordering choice.
- **The tail/sweep split is a second removable round.** The ordering it protects — log
  tail durable before the data blocks that hang off it — is an ordering WITHIN a
  member's storage. A member handed one message naming both could enforce it locally.
  The split buys a cross-cohort guarantee only when tail and data blocks land on
  different cohorts, which `consolidateCoordinators`' set cover makes rare and which no
  in-process mesh reaches at all (see `cancelAbandonedSweepBlocks`' note).
- **The pend/commit pair is the one to keep.** It is what makes a multi-collection
  transaction atomic, and `TransactionCoordinator` genuinely needs the pend quorum before
  any collection commits.
- **The read refresh wants a memo, not a redesign.** A refresh proven current for a tree
  within one statement — or one transaction — should not be re-asked per tree per
  statement.

Folding away both takes the depth from 9 to 4 (pend 2, commit 2). Neither is free. Members currently
sign commit votes without checking anything first, so a member that applies on receipt must first verify
the promise super-majority itself. The durability gate would then need each member's apply report from the
commit response. The tail/sweep merge must still never let one member expose a non-tail block without its
tail. Upstream's ticket spells out these risks.

### Why this hurts so much more over a relay

Each of the 9 × C rounds is a fresh `newStream` on the node's ONE outbound socket to the
relay. So a write does not cost 9 round trips' worth of packets — it costs 9 × C stream
setups plus 9 × C request/response pairs, all multiplexed through a single circuit, which
is both the source of the frame counts in the section above and the reason a per-frame
cost (a slow device's crypto, a real link's per-packet overhead) multiplies so violently.
