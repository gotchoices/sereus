----
description: Adding or removing a party member only updates the security check that admits that member's traffic if the code doing the write remembers to say "membership changed" — and it is easy to forget, which briefly locks a brand-new member out. Make that update fire automatically from the write itself.
prereq:
files:
  - packages/cadre-core/src/control-database.ts (new membership-change listener + `mutateCadrePeer` seam; `inTransaction` ~L875 for reference)
  - packages/cadre-core/src/seed-bootstrap.ts (`insertCadrePeerRow` ~L352, `removePeer` ~L524, `reauthorizePeer` ~L596 — the three `CadrePeer` row mutators)
  - packages/cadre-core/src/cadre-node.ts (`authorizedControlPeers` ~L238, `authorizeInboundControlStream` ~L1114, `refreshAuthorizedControlPeers` ~L1142, `start` ~L549/L628, `publishSelfRecord` ~L1297, `drainPendingPeerWrites` ~L2129, `seedEventCallbacks` ~L3643, `refreshMembershipGate` ~L3673, wrappers L3684–L3892)
  - packages/cadre-core/test/control-stream-authorization.spec.ts (existing gate suites)
  - packages/cadre-core/test/membership-gate-helpers.ts (`inject` builds the fake control DB — needs the new methods)
  - packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (L223-224 explicit `refreshMembershipGate()` after a below-the-wrapper write — should become unnecessary)
difficulty: medium
----

# Make the membership-gate refresh fire from the write, not from the caller

## Background (for a reader with no context)

Each node keeps an **in-memory list of the peers it currently believes are approved members**
(`CadreNode.authorizedControlPeers`). A fail-closed check
(`CadreNode.authorizeInboundControlStream`) consults that list on every inbound
control-database stream. The check must be synchronous: answering it with a database read
would pull blocks over the very protocols it gates, deadlocking into mutual denial. So the
list is a *snapshot*, rebuilt out of band.

Today the rebuild is bolted onto each of seven `CadreNode` methods plus a ~15 s timer. Any
code that writes a member row without going through one of those methods leaves the snapshot
stale, and the node denies the traffic of the member it just approved for up to ~15 s — long
enough to kill that member's database startup. This has already been missed twice (an
integration-test helper; `CadreNode.addPhoneWithRelay`).

## Design

**Route the notification through `ControlDatabase`, not through the service's event callbacks.**

Every writer of a `CadrePeer` row — the node's own persistent `SeedBootstrapService`, the
throwaway temp services `CadreNode.applySeed` / `dialInvite` build, and services constructed
*outside* `CadreNode` entirely (integration tests do this: `push-wake-e2e.integration.ts:547`
builds its own service and initializes it with `Rx.getControlDatabase()!`) — necessarily holds
the target node's single `ControlDatabase` instance. It is the one object on the write path
that cannot be bypassed, which the service's `SeedEventCallbacks` channel is not (the temp and
externally-built services never get callbacks wired). So the hub goes on `ControlDatabase`.

The SQL and the owner signing stay in `SeedBootstrapService`. Moving them into
`ControlDatabase` was considered and rejected: `CadrePeer` uses its own digest construction
(`cadrePeerVoucherDigest` / `cadrePeerRemoveDigest`), so it cannot reuse the existing
`deleteGuardedRow` helper — the move would be pure churn across a security-sensitive
delete+tombstone transaction for no extra guarantee. Instead the writers wrap their execs in a
single named seam, `mutateCadrePeer`, so "if you write a `CadrePeer` row, you go through
`mutateCadrePeer`" is one greppable rule instead of seven.

### `ControlDatabase` — the hub

