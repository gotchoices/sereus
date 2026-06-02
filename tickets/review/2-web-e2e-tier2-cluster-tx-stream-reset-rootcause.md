---
description: Review the cluster-tx stream-reset root-cause fix. The masking layers were removed by the prereq; this ticket fixed the actual `ClusterMember.handleConsensus` throw — a member that reaches consensus on a commit/pend it cannot apply locally (missing pend phase, or already-ahead/stale revision) used to throw, resetting the cluster stream and surfacing to the coordinator as `StreamResetError` → `Some peers did not complete`. The fix makes post-consensus local-execution divergence tolerant (logged, reconciled via sync/read-repair) instead of stream-resetting, while genuinely unexpected faults still propagate. Validated deterministically (new db-p2p spec) and in-browser (write-path failure eliminated). A SECOND, distinct root cause (cross-tab under-replication/convergence) remains and is filed as a separate fix ticket — the 16/16 acceptance is NOT yet met.
files: ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-p2p/test/cluster-consensus-divergence.spec.ts, ../optimystic/packages/db-p2p/src/storage/storage-repo.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts
---

## What changed

### `optimystic/packages/db-p2p/src/cluster/cluster-repo.ts` — the fix
`ClusterMember.handleConsensus` previously executed each consensus-approved
operation against local storage and **threw** on any failure:
- `pend` returning `success:false` → `throw 'Consensus pend failed … stale revision'`
- `commit` returning `success:false` → `throw 'Consensus commit failed … stale revision'`
- `StorageRepo.commit` **throwing** `Pending action <id> not found for block(s): <blockId>`
  (storage-repo.ts:370) when the member never staged the matching pend.

Any of these propagated out of `processUpdate` → `update`, resetting the cluster
stream the coordinator was awaiting (the masked `StreamResetError`).

