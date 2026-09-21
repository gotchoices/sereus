description: Saving one chat message between two parties takes 50 to 130 back-and-forth network exchanges, and even re-reading unchanged messages asks the other party several times. Over a relay to a phone that multiplies into seconds per action, and the fix belongs in the optimystic storage library, not in sereus. Also, commits sometimes fail when the joining party runs as a storage node.
files:
  - ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (live read arm refreshes each tree from the network, ~line 1215)
  - ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts (`collectPromises`, the "Failed to get super-majority" shortfall)
  - ../optimystic/tickets/complete/1-a-two-member-cohort-refuses-a-commit-both-members-hold.md (fixed upstream after 1.0.0; see 2026-09-18 status)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (the scenario the measurements were taken from)
repro: verified
----

# Optimystic: strand reads and commits cost dozens of round trips, which a relay turns into seconds

Blocked because the code is in `../optimystic`, a separate repository with its own ticket board. Sereus has already reduced how often it reads (`complete/0-rn-chat-poll-overlaps-slow-reads`), but not what one read or commit costs.

**Carried upstream 2026-09-17:** optimystic `tickets/fix/strand-reads-and-commits-cost-dozens-of-round-trips-over-a-relay.md` (`c5540380`). Unblock when that lands: re-measure with the scenario below and re-run the device relay chat.

**Upstream status 2026-09-17:** two fixes landed at optimystic `012573a2` (unchanged-table refresh, no push-back of commit copies). Remeasure: `complete/relay-round-trips-remeasure-optimystic-012573a2` — reads and B inserts roughly halved or better, 9 `/cluster` per commit remains the main cost, and `TornActionError` with a `storage` joiner rose to 7 of 16 concurrent pairs (2 of them saved despite reporting failure). Stays blocked on those two.

**Upstream status 2026-09-18:** optimystic main `e6ab12c6` + `30f04bd4` (after 1.0.0, not yet published) fixes the two-member `commit-not-durable: 1 of 2 … (local-executed)` refusal: when the coordinator lacks the base block, it now gets one more fetch-and-restore after a remote member reports holding the write. Its ticket is now complete (`bug-a-two-member-cohort-refuses-a-commit-both-members-hold`, `3647c95a`). Checked here at sereus `a4a1bff9` against the local link: `strand-chat-participants-converge` "writes IMMEDIATELY" passed 3 of 3 with no `commit-not-durable` or `local-executed` in the `optimystic:db-p2p:*` debug log. Upstream still open: the joiner never stores the log-tail block it reads through the host, and the "1/2 approvals" shortfall through the delaying relay proxy. Re-measure the round-trip counts and the `storage`-joiner `TornActionError` rate when those land, or when the next optimystic release ships.

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

Nothing was committed. Copy `blind-relay-phone-to-phone-e2e.integration.ts` and replace its "Data BOTH ways" section with timed inserts and reads. For the latency cases, point A's `relayAddrs` at a local TCP proxy in front of the relay's WebSocket port that delays each chunk in order. Without a gater, A soon opened a direct connection to the relay's real port and bypassed the proxy (exchange count dropped to 0), so check the counter before trusting any delayed timing. `backlog/debt-relay-scenarios-never-see-link-latency` tracks turning this into a reusable fixture.

## Corroborating measurement 2026-09-20: outbound WebSocket frame counts

From the investigation of gotchoices/sereus#13 (replied 2026-09-20, issue left open), counted by wrapping the global `WebSocket` constructor that `@libp2p/websockets` dials with, so every frame each node writes to the relay is counted. Same `blind-relay-phone-to-phone-e2e` topology as the exchange counts above, four nodes in one process.

A plain passing run — formation, first sync, the joiner's membership rows, and one App row written each way — costs **4,735 outbound frames across 4 dialed sockets, 2,192 of them on the busiest socket**, in 3.5 s. The busiest socket is one node's single connection to the relay, which carries every circuit stream that node has: control, every strand, and FRET maintenance.

With constant one-way latency added, the same work costs substantially more frames, not merely slower ones: ~13,400 frames at 10 ms, and 16,400–21,500 at 50 ms. Four to five times the frames for identical work suggests retry or re-request churn that grows with delay; which layer produces it was not identified and is worth finding.

Two consequences for this ticket's thesis. Any per-frame cost — a real link's per-packet overhead, or a slow device's per-frame crypto — multiplies by roughly 2,200 on the node that carries the most traffic. And because that node has exactly ONE outbound socket, a burst of frames on any one stream head-of-line-blocks every other stream it has, including the FRET maintenance RPCs whose budget is 2 s (`MAINTENANCE_RPC_TIMEOUT_MS` in `../Fret/packages/fret/src/service/fret-service.ts`). An injector that serializes frames makes this visible immediately: worst observed frame wait reached 2.36 s at a 2 ms configured delay.

Reproduce the baseline count with `WS_FRAME_STATS=1 yarn workspace @serfab/integration-tests exec vitest run blind-relay-phone-to-phone-e2e` (`packages/integration-tests/src/harness/ws-latency.ts`). That file now holds two tests — the loopback journey and a committed 10 ms latency arm — and the baseline total is the FIRST summary line printed after the loopback test passes.

**The frames-vs-delay ratio above is unconfirmed.** The counts in this section were read off the fixture's periodic 5 s progress line, which is a running subtotal rather than a total; the environment path has no end-of-run hook, because vitest recycles its forked workers rather than exiting them. Re-measured on 2026-09-21 at the one boundary in that file which declares a total — the latency arm's install, which prints the accumulated counters before zeroing them — the loopback journey costs 11,939 and 12,531 frames over two runs and the 10 ms `pipelined` arm 12,200 and 13,760. On that hardware adding 10 ms does not multiply the frame count at all, which is the opposite of the "four to five times the frames for identical work" above. The windows are not identical (the boundary-declared one also covers the loopback arm's teardown), so neither pair of numbers is settled — but the retry-or-re-request-churn hypothesis this paragraph rests on should be re-measured at a declared boundary before it is relied on. The per-frame multiplier argument in the paragraph below is unaffected: it needs only that the busiest socket carries thousands of frames, which every measurement agrees on.

**Re-measured 2026-09-20 (evening), same command:** loopback journey 10,795 frames (busiest socket 5,200) at its end-of-test line, 12,219 at the latency arm's install boundary; the 10 ms `pipelined` arm 9,512 (busiest 4,512, worst send wait 158 ms). This agrees with the 2026-09-21 figures: the loopback journey is ~11–12k frames, and 10 ms of latency does not multiply it. The "4,735 / 2,192" figure above matches the latency arm's own mid-run subtotal (4,698 / 2,144), not the baseline.

**Reporter is waiting on this.** gotchoices/sereus#13 was told (2026-09-20) that the 48–130 exchanges per insert are under active root-cause investigation. When this lands or is re-measured, post the new counts on #13.

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

With rounds 1 and 3 folded away the depth goes 9 → 4 (pend 2, commit 2) with no change to
what is agreed or when. That is the number worth carrying upstream, ahead of batching.

### Why this hurts so much more over a relay

Each of the 9 × C rounds is a fresh `newStream` on the node's ONE outbound socket to the
relay. So a write does not cost 9 round trips' worth of packets — it costs 9 × C stream
setups plus 9 × C request/response pairs, all multiplexed through a single circuit, which
is both the source of the frame counts in the section above and the reason a per-frame
cost (a slow device's crypto, a real link's per-packet overhead) multiplies so violently.