```ts
/** Notified after any `CadrePeer` row write commits; `reason` only labels the log line. */
export type MembershipChangeListener = (reason: string) => Promise<void>;

class ControlDatabase {
  private membershipListener: MembershipChangeListener | null = null;

  /** Wired once by `CadreNode.start()`; cleared on teardown. At most one listener (a
   *  ControlDatabase belongs to exactly one CadreNode). */
  setMembershipChangeListener(listener: MembershipChangeListener | null): void;

  /**
   * Run a `CadrePeer` row mutation and notify the listener once it has COMMITTED.
   * Every `CadrePeer` writer goes through here — that is what makes the gate refresh
   * automatic rather than a caller obligation. `body` owns its own transaction if it
   * needs one (commit inside `body`), so the notification never reads uncommitted state.
   * A throwing `body` propagates and does NOT notify: nothing changed.
   */
  async mutateCadrePeer<T>(reason: string, body: () => Promise<T>): Promise<T> {
    this.ensureInitialized();
    const result = await body();
    await this.notifyMembershipChanged(reason);
    return result;
  }

  /** Best-effort: a listener that throws is logged and swallowed — a committed write
   *  must never fail because a snapshot refresh did. */
  private async notifyMembershipChanged(reason: string): Promise<void>;
}
```

### `SeedBootstrapService` — the three mutators

Wrap the existing bodies; do not restructure them.

- `insertCadrePeerRow` (`authorizePeer`, `insertSelfPeerRecord`, and via `authorizePeer`:
  `addDrone`, `acceptPhone`, `addPhoneWithRelay`) → `mutateCadrePeer('peer-insert', …)`.
- `removePeer` — the delete + `Revocation` tombstone transaction moves *inside* the body, so
  the notify lands strictly after `commit()`.
- `reauthorizePeer` — an UPDATE, but it rewrites `VouchOwner`/`VouchSig`, which the
  authorized-membership predicate judges on, so it can change the set. Include it; that keeps
  the rule uniform ("every `CadrePeer` mutator notifies") rather than a three-way exception
  the next reader has to relearn.

`ControlDatabase.updateSelfPeerRecord` deliberately does **not** notify: it only ever touches
this node's own row, and `listAuthorizedMembers` filters self out, so it can never change the
snapshot — and it runs on the periodic self-registration refresh, where a notify would add a
recurring read for nothing. Say so in a comment at that method. **Verify before relying on
it**: confirm `updateSelfPeerRecord` has no non-self caller (`cadre-node.ts:1287` is the only
one found).

### `CadreNode` — coalescing refresh

`refreshMembershipGate()` stays public (no API break) and becomes the single coalescing entry
point. `refreshAuthorizedControlPeers` (the actual read) ends up with exactly ONE call site:
the drain below.

```ts
private membershipGateDirty = false;
private membershipGateDrain: Promise<void> | null = null;
private membershipGateDeferDepth = 0;

/**
 * Mark the snapshot stale and resolve once a refresh that STARTED AFTER this call has
 * completed — so `await node.authorizePeer(x)` still returns with x admitted, exactly as
 * the old per-wrapper refresh guaranteed. Never rejects.
 */
async refreshMembershipGate(reason = 'external-write'): Promise<void> {
  this.membershipGateDirty = true;
  if (this.membershipGateDeferDepth > 0) {
    return;                                   // flushed once when the scope exits
  }
  while (this.membershipGateDirty) {
    this.membershipGateDrain ??= this.drainMembershipGate(reason);
    await this.membershipGateDrain;           // re-check: the drain may have exited
  }                                           // between our set and its last check
}

private async drainMembershipGate(reason: string): Promise<void> {
  try {
    while (this.membershipGateDirty) {
      this.membershipGateDirty = false;
      await this.refreshAuthorizedControlPeers(reason);
    }
  } finally {
    this.membershipGateDrain = null;
  }
}

/** Collapse a burst of membership writes into ONE refresh at scope exit. */
private async deferMembershipGateRefresh<T>(reason: string, body: () => Promise<T>): Promise<T> {
  this.membershipGateDeferDepth++;
  try {
    return await body();
  } finally {
    this.membershipGateDeferDepth--;
    if (this.membershipGateDeferDepth === 0 && this.membershipGateDirty) {
      await this.refreshMembershipGate(reason);
    }
  }
}
```

