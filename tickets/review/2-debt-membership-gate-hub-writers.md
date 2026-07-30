description: Adding or removing a party member only updates the security check that admits that member's traffic if the code doing the write remembers to say "membership changed". This first half added the single notification point every member-row write now passes through, so the reminder can no longer be forgotten.
prereq:
files:
  - packages/cadre-core/src/control-database.ts (`membershipListener` field L231; `setMembershipChangeListener` / `mutateCadrePeer` / `notifyMembershipChanged` L901-960, right after `inTransaction`; `updateSelfPeerRecord` carve-out comment ~L602)
  - packages/cadre-core/src/seed-bootstrap.ts (`insertCadrePeerRow` ~L352, `removePeer` ~L524, `reauthorizePeer` ~L596 — all three now wrapped)
  - packages/cadre-core/src/index.ts (L11 re-export now includes `type MembershipChangeListener`)
difficulty: medium
----

# Review: the membership-change hub on `ControlDatabase` + its three writers

Phase 1 of 2. **This change is inert by design**: it adds a notification seam with no
listener attached anywhere, so runtime behaviour is identical to before. Phase 2
(`debt-membership-gate-coalescing-refresh`) attaches `CadreNode` to the seam and is where
the user-visible fix lands.

## What the problem was (no prior context needed)

Each node holds an in-memory list of the peers it believes are approved party members
(`CadreNode.authorizedControlPeers`). A fail-closed check
(`CadreNode.authorizeInboundControlStream`) consults that list on every inbound
control-database stream. The check must be synchronous — answering it with a database read
would pull blocks over the very protocols it gates, deadlocking into mutual denial — so the
list is a snapshot rebuilt out of band.

Before this change the rebuild was bolted onto seven `CadreNode` methods plus a ~15 s
timer. Code that wrote a member row without going through one of those methods left the
snapshot stale, and the node denied the traffic of the member it had just approved for up
to ~15 s — long enough to kill that member's database startup. Missed twice already (an
integration-test helper; `CadreNode.addPhoneWithRelay`).

## What landed

### `ControlDatabase` — the hub (src/control-database.ts)

Grouped immediately after `inTransaction`, the other write-plumbing helper:

- `private membershipListener: MembershipChangeListener | null = null` (field, L231).
- `setMembershipChangeListener(listener | null)` — public, single-slot (a second call
  replaces, never fans out, so a torn-down node cannot keep receiving notifications).
- `async mutateCadrePeer<T>(reason, body): Promise<T>` — `ensureInitialized()`, run `body`,
  notify, return `body`'s result. A throwing `body` propagates and does **not** notify.
- `private async notifyMembershipChanged(reason)` — no-op when the listener is null;
  a throwing listener is logged and swallowed.

`MembershipChangeListener` (`(reason: string) => Promise<void>`) was already in the file
from the prior run; it is now re-exported from `src/index.ts` L11.

`mutateCadrePeer` carries a `NOTE:` on its transaction-boundary contract: `body` must commit
before returning, and the wrapper **cannot enforce that** — Quereus' `Database` exposes no
public "am I in a transaction?" probe. A future caller that opens a transaction *around* a
`CadrePeer` write must move the wrapper out to enclose that outer commit.

`updateSelfPeerRecord` is the one deliberate non-notifier; the "why" is a comment on the
method (self-only row, filtered out of the snapshot by `listAuthorizedMembers`, and it runs
on a periodic refresh where a notify would be a recurring read for nothing).

### `SeedBootstrapService` — the three writers (src/seed-bootstrap.ts)

Bodies wrapped, not restructured:

- `insertCadrePeerRow` → `mutateCadrePeer('peer-insert', …)`. Signing and stamp minting stay
  *outside* the wrapper (they can fail before anything is written); only the `exec` is inside.
- `removePeer` → `mutateCadrePeer('peer-remove', …)` with the whole
  `beginTransaction` / delete / `Revocation` insert / `commit` block **and** its rollback
  `catch` moved inside the body, so the notify lands strictly after `commit()`.
- `reauthorizePeer` → `mutateCadrePeer('peer-reauthorize', …)`. It is an UPDATE, but it
  rewrites `VouchOwner`/`VouchSig`, which the authorized-membership predicate judges on, so
  it can change the set.

