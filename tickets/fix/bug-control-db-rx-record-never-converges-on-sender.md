----
description: In a three-machine test party, one machine writes a second machine's address into the shared party database, but a third machine never sees it — it keeps reading its own older copy for thirty seconds until the test gives up. Happens in roughly one run in five.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/harness/test-party.ts, packages/cadre-core/src/cadre-node.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts
difficulty: hard
----

# Sender node never converges a sibling-written address row; stuck on its own older revision

Split out of `bug-control-db-stale-revision-not-retryable` at fix stage. That ticket's Shape A (a
concurrent-write conflict thrown instead of retried) is real and is now in `implement/`. This is the
*other*, more common failure of the same scenario, and the evidence says it is a **different
defect** — most occurrences involve no write conflict at all.

## Symptom

```
Error: Timeout waiting for S resolves Rx's address record via replication after 30000ms
```

`packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts:746-750`, in the test
`wakes a member whose authorization and address were learned by control-DB replication, not local
seeding`.

Three nodes, full mesh, all links confirmed before any write:

- `A` — sole party owner and sole writer of the rows under test.
- `S` — sender, a plain member; must learn `Rx`'s address row purely by replication.
- `Rx` — receiver, a plain member with a stable key.

`A` writes two rows in order: `A.authorizePeer(S)` then `seedReceiverRecord(A, Rx, …)`
(scenario lines 719-720). `Rx` converges the first row fine. `S` never converges the second.

## Measured, fix stage, 2026-07-29, HEAD `7be4675`

Run alone — whole-file runs mask it:

```
cd packages/integration-tests
yarn vitest run src/scenarios/push-wake-e2e.integration.ts -t 'learned by control-DB replication'
```

25 valid runs: 18 pass, 2 Shape A (the split-write conflict, now in `implement/`), **5 this shape**
(~20 %). A pass takes ~15 s; this failure takes ~45 s.

## Evidence: this is not the write-conflict bug

Across the 5 captured failures of this shape, with
`DEBUG='optimystic:db-p2p:cluster*,optimystic:db-p2p:coordinator*,optimystic:db-core:transactor*,optimystic:db-core:collection*,sereus:cadre:*'`:

| marker | 4 of 5 runs | 5th run |
|---|---|---|
| `cluster-member:validation-stale-revision` | 0 | 3 |
| `cluster-tx:rejected-by-validators` | 0 | 3 |
| `PartialCommitError` / "not atomic" | 0 | 0 |

So the majority of these failures involve no revision conflict anywhere, and none of them produces
the split write. Fixing the write-path classification cannot fix this.

## Evidence: what actually happens