Single-flight also closes the existing `refreshAuthorizedControlPeers` NOTE (two concurrent
refreshes settling last-completion-wins rather than last-read-wins) — delete that NOTE and say
so in the handoff.

**Wiring / call-site changes:**

- `start()`: after `controlDatabase.initialize()`, `setMembershipChangeListener((reason) =>
  this.refreshMembershipGate(reason))`. Teardown (`cleanup()` / wherever `controlDatabase` is
  nulled, ~L2572) clears it to `null` first.
- **Delete** the explicit refresh in: `authorizePeer`, `removePeer`, `addDrone`, `acceptPhone`,
  `addPhoneWithRelay`, `publishSelfRecord` (`'self-insert'`), and `drainPendingPeerWrites`
  (`'drain-reissue'`) — all now automatic. Wrap the drain's loop in
  `deferMembershipGateRefresh('drain-reissue', …)` so N re-issues stay one refresh, which is
  what that call site's comment already promises.
- **Keep** (retarget to `refreshMembershipGate(reason)`): `start` (`void`-ed, non-blocking),
  `reconcileControlCohort`, both `applySeed` sites, and `seedEventCallbacks.onSeedApplied`.
  These are NOT row writes — `SeedBootstrapService.applySeed` writes no `CadrePeer` rows at all
  (it merges the libp2p peer store and dials owners); rows arrive by replication, and applying
  a seed can also anchor a new owner key, which flips already-present rows from unauthorized to
  authorized. The automatic path cannot see either, so these stay.
- `refreshMembershipGate`'s doc comment and the `docs/architecture.md` paragraph describing the
  caller obligation both need rewriting: the escape hatch now exists for *replication-* and
  *anchor-*driven changes, not for "you wrote a row and must remember".
- `push-wake-e2e.integration.ts:223-224` — the explicit `refreshMembershipGate()` after the
  below-the-wrapper `insertSelfPeerRecord` becomes redundant. Remove it (and its
  now-stale L201 comment) as the proof the automatic path works end-to-end.

## Edge cases & interactions

- **Write inside an outer transaction.** No current caller wraps `insertCadrePeerRow` in an
  outer transaction, and Quereus' `Database` exposes no public "am I in a transaction?" probe,
  so `mutateCadrePeer` cannot assert it. Its contract is "body commits before it returns".
  Leave a `NOTE:` at `mutateCadrePeer` — a future caller that opens a transaction *around* a
  `CadrePeer` write must move the `mutateCadrePeer` wrapper out to enclose that commit, or the
  refresh reads pre-commit state.
- **Failed write must not refresh.** `removePeer`'s rollback path throws out of `body`;
  assert no notification fires.
- **Failed refresh must not fail the write.** A listener that rejects (or a control-DB read
  that blows up inside it) is swallowed and logged; `authorizePeer` still resolves and the
  previous snapshot survives (never cleared — that would reopen the cold-start admit-all).
- **Node not running / no control DB.** `refreshAuthorizedControlPeers` already early-returns;
  the drain then clears `dirty` without a read and every awaiter resolves. A write through an
  externally-built service before `start()` completes is covered by `start()`'s own refresh.
- **Concurrent writers.** Two `authorizePeer` calls in flight share one drain, and *both* must
  observe their own peer admitted on return (the outer `while` re-check is what guarantees
  this — do not simplify it to a single `await`).
- **Drain-scope reentrancy.** A `refreshMembershipGate()` call *inside* a
  `deferMembershipGateRefresh` scope returns without refreshing (flushed at scope exit). Only
  `drainPendingPeerWrites` opens a scope, and it needs no fresh snapshot mid-loop. Document it
  on the helper.
- **Teardown race.** A notification landing after `setMembershipChangeListener(null)` is a
  no-op; a refresh already in flight when the DB is nulled resolves via the not-running guard.
- **`registerSelf` insert.** Self is filtered out of the authorized set, so the automatic
  refresh there changes nothing — but it must still not regress the cold-start carve-out
  (`snapshot.size === 0` ⇒ admit all). Cover it.