Confirmed by grep that these three plus `updateSelfPeerRecord` are the only `CadrePeer` row
mutators in `src/` repo-wide.

## Validation performed

- `yarn workspace @serfab/cadre-core build` — clean, exit 0.
- `yarn workspace @serfab/cadre-core test` — **69 files, 1057 passed, 1 skipped, exit 0**
  (the 1 skip is pre-existing, untouched by this diff).
- `yarn lint` — clean, exit 0.

## Use cases to probe during review

**The intended write→notify paths** (each should reach `mutateCadrePeer` exactly once per
row write, and phase 2 will hang the real refresh off them):

- Owner authorizes a drone → `addDrone` → `authorizePeer` → `insertCadrePeerRow`.
- Owner accepts a phone → `acceptPhone` / `addPhoneWithRelay` → `authorizePeer` → same.
- Node registers itself → `registerSelf` → `insertSelfPeerRecord` → same. (Self-insert
  notifies; only the *update* path is carved out. Harmless — a self notify is one wasted
  membership read at startup — but worth a reviewer's eye on whether the asymmetry between
  `insertSelfPeerRecord` (notifies) and `updateSelfPeerRecord` (does not) reads as
  deliberate.)
- Owner removes a peer → `removePeer` → notify after `commit()`.
- Write-while-alone re-replication drain → `reauthorizePeer` → notify.

**Failure paths that must NOT notify:**

- `removePeer` / `reauthorizePeer` on an absent row: both early-`return` *before* reaching
  `mutateCadrePeer`, so no notify — correct (nothing changed) but verify the early returns
  are still ahead of the wrapper after the edit.
- A constraint rejection inside the body (bad signature, retired stamp) throws out of the
  body → no notify.
- `removePeer` whose transaction rolls back → the `catch` rethrows from inside the body → no
  notify.

**No-listener operation** (the whole reason this phase is safe to land alone):
`test/seed-bootstrap.spec.ts` drives the real service against a real control DB with no
listener attached, and `test/control-authorization-domain-separation.spec.ts` /
`test/control-revocation-replay.spec.ts` write `CadrePeer` rows with raw SQL against a bare
`Database`, bypassing the seam entirely. All pass.

## Known gaps / things a reviewer should push on

- **Nothing exercises the seam.** There is no test that a committed `CadrePeer` write fires
  the listener, that a throwing listener is swallowed, or that a rolled-back `removePeer`
  does not fire. Deliberate: the natural home for those assertions is phase 2, whose
  `CadreNode` wiring and unit-test fake (`test/membership-gate-helpers.ts`) provide a
  listener to observe. If the reviewer would rather see them now, they are cheap — a stub
  listener on a real `ControlDatabase` plus the existing `seed-bootstrap.spec.ts` scaffolding.
  This is the single largest hole in this phase.
- **The rule is greppable, not enforced.** "If you write a `CadrePeer` row, you go through
  `mutateCadrePeer`" is a convention held up by one grep, not by types or by making the
  writers private. A reviewer may reasonably ask for a stronger mechanism (e.g. moving the
  SQL behind a `ControlDatabase` method so there is no `getDatabase()` path to the table).
  Considered and rejected in planning as churn — `CadrePeer` uses its own digest
  construction (`cadrePeerVoucherDigest` / `cadrePeerRemoveDigest`) so it cannot reuse the
  existing `deleteGuardedRow` helper — but the tradeoff is worth re-examining, not assumed.
- **The transaction-boundary `NOTE:` is unverifiable today.** Documented, not asserted; see
  the `NOTE:` in `mutateCadrePeer`. Parked as a code comment (a tripwire, not a ticket): it
  is only wrong once some future caller opens an outer transaction around a `CadrePeer` write,
  and no such caller exists.
- **`reauthorizePeer` notifying is a judgement call**, not a necessity — in practice the
  write-while-alone drain re-touches only rows this node itself vouched, so the voucher is
  rewritten to the same key and the member set does not change. Wrapped anyway for a uniform
  rule. If phase 2's refresh turns out to be expensive, this is the first candidate to drop.