From the captured log of a failing run (timestamps relative to `A`'s writes):

- `+0.0 s` — `A` logs `refreshAuthorizedControlPeers(external-write): 2 authorized peer(s)`. `A`
  holds both rows locally, so `seedReceiverRecord` did not throw and did not silently no-op.
- `+0.05 s → +30 s` — `S` polls `resolvePeerAddrs(Rx)` 115 times. **Every single one logs
  `resolvePeerAddrs: no record`** — the row is absent from `S`'s view outright; it is not a row that
  arrives and then fails a signature/freshness/trust gate.
- In a **passing** run, `resolvePeerAddrs: no record` appears **zero** times: `S` already has the
  row on its first poll. So on the happy path the row reaches `S` essentially synchronously with
  `A`'s commit. When that delivery is missed, nothing appears to re-pull it within 30 s.

This points at: the cohort commit's push to `S` is lost, and no read-side path recovers it — `S`
keeps serving its own older revision (the one containing only its own row) indefinitely.

### Signals ruled out — do not re-chase these

Both were checked against a captured **passing** run and appear there too, at similar rates:

- `cluster-fetch:no-quorum { responders: 0, required: 1 }` — 120 in a failure, 50 in a pass. It
  fires for `default/CadrePeer`, `default/Revocation`, `default/OwnerKey` on both paths. Background
  noise on this topology, not the discriminator.
- `cluster-tx:supermajority-failed` — 4 in one failure, 0 in two others, **6 in the pass**.

### Signal worth pursuing

`authorizeInboundControlStream: DENYING <Rx> on …/db-p2p/sync/1.0.0 — not in the materialized
authorized set (1 member(s))` — 12 and 26 occurrences in two failures, 1 in two others, **0 in the
pass**. The denied peer is `Rx`; the denying node has a 1-member authorized set, which fits `S`
(whose set is `{S}` until `Rx`'s row converges). That is a plausible circular dependency worth
testing directly: `S` refuses `Rx`'s control-DB streams *because* it has not yet learned `Rx`'s row,
and something in the recovery path needs those streams. It is a correlation, not a proven cause —
one of the five failures had only a single such denial.

## What the fix stage should establish

- Which node emits each `DENYING` line. The current logs merge all three nodes into one stream with
  no node tag, which made attribution guesswork. Add a node identifier to
  `authorizeInboundControlStream` logging (or run the nodes in separate processes) before drawing
  conclusions from it.
- Whether `A`'s `seedReceiverRecord` commit actually reached `S`'s storage at all — i.e. is this a
  lost push, or a push that landed but left `S`'s read path serving a cached older revision?
- Whether any periodic path would *eventually* recover it. The scenario's own comments mention a
  15 s cohort-reconcile and a 450 s record-refresh heartbeat; two reconcile passes elapse inside the
  30 s window without fixing it, so the reconcile path is either not doing this job or is being
  blocked.
- Whether raising the test timeout would let it pass (distinguishing "slow" from "never"). Answer
  this before proposing any fix — a fix for a stall and a fix for permanent loss look nothing alike.

## Constraints

- **Do not fix this by seeding the row locally on `S`, or by widening the test's timeout.** The
  scenario exists specifically to prove a plain member learns a sibling-written fact by replication;
  both of those erase what it tests.
- **Do not weaken the fail-closed control-stream gate** to make the denials stop. If the gate is
  genuinely part of a circular dependency, the fix is to break the cycle deliberately (an explicit
  carve-out, like the existing bootstrap-peer one), not to open the gate.
- **Do not weaken `packages/integration-tests/src/harness/build-freshness.ts`.** It aborts the suite
  whenever a sibling repo (`../quereus`, `../optimystic`) is mid-edit — including when another agent
  is working there. That is deliberate and documented; retry instead. Rebuild
  `@serfab/cadre-core` and `@serfab/cadre-host` before running.

## Added evidence, review stage of `bug-control-db-stale-revision-not-retryable`, 2026-07-29

The retry fix has landed. Re-running the same command 20 times: 14 pass, 6 fail. The original
"conflict thrown instead of retried" shape is **gone**. What remains is this ticket's shape, in
three costumes — all the same root cause, the read path never observing the winner's revision:

- 2/20 — `Timeout waiting for S resolves Rx's address record via replication` (this ticket's
  headline symptom).
- 2/20 — `SyncRetryExhaustedError: sync for collection default/CadrePeer exhausted 10 retries`.
  This is the retry fix *working*: the loser now retries instead of hard-failing. But every retry
  re-reads and still does not see the winner's committed revision, so it recomputes the same
  revision number and loses again, ten times. Benign here — it failed on the first tree of the
  commit sweep, so nothing was durably written.
- 1/20 — the same retry exhaustion, but it happened on the *second* tree of the sweep after the
  first had already committed → `PartialCommitError` (a real split write on disk).

So the retry-exhaustion failures and this ticket's timeout are the same defect: **a writer whose
re-read never converges inside its retry budget.** Whether that manifests as a timeout or as a
split write is luck about which tree the sweep was on. Fixing the convergence here removes all
three costumes. There is no separate write-path defect left to chase.

(The split-write itself — a commit sweep that is not atomic across trees — is a known, documented
structural limitation of the single-node commit mode, with a planned narrowing already recorded in
`../optimystic/docs/transactions.md` § "Legacy (single-node) commit is not atomic across trees".
Not a new defect and not this ticket's job; it is the amplifier, not the cause.)

## Relationship to other tickets

- `bug-control-db-stale-revision-not-retryable` (now in `review/`) — same scenario, different
  shape. Independent; neither blocks the other. Landing it removed Shape A from the run and left
  this shape as the only remaining failure, which makes reproduction here *cleaner*, not harder.
- Not `bug-control-cohort-no-auto-dial` — all three nodes are explicitly meshed before any write.
- Not `bug-strand-three-party-replication` — different subsystem.

## Fix-stage session 2, 2026-07-29 — reproduced, and the discriminator found

Ran the scenario 5× at HEAD `5d611d5` after rebuilding every dependency the suite loads from `dist`
(`@quereus/quereus`, `@optimystic/db-core`, `@optimystic/db-p2p`, `@serfab/cadre-core`,
`@serfab/cadre-host`). 4 pass, 1 fail. The failure was the `PartialCommitError` costume:

```
PartialCommitError: Legacy multi-tree commit was not atomic: 1 tree(s) were durably committed …
Persisted: [default/CadrePeer]. Not persisted: [default/CadrePeer/index/_uniq_5].
Underlying failure: sync for collection default/CadrePeer/index/_uniq_5 exhausted 10 retries:
stale revision: block ePtVbdeDgVypLSHpzXHEFDklUjTyhZc6h3OaZI8Xi74 at rev 1, requested rev 1
```

Command (run alone — whole-file runs mask it):

```
cd packages/integration-tests
DEBUG='optimystic:db-p2p:libp2p-key-network,optimystic:db-p2p:coordinator-repo,sereus:cadre:node' \
  npx vitest run src/scenarios/push-wake-e2e.integration.ts -t 'learned by control-DB replication'
```

Those three namespaces are the useful set — far smaller than the previous session's capture and they
carry the signal. Logs land at ~5 000 lines per run.

### The discriminator: read-repair converges on the pass and never on the fail

Counting `cluster-fetch:*` markers (all emitted by `CoordinatorRepo`, `db-p2p/src/repo/coordinator-repo.ts`):

| marker | passing run | failing run |
|---|---|---|
| `cluster-fetch:synced` (a block actually converged) | **3** | **0** |
| `cluster-fetch:local-current` (cohort answered, we were already current) | **2** | **0** |
| `cluster-fetch:no-quorum` (cohort queried, *zero* peers answered) | 54 | 96 |
| `cluster-fetch:solo-self-skip` (cohort view was self-only, so no query attempted) | 135 | 114 |

This is what the previous session was missing, and it reverses that session's "signals ruled out"
call on `no-quorum`. `no-quorum` is not the discriminator by itself — it is background on both paths
— but *zero successful convergences of any kind* is. On the passing run the read-side repair path
works a handful of times; on the failing run it works zero times, and every single attempt ends in
either "nobody answered" or "I don't think anyone else holds this".

### Why that means "never", not "slow" — the ticket's open question, answered

`CoordinatorRepo.fetchBlockFromCluster` is the **only** read-side recovery channel. It is reached
from `CoordinatorRepo.get` when a block is missing locally (`isMissing`), and it needs at least one
cohort peer to answer a latest-revision query over `…/db-p2p/sync/1.0.0`. When the node's own cohort
view for the block is self-only it does not even try (`solo-self-skip`); when peers are in the view
but none answer, it returns without converging (`no-quorum`). Neither outcome schedules a retry of
its own — the next attempt only happens on the next read of that block, which is why `S` polls 115
times and gets the same answer 115 times. Nothing else in the stack re-pulls a block a node never
received. So: **permanent loss, not a stall.** No point raising the test timeout.

### Leading hypothesis: the control cohort is capped at two members, so a three-node party never replicates to all three

`packages/quereus-plugin-sereus/src/cluster-size.ts:7` — `DEFAULT_CLUSTER_SIZE = 2`, and
`packages/integration-tests/src/harness/test-party.ts:50` passes exactly that. In
`Libp2pKeyPeerNetwork.findCluster` (`db-p2p/src/libp2p-key-network.ts:556`) the non-self slots are
`clusterSize - 1`, i.e. **one**. Tallying the `findCluster:membership` lines confirms the cohort
never exceeds two members, and is frequently just one:

| cohort shape | passing run | failing run |
|---|---|---|
| `serves=0 unknown=0 foreignDropped=0 kept=1` (self only) | 313 | 250 |
| `serves=2 … kept=2` (self + one of the two available peers) | 113 | 192 |
| `serves=1 … kept=2` | 8 | 8 |

Note `serves=0 unknown=0`: on those calls FRET's `assembleCohort` returned nothing but self, so the
membership filter had nothing to classify. That is a separate weakness from the size cap and worth
confirming independently — a self-only cohort view is what produces `solo-self-skip`.

Chained together this explains all three costumes with one mechanism:

- `A`'s `seedReceiverRecord` commit goes to a 2-member cohort: `A` plus **one** of `{S, Rx}`. When
  the partner is `Rx`, `S` is simply not in the write's cohort and never receives the block. That is
  the lost push — no denial, no conflict, nothing to see in the write path, matching the previous
  session's finding that 4 of 5 failures showed no revision conflict anywhere.
- `S`'s recovery is `fetchBlockFromCluster`, whose cohort view is capped the same way and is often
  self-only — so the one node that *does* hold the row may not be in the view at all. Hence
  `no-quorum` / `solo-self-skip`, hence never converging → the 30 s timeout costume.
- Cohort views that disagree between nodes let two nodes each believe they own revision *n* of the
  same block, which is the `requested rev 1, block already at rev 1` stale conflict, which after 10
  fruitless retries is the `SyncRetryExhaustedError` and — when it lands on tree 2 of the commit
  sweep — the `PartialCommitError`.

Under this reading, `clusterSize = 2` on a 3-node party is the cause and the documented
non-atomicity of the legacy commit sweep is only the amplifier, as already noted below.

### Still unproven — do this next

- **Does raising the control-DB `clusterSize` to 3 make the failure disappear?** Cheapest decisive
  experiment: pass `clusterSize: 3` from the scenario/harness (all three nodes must resolve the same
  value — see the comment at `cluster-size.ts:13-19`) and run 10×. If it goes green, the size cap is
  confirmed as the mechanism, and the *fix* discussion becomes "how should cohort breadth be
  configured for a small party" rather than "what is broken in replication". If it still fails, the
  self-only-cohort behaviour of `assembleCohort` is the deeper cause and the cap is incidental.
  Treat this as a diagnostic, not a proposed fix — hard-coding 3 in the harness would hide the same
  defect for any real 3-node party.
- **Why `assembleCohort` returns self-only so often** (the `serves=0 unknown=0 kept=1` rows). Is
  FRET's routing table empty for those keys, or is the key genuinely far from both peers? This is in
  `db-p2p` (`libp2p-key-network.ts` + the FRET service) and may be the real root cause.
- **Whether `A`'s commit reaches `S`'s storage at all** in a failing run — still worth a
  storage-level check rather than inference, to nail "not in the write cohort" vs "in the cohort and
  the push failed". The cohort-membership hypothesis predicts the former.
- Node attribution on the control-stream authorization log is **not done** and is now lower value:
  the `DENYING` correlation looks like a symptom of the same cohort gap (a node with a 1-member
  authorized set is a node that has not converged), not an independent cause. Do it only if the
  cohort-size experiment above comes back negative.

### Environment note for whoever picks this up

`../quereus` had an agent actively editing `packages/quereus/src/core/database-events.ts` during this
session, so `build-freshness.ts` aborted the suite repeatedly (correctly — see the ticket
constraint). Waiting for the sibling's `src` to stop changing and then running
`yarn workspace @quereus/quereus build` in `C:\projects\quereus` cleared it. Also note the
freshness check compares *newest file anywhere under `dist`* against newest `src`, so
`find src -newer dist/src/index.js` is a misleading way to check it by hand — incremental `tsc`
leaves `index.js` untouched.

## TODO

- [ ] Run the `clusterSize: 3` experiment (10 runs) and record the result — this is the gate on
      everything else.
- [ ] If it goes green: decide where cohort breadth for a small party should come from, and write the
      `implement/` ticket for that. If it stays red: investigate `assembleCohort` returning self-only
      and write the ticket against `db-p2p`.
- [ ] Storage-level confirmation that `S` never received the block (not a `resolvePeerAddrs` poll).
- [ ] Produce one or more `implement/` tickets once the mechanism is confirmed.
