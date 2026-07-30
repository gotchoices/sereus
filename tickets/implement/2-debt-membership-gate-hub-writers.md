description: Adding or removing a party member only updates the security check that admits that member's traffic if the code doing the write remembers to say "membership changed". This first half builds the single notification point every member-row write must pass through, so the reminder can never be forgotten.
prereq:
files:
  - packages/cadre-core/src/control-database.ts (`MembershipChangeListener` type ALREADY ADDED just above `ControlDatabaseConfig` ~L196; add the listener field + 3 methods; `inTransaction` ~L888 is the neighbouring write-plumbing helper; `updateSelfPeerRecord` ~L603; `ensureInitialized` ~L1290)
  - packages/cadre-core/src/seed-bootstrap.ts (`insertCadrePeerRow` ~L352, `removePeer` ~L524, `reauthorizePeer` ~L596 — the only three `CadrePeer` row mutators in the repo)
  - packages/cadre-core/src/index.ts (L11 already exports the control-DB types; add `type MembershipChangeListener`)
difficulty: medium
----

# Phase 1 of 2: the membership-change hub on `ControlDatabase`, and the three writers that go through it

Split out of `debt-membership-gate-refresh-unskippable` when its run hit the token
budget. Phase 2 (`debt-membership-gate-coalescing-refresh`) wires `CadreNode` to the hub
and is where the user-visible behaviour change lands. **This ticket alone is inert**: it
adds a notification seam with no listener attached, so behaviour is unchanged and build +
tests must stay green.

## Background (for a reader with no context)

Each node keeps an **in-memory list of the peers it currently believes are approved
members** (`CadreNode.authorizedControlPeers`). A fail-closed check
(`CadreNode.authorizeInboundControlStream`) consults that list on every inbound
control-database stream. The check must be synchronous: answering it with a database read
would pull blocks over the very protocols it gates, deadlocking into mutual denial. So the
list is a *snapshot*, rebuilt out of band.

Today the rebuild is bolted onto each of seven `CadreNode` methods plus a ~15 s timer. Any
code that writes a member row without going through one of those methods leaves the
snapshot stale, and the node denies the traffic of the member it just approved for up to
~15 s — long enough to kill that member's database startup. This has already been missed
twice (an integration-test helper; `CadreNode.addPhoneWithRelay`).

## Design

**Route the notification through `ControlDatabase`, not through the service's event
callbacks.**

Every writer of a `CadrePeer` row — the node's own persistent `SeedBootstrapService`, the
throwaway temp services `CadreNode.applySeed` / `dialInvite` build, and services
constructed *outside* `CadreNode` entirely (integration tests do this:
`push-wake-e2e.integration.ts:547` builds its own service and initializes it with
`Rx.getControlDatabase()!`) — necessarily holds the target node's single `ControlDatabase`
instance. It is the one object on the write path that cannot be bypassed, which the
service's `SeedEventCallbacks` channel is not (the temp and externally-built services never
get callbacks wired). So the hub goes on `ControlDatabase`.

The SQL and the owner signing stay in `SeedBootstrapService`. Moving them into
`ControlDatabase` was considered and rejected: `CadrePeer` uses its own digest construction
(`cadrePeerVoucherDigest` / `cadrePeerRemoveDigest`), so it cannot reuse the existing
`deleteGuardedRow` helper — the move would be pure churn across a security-sensitive
delete+tombstone transaction for no extra guarantee. Instead the writers wrap their execs
in a single named seam, `mutateCadrePeer`, so "if you write a `CadrePeer` row, you go
through `mutateCadrePeer`" is one greppable rule instead of seven.

### `ControlDatabase` — the hub

The `MembershipChangeListener` type is **already in the file** (added before the budget
cut); the rest is new:

```ts
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

`mutateCadrePeer` needs a `NOTE:` on the transaction boundary. No current caller wraps
`insertCadrePeerRow` in an outer transaction, and Quereus' `Database` exposes no public
"am I in a transaction?" probe, so the wrapper cannot assert its own contract ("body commits
before it returns"). A future caller that opens a transaction *around* a `CadrePeer` write
must move the `mutateCadrePeer` wrapper out to enclose that commit, or the refresh reads
pre-commit state.

### `SeedBootstrapService` — the three mutators

Wrap the existing bodies; do not restructure them.

- `insertCadrePeerRow` (reached by `authorizePeer`, `insertSelfPeerRecord`, and via
  `authorizePeer`: `addDrone`, `acceptPhone`, `addPhoneWithRelay`) →
  `mutateCadrePeer('peer-insert', …)`.
- `removePeer` — the existing `beginTransaction` / delete / `Revocation` insert / `commit`
  block (and its rollback `catch`) moves *inside* the body, so the notify lands strictly
  after `commit()` and a rollback throws out of the body without notifying.
- `reauthorizePeer` — an UPDATE, but it rewrites `VouchOwner`/`VouchSig`, which the
  authorized-membership predicate judges on, so it can change the set. Include it; that
  keeps the rule uniform ("every `CadrePeer` mutator notifies") rather than a three-way
  exception the next reader has to relearn.

`ControlDatabase.updateSelfPeerRecord` deliberately does **not** notify: it only ever
touches this node's own row, and `CadreNode.listAuthorizedMembers` filters self out, so it
can never change the snapshot — and it runs on the periodic self-registration refresh,
where a notify would add a recurring read for nothing. Add that as a comment at the method.
**Already verified during the prior run**: `cadre-node.ts:1287` (inside `publishSelfRecord`)
is the sole caller and it is self-only, so the carve-out is sound.

## Callers that must keep working unchanged

- `packages/cadre-core/test/seed-bootstrap.spec.ts` drives the real service against a real
  control DB with no listener attached — `notifyMembershipChanged` must be a silent no-op
  when `membershipListener` is null.
- The fake `ControlDatabase` objects in `test/ed25519-key.spec.ts:89` and
  `test/invite-address-push.spec.ts:31` never write a `CadrePeer` row, so they need no new
  methods. (The unit-test fake in `test/membership-gate-helpers.ts` DOES need them — that
  is phase 2's job, along with the `CadreNode` wiring that exercises it.)

## TODO

- Add the listener field, `setMembershipChangeListener`, private `notifyMembershipChanged`,
  and `mutateCadrePeer` to `ControlDatabase` (group them next to `inTransaction`, the other
  write-plumbing helper). Add the transaction-boundary `NOTE:` to `mutateCadrePeer`.
- Export `type MembershipChangeListener` from `src/index.ts` alongside the other control-DB
  types (extend the existing L11 re-export).
- Wrap `insertCadrePeerRow`, `removePeer` (transaction inside the body), and
  `reauthorizePeer` in `mutateCadrePeer`.
- Add the "why not `updateSelfPeerRecord`" comment.
- Validate: `yarn workspace @serfab/cadre-core build && yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log`, then `yarn lint`.
