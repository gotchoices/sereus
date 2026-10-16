description: When an owner removes a machine at the moment that machine publishes its own address record, the removal fails with a "concurrent modification" error instead of being retried, so the user sees a failure and has to try again.
architecture: docs/architecture.md#control-write-retry
files: packages/cadre-core/src/control-write-retry.ts (RETRIABLE_CONTROL_WRITE_MATCHERS, matchesRetriableFailure), packages/cadre-core/src/control-database.ts (lockedWithRetry, removeMachine, deleteCadrePeer, reauthorizeCadrePeer), packages/cadre-core/src/cadre-node.ts (registerSelf, scheduleSelfRegistration), packages/integration-tests/src/scenarios/machine-removal.integration.ts
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The window is one write's duration against a publish every 7.5 minutes (or about a second after a machine starts or joins), and a manual retry succeeds, so the cost is an occasional error message; widening the retry classifier needs a careful check that nothing of the refused transaction can have committed.
----

# An owner write to a machine's row fails when it races that machine's own publish

## What happens

A machine's `CadrePeer` row has two writers: owners (the vouch, the re-touch and re-vouch through `reauthorizeCadrePeer`, the removal through `removeMachine` / `deleteCadrePeer`) and the machine itself, which publishes its signed address record about a second after it starts (`scheduleSelfRegistration`) and again on every heartbeat (7.5 minutes). When the owner's transaction reads the row and the machine's publish commits before the owner's commit, the owner's commit is refused:

```
ConcurrentModificationError: concurrent modification: another writer changed or removed the row in CadrePeer at primary key ("12D3KooW…")
Caused by: TreeEntryChangedError: Tree collection default/cadrecontrol/CadrePeer: the entry at key … was changed by another writer since this change read it
  (read: Sig null, UpdatedAt T; found: Sig set, UpdatedAt T + 2.6 s, the machine's own record)
```

`ControlDatabase.lockedWithRetry` does not re-run the write body, because `isRetriableControlWriteFailure` claims only a cohort that did not answer (`RETRIABLE_CONTROL_WRITE_MATCHERS`). The caller gets the error; for `removeMachine` that is the app's "Could not remove it" with the engine's message.

## How it was seen

`machine-removal.integration.ts`, as rewritten by `machine-removal-leaves-owner-keys`: A removes machine B about two seconds after B joined by invitation and wired its owner key. Without a wait for B's first publish, the run failed 3 times out of 3 at `removeMachine`; the scenario now waits for `registerSelf` (the convention in `docs/testing.md` for scenarios that act on a node right after it starts). Before that ticket, A re-vouched a dependent row first, which happened to give B's publish time to land. The race itself is older than that ticket: the delete is the same.

`cadre-node.ts` `scheduleSelfRegistration` notes the same error from the other side (a restarted machine whose own row replicates in while its update runs), recovered there by the next reconcile pass.

## Expected

An owner write that loses to the row's own machine is re-run: the body re-reads the row, and the re-run commits. The removal's signature binds the row's `StampId`, which a self-publish does not change, so a re-signed or re-presented removal is still valid; the owner re-touch keeps the row's `UpdatedAt`, so it re-reads the new one.

To confirm before changing the classifier: that the optimystic transaction bridge raises `ConcurrentModificationError` only when nothing of the transaction has committed (it comes from `TransactionCoordinator.refreshBetweenAttempts` replaying the transaction's actions), which is the condition "What is never retried" under Control-write retry requires.
