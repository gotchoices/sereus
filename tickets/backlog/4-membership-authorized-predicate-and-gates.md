----
description: Make "is this peer a real member?" mean "an authority my node actually trusts vouched for them" instead of "they published an address." This closes the hole where an outsider can wake a sleeping node just by publishing its own address record.
prereq: membership-node-local-authority-anchor, membership-cadrepeer-authority-antireplay
files:
  - packages/cadre-core/src/cadre-node.ts (listAuthorizedMembers/isAuthorizedMember from ticket 1)
  - packages/cadre-core/src/peer-authorization.ts (verifyPeerAuthorization — verify VouchSig)
  - packages/cadre-core/src/control-database.ts (queryCadrePeers-with-voucher from ticket 2)
  - packages/cadre-core/src/strand-wake-protocol.ts (wake gate) / strand-addr-protocol.ts (addr gate)
  - packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (scenario 3 non-member L450-488; scenario 4 replication-backed L532+)
  - packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (L155-183)
  - packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts
  - packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts
difficulty: hard
----

# Enforce authorized membership against the node-local anchor

Step 4 — the step that actually closes the security hole. With the voucher persisted
(ticket 2) and the node-local anchor built + seeded (ticket 3), turn
`isAuthorizedMember` from "has a row minus self" (ticket 1's placeholder) into the real
predicate.

## The predicate

`isAuthorizedMember(peerId)` is true iff ALL hold:

1. `peerId` is not this node's own `peerId` (self exclusion, from ticket 1).
2. A `CadrePeer` row exists for `peerId` with a non-null voucher (`VouchAuthority`,
   `VouchSig`).
3. `VouchAuthority` is in the **node-local anchor** (`TrustedAuthorityStore.has(...)`)
   — NOT in the replicated `AuthorityKey` table.
4. `verifyPeerAuthorization(peerId, VouchAuthority, VouchSig)` is true (the named
   authority really vouched this peerId).

Fail-closed: a null voucher, an unanchored `VouchAuthority`, or a bad signature → not
authorized. `listAuthorizedMembers()` becomes the filtered list; `isAuthorizedMember`
consults it (or checks a single row directly for efficiency — note the choice).

The wake gate and strand-addr gate were already repointed to `isAuthorizedMember` in
ticket 1, so they inherit the real check with no further wiring. Address resolution
(`resolvePeerAddrs`) and push fan-out stay on the ADDRESSABLE surface — unchanged.

## Test rework — model real enrollment

The predicate change means "a reader trusts an authority it never pinned" is no longer
true, which is exactly the leak we are closing. Several cross-node scenarios currently
assert a reader's `isMember`/wake passes off a *replicated* authority it never pinned;
those must be reworked so the reader's node-local anchor actually pins the writing
authority (the real enrollment story):

- **push-wake-e2e scenario 3 (non-member O):** now GREEN — O's self-minted
  `VouchAuthority` is not in Rx's anchor → `isAuthorizedMember(O)` false → wake rejected,
  strand stays hibernating. This is the acceptance case; keep the assertion as-is.
- **push-wake-e2e scenario 4 (replication-backed):** the receiver Rx and sender S must
  pin authority A's key in their local anchor (they were "enrolled by A"), so
  `isAuthorizedMember(S)` passes off A's voucher. Add the anchor-pin to the setup.
- **control-db-two-node-convergence / control-cohort-auto-convergence /
  control-write-while-alone-convergence:** wherever they assert cross-node authorized
  membership, pin the writing authority on the reader. Where they only assert the
  *addressable* `isMember` (row presence), they can stay on the addressable surface
  untouched — decide per assertion and comment.

## Edge cases & interactions

- **Legit member, un-synced voucher.** If the row replicated but with a null voucher
  (older write), fail-closed → not authorized. Ensure ticket 2's writes always populate
  the voucher so legit rows are never null; add a converge-then-assert test.
- **Anchor empty (cold start).** `isAuthorizedMember` is false for everyone → a
  not-yet-enrolled node authorizes no one. Correct and intended.
- **Self-authored legit row.** A node's own `registerSelf` row is vouched by the party
  authority (host writes it) — but self is excluded anyway (rule 1), so this never
  matters for self. For a *sibling* whose row the party authority vouched, rule 3 passes.
- **Rotation.** If an authority rotates and the new key is pinned via a fresh invite,
  old-vouched rows may fail rule 3 until re-vouched — note as a tripwire; full rotation
  handling is `flip-strand-membership-rotation-known-gap` territory, not this ticket.
- **Two gates, one predicate.** Confirm BOTH `strand-wake-protocol` and
  `strand-addr-protocol` now reject an unanchored peer (add/extend the strand-addr
  non-member case to match the wake one).

## Acceptance (the whole chain's target)

- Fresh party reports no authorized members; `isAuthorizedMember(randomFreshPeer)` false.
- A wake from a peer never vouched by an authority in our anchor is rejected
  (`accepted:false`) and the strand stays `hibernating`, **even if that peer has a
  `CadrePeer` address row.**
- Push fan-out + `resolvePeerAddrs` unchanged for legitimately addressable peers
  (including self).
- Full integration suite green (the two membership-gate scenarios were the gap).

## TODO

- Implement the 4-condition `isAuthorizedMember` / `listAuthorizedMembers` against the
  anchor + voucher; fail-closed.
- Rework the cross-node scenarios to pin the writing authority on the reader; keep
  addressable-only assertions on the addressable surface.
- Extend strand-addr non-member coverage to mirror the wake non-member case.
- Add a tripwire comment for authority rotation at the predicate site.
- `yarn lint` / `yarn typecheck` / full cadre-core + integration suites green
  (stream long runs with `tee`; if a scenario is not agent-runnable in the idle window,
  document the deferral per tess rules).