The fix decomposes the operation loop into `applyConsensusOperation(...)` plus a
module-level `isMissingPendingActionError(...)` classifier. **Post-consensus**,
the cluster has already decided the operation is authoritative, so a *local*
execution failure is not a validity problem — it is local divergence:
- **ahead** — we already hold a newer revision (stale pend/commit → `success:false`);
- **behind** — we missed the prior `pend` cluster-transaction (cohort drift
  between phases / transient unreachability → `commit` throws "Pending action …
  not found").

Both are now **logged** (`cluster-member:consensus-pend-diverged` /
`consensus-commit-diverged`) and **tolerated** rather than thrown, deferring
reconciliation to the sync / lazy read-repair path. The `handleConsensus`
try/catch still rolls back the executed marker and **rethrows genuinely
unexpected faults** (e.g. storage I/O) — so this is targeted, not a blanket
swallow. A genuinely *invalid* operation can never reach here: it is rejected
during the promise phase (`validatePendOperations`). Justifying comments are
inline at the throw site.

### `optimystic/packages/db-p2p/test/cluster-consensus-divergence.spec.ts` — new (5 tests)
Drives a real `ClusterMember` + real `StorageRepo`/`MemoryRawStorage` straight to
the consensus-execution phase for each divergence condition. Asserts the member
no longer throws (and records the txn executed), the happy path still actually
commits (rev lands), and unexpected storage faults still propagate (executed
marker rolled back). **All 5 were authored failing-first** against the unfixed
code (3 reproduced the exact thrown messages) then pass after the fix.

## How the root cause was confirmed (not guessed)

1. A pre-fix Playwright capture (`test-results/.../error-context.md`) showed the
   write failing with `Some peers did not complete: …(in-flight) cause=The
   stream has been reset` for a single block across 4 peer-ids (more than the 3
   service peers ⇒ cohort includes an ephemeral browser self / drift).
2. Tracing the architecture: browser/service coordinator → `CoordinatorRepo`
   → `ClusterCoordinator` 2PC → `ClusterMember.update`. The message embeds
   `expiration: Date.now()+30000`, so `messageHash` (hash of the whole message)
   essentially never collides across operations — ruling out the "Peers
   mismatch" / stale-`activeTransactions` hypotheses (cases 1–2 in ticket-1) and
   pointing at consensus-execution (case 4).
3. The deterministic spec reproduces the **exact** thrown messages
   (`Pending action a-missing not found for block(s): block-1`, etc.).
4. A debug e2e run after the fix confirms the write-path failure is gone (see
   Validation), closing the loop on the masked `StreamResetError`.

## Validation performed

- `@optimystic/db-p2p` **build** (`tsc`) — exit 0 (also rebuilt
  `@optimystic/reference-peer` for the e2e fixture — exit 0).
- `@optimystic/db-p2p` **test** — **502 passing / 8 pending / 0 failing**
  (includes the 5 new divergence tests; no regressions).
- **Browser e2e (3 target specs, `OPTIMYSTIC_E2E_DEBUG=1`)**, rebuilt web bundle
  + spawned mesh both carrying the fix:
  - `Some peers did not complete` occurrences: **0** (was the failure signature).
  - `cluster-member:consensus-*-diverged` fired on the browser **and** all three
    service peers — fix is active end-to-end and absorbing the divergence.
  - Tab A's sends all land with real message-ids and **no error banner**
    (write path works).

## HONEST GAP — acceptance NOT fully met

The ticket's acceptance ("Tier-2 sweep 16/16 across 3 runs") is **not achieved**.
The fix resolves the *named* root cause (the stream-reset throw); the three
multi-tab specs now fail on a **separate** root cause — **cross-tab
under-replication / convergence**: the `pend` and `commit` of one edit are
independent cluster transactions with independently-selected cohorts, so ~25% of
members reach commit-consensus without the matching pend. Post-fix they tolerate
this (no crash) but don't apply the commit → the block is under-replicated →
cross-tab reads return a stale-but-present revision (`get:missing`=0,
`cluster-fetch:synced`=0). This is filed as
`tickets/fix/web-e2e-tier2-cross-tab-convergence-under-replication.md`
(prereq: this ticket).

Reviewer judgement call: the member-side tolerate-don't-throw fix is correct and
necessary (without it writes fail outright), but it leaves diverged members
silently behind. If the reviewer prefers, the convergence ticket's "active
reconciliation in `handleConsensus`" direction could be pulled forward into this
fix instead of deferred — that would both maintain replication and likely turn
the three specs green. It was deferred here as a distinct, larger design change
(wiring a peer-fetch into the consensus path) warranting its own tested ticket.

## Use cases for the reviewer to exercise

- **Unit (fast, deterministic):**
  `yarn workspace @optimystic/db-p2p exec node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cluster-consensus-divergence.spec.ts" --reporter spec`
  — expect 5 passing. Revert the `cluster-repo.ts` change to see 3 fail with the
  real thrown messages.
- **Full unit suite:** `yarn workspace @optimystic/db-p2p test` — expect
  502 passing / 8 pending / 0 failing.
- **No false tolerance:** confirm `applyConsensusOperation` still propagates a
  non-divergence storage error (the "simulated disk I/O failure" test) and that
  the happy-path commit actually lands the revision (not just swallows).
- **Browser (heavy; defer 3× stability to CI):**
  `OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web test:e2e`
  — confirm `Some peers did not complete` / `StreamResetError` no longer sink the
  writes; the three multi-tab specs will still fail on convergence until the
  follow-up ticket lands.

## Provenance — code lives in the sibling `../optimystic` repo (uncommitted)

The runner commits the **sereus** repo, but the actual code change is in the
**separate `optimystic` git repo** working tree (same situation the prereq
flagged). After this implement run:
- **sereus** (runner-committed): only ticket-file moves — deleted
  `tickets/implement/2-web-e2e-tier2-cluster-tx-stream-reset-rootcause.md`, added
  this review ticket and `tickets/fix/web-e2e-tier2-cross-tab-convergence-under-replication.md`.
- **optimystic** (NOT committed, per the "do not commit" instruction — needs to
  land in the optimystic repo): `packages/db-p2p/src/cluster/cluster-repo.ts` (M)
  and `packages/db-p2p/test/cluster-consensus-divergence.spec.ts` (new).

Reviewer/runner must ensure those two optimystic files are committed to the
optimystic repo (cf. the open `land-orphaned-cluster-error-envelope` backlog
item) or the fix is lost. The dist for both `@optimystic/db-p2p` and
`@optimystic/reference-peer` was rebuilt from this source.

## Notes / residual risk

- The fix marks a tolerated transaction as executed (so retries don't re-enter
  the throw). For the "behind" case this means the member records "processed
  this consensus decision" without holding the data; reconciliation is left to
  read-repair, which is the gap the follow-up ticket closes.
- Only the 3 target specs were run in-ticket; the other 13 (reported green by
  the prereq) were not re-run here.
- A few transport-level `StreamResetError` remain in the browser
  `batch-coordinator retry:setup-failed` logs but are retried through (not
  application throws); investigate only if they correlate with the convergence
  follow-up.
- The prereq's own residual gaps (envelope path not exercised over a real
  transport) are unchanged by this work.