- **Unit-test fake control DB.** `membership-gate-helpers.ts:inject` builds a bare object with
  `queryCadrePeers`/`queryRevokedStamps`. It now needs `setMembershipChangeListener` and
  `mutateCadrePeer` (a pass-through that invokes the stored listener) or the new paths cannot
  be exercised — and any node path that calls `setMembershipChangeListener` on it will throw
  today.

## Tests

Extend `packages/cadre-core/test/control-stream-authorization.spec.ts` (and
`membership-gate-helpers.ts`); add `ControlDatabase`-level cases wherever that class's unit
suite lives.

- A `CadrePeer` insert through a service built *outside* `CadreNode` — the historically-missed
  shape — admits the new peer with **no** `refreshMembershipGate()` call. Expected: gate flips
  false → true across the write alone.
- A `removePeer` drops the peer from the snapshot on return; the notify fires **after** commit
  (assert ordering, e.g. the listener observes the row already gone).
- A rolled-back / throwing `removePeer` fires no notification and leaves the snapshot intact.
- A listener that rejects does not make `authorizePeer` reject, and the snapshot keeps its
  previous contents.
- Coalescing: N concurrent writes ⇒ strictly fewer than N `queryCadrePeers` calls (count the
  spy), and every writer's promise resolves with its own peer already in the snapshot.
- `deferMembershipGateRefresh`: a drain of N re-issues performs exactly one refresh.
- Existing `refreshMembershipGate` suite keeps passing — it stays public and idempotent.
- Regression guard for the original symptom lives in the integration layer: with L223-224
  removed, `push-wake-e2e.integration.ts` must still pass.

## Out of scope

The ~15 s reconcile timer and the deliberate bounded staleness for replication-delivered
changes (unchanged, by design). Notifying on trusted-owner-anchor changes — an anchor write can
flip existing rows into the authorized set, and today only the `applySeed` / `onSeedApplied`
refresh covers that. If a path ever mutates the anchor outside seed application, that becomes
real work; record it as a `NOTE:` at `TrustedOwnerStore.trust`'s caller rather than a ticket.

## TODO

Phase 1 — hub + writers
- Add `MembershipChangeListener`, `setMembershipChangeListener`, private
  `notifyMembershipChanged`, and `mutateCadrePeer` to `ControlDatabase`; export the type from
  `src/index.ts` alongside the other control-DB types.
- Wrap `insertCadrePeerRow`, `removePeer` (transaction inside the body), and `reauthorizePeer`
  in `mutateCadrePeer`. Add the "why not `updateSelfPeerRecord`" comment.
- Add the transaction-boundary `NOTE:` to `mutateCadrePeer`.

Phase 2 — coalescing refresh in `CadreNode`
- Add the three fields, rewrite `refreshMembershipGate` as the coalescing entry, add
  `drainMembershipGate` + `deferMembershipGateRefresh`.
- Wire/unwire the listener in `start()` / teardown.
- Delete the seven redundant explicit refreshes; retarget the surviving five to
  `refreshMembershipGate(reason)`; wrap the write-drain loop in the defer scope.
- Delete the now-obsolete last-completion-wins `NOTE:` on `refreshAuthorizedControlPeers`.

Phase 3 — docs + tests
- Rewrite `refreshMembershipGate`'s doc comment and the matching paragraph in
  `docs/architecture.md` (search for the membership-gate caller-obligation wording).
- Teach `membership-gate-helpers.ts:inject` the two new control-DB methods.
- Write the test list above.
- Drop the now-redundant `refreshMembershipGate()` + comment at
  `push-wake-e2e.integration.ts:201-224`.

Phase 4 — validate
- `yarn workspace @serfab/cadre-core build && yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log`
- `yarn lint`
- Run the `push-wake-e2e` and `control-stream-authz` integration scenarios if they fit the
  runner's 10-minute idle window; otherwise document the deferral in the review handoff.
