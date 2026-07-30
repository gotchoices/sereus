----
description: In a three-machine test party, one machine writes a second machine's address into the shared party database, but a third machine never sees it — it keeps reading its own older copy for thirty seconds until the test gives up. Happens in roughly one run in five.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts
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

## TODO

- [ ] Add node attribution to the control-stream authorization logging, then re-capture 5+ failures.
- [ ] Determine whether `S` ever receives the block containing `Rx`'s row (storage-level check, not
      a `resolvePeerAddrs` poll).
- [ ] Test the "never vs merely slow" question with a raised timeout.
- [ ] Test the circular-dependency hypothesis directly: does the failure disappear if `S` admits
      `Rx`'s control streams unconditionally? (As a diagnostic only — not a proposed fix.)
- [ ] Produce one or more `implement/` tickets once a mechanism is confirmed.
