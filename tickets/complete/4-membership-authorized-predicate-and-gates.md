----
description: A device now counts as a real party member only when an owner key this node trusts from an out-of-band pin vouched for it with a valid signature — so a stranger who merely publishes rows into the shared database can no longer wake a sleeping node or ask it for its live strand addresses.
files:
  - packages/cadre-core/src/peer-authorization.ts (verifyCadrePeerVoucher)
  - packages/cadre-core/src/cadre-node.ts (listAuthorizedMembers / hasAnchoredVoucher / isAuthorizedMember)
  - packages/cadre-core/src/types.ts (CadrePeerRow / CadrePeerVoucherFields — added in review)
  - packages/cadre-core/src/control-database.ts (queryCadrePeers returns the named row type)
  - packages/cadre-core/src/seed-bootstrap.ts (reauthorizePeer NOTE refreshed in review)
  - packages/cadre-core/src/strand-wake-protocol.ts, strand-addr-protocol.ts (authorization doc comments)
  - packages/cadre-core/test/cadre-node-authorized-surface.spec.ts (11 predicate tests, real ed25519)
  - packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (scenarios 3 + 4)
  - packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts
  - docs/architecture.md, docs/STATUS.md
----

# Complete: authorized membership enforced against the node-local anchor

Step 4 of the six-step membership chain. Closes the hole where an outsider could
wake a sleeping node — or harvest its live strand addresses — simply by writing
its own rows into the replicated control database.

## What shipped

**The predicate.** `CadreNode.listAuthorizedMembers` (and `isAuthorizedMember`,
which reuses it) admits a `CadrePeer` row only when all four hold: it is not this
node itself; the row carries a complete voucher (`StampId` / `VouchOwner` /
`VouchSig`); `VouchOwner` is in the node-local, non-replicated
`TrustedOwnerStore`; and `VouchSig` verifies as that owner's signature over
`digest(PeerId, StampId)`. Fail-closed on every missing piece — including a null
anchor (pre-start) and an empty anchor (an un-enrolled node authorizes no one).
Row-level checks live in one private helper, `hasAnchoredVoucher`.

**The read-side verifier.** `verifyCadrePeerVoucher` in `peer-authorization.ts`,
the exact mirror of the voucher `insertCadrePeerRow` writes — it signs the
voucher digest (peer id bound to the row's single-use nonce), not the bare
`peerAuthorizationDigest`. Never throws; malformed input is `false`.

**The gates.** No wiring change was needed: the push-wake and strand-address
receivers were already pointed at `isAuthorizedMember` by chain step 1, so both
inherited the real check. Address resolution, push fan-out and `listMembers` /
`isMember` deliberately stay on the addressable surface — dialability is not
trust.

## Review findings

Ran the implement diff cold before the handoff summary, then read every file it
touched plus the write paths it depends on (`seed-bootstrap.ts` insert /
re-touch / remove, `control-database.ts` self-update, the two protocol
receivers, the host and CLI membership consumers).

**Adversarial pass on the predicate — no bypass found.** Checked, and each fails
closed: a voucher transplanted from another peer's row (the digest binds
`PeerId`); a signature over a different `StampId`; a signature by a key other
than the claimed `VouchOwner`; a self-minted owner key genesis-inserted into the
replicated `OwnerKey` table (never reaches the node-local anchor); empty-string
rather than null voucher columns (an empty `VouchOwner` is not in any anchor, an
empty signature does not verify). Confirmed the peer self-update path
(`updateSelfPeerRecord`) does not touch `StampId` / `VouchOwner` / `VouchSig`, so
an address refresh cannot invalidate a legitimate member's voucher. Confirmed a
predicate throw during shutdown (control DB nulled while the protocol handler is
still registered) is caught by both receivers and answered as a rejection, not a
hang. The one residual — replaying a captured authorized insert after a delete
frees the nonce — was already documented at the insert site and is subsumed by
the queued connection-gater work.

**Production enrollment actually supplies the anchor pins** (the thing that would
have made this a silent functional regression). Verified all three paths: the
phone pins `CadreInvite.ownerKeys` via `trustOwnerKeys(..., 'invite')`; a
donated/CLI node receives `CADRE_OWNER_KEYS` (host orchestrator) or
`--pin-owner-key`, which `cadre-cli start` feeds into `trustedOwners.pinnedKeys`;
a founder self-anchors at genesis. A node with no pin authorizes no one — correct
by design, but previously silent, so `listAuthorizedMembers` now logs once per
call when it has rows and an empty anchor.

**Fixed in this pass (minor):**

- The `reauthorizePeer` NOTE deferred its concern to "once ticket-4's predicate
  checks `VouchOwner` against a node-local anchor" — that condition is now met.
  Rewritten to state the live constraint: the write-while-alone drain only
  re-touches rows this node itself authored, and any future path that lets one
  owner re-touch another owner's row must re-vouch deliberately rather than
  inherit the silent rebinding.
- The five-field `CadrePeer` row shape was restated inline in three places.
  Extracted as `CadrePeerRow` (plus `CadrePeerVoucherFields`, the subset the
  predicate reads) in `types.ts`, so a future column addition cannot reach the
  query without the predicate seeing it.
- Two test gaps: `VouchOwner: null` was the one partial-voucher variant not
  covered, and nothing tested a voucher lifted wholesale from another peer's row
  (the `PeerId` half of the digest binding). Both added — spec is now 11 tests,
  all real ed25519.
- Both protocol modules' authorization doc comments still described the gate as
  plain control-network membership. Rewritten to say the module enforces whatever
  predicate it is injected with, and that `CadreNode` injects the voucher-anchored
  one.
- `docs/STATUS.md`'s membership-gate section still described the hole as open.
  Added a dated update: steps 1–4 landed, what scenario 3 proves, where the
  production pins come from, and what steps 5 and 6 still leave open.

**Filed as a new ticket (major enough not to fix here):**

- `backlog/bug-host-trust-circle-lists-unauthorized-peers` — the self-hosted
  manager's trust-circle listing and status member count read the addressable
  surface, so an outsider's self-published row appears in the owner's member list
  as though it were an invited device. No gate is bypassed (every protocol check
  uses the authorized surface), but the screen an operator uses to decide who
  belongs misrepresents who belongs. Consumer-side change; the admin channel and
  owner-node client already expose both surfaces.

**Recorded as tripwires, not tickets** (each parked at its code site):

- Per-call signature verification with no memo of verified triples — fine at
  cadre sizes; NOTE at `hasAnchoredVoucher` says to cache on `StampId` if gate
  traffic grows.
- Owner key rotation strands rows vouched by the old key until re-vouched — NOTE
  at the predicate; belongs to `flip-strand-membership-rotation-known-gap`.
- `reauthorizePeer` voucher rebinding, as above — NOTE at the write site.
- The genesis over-anchoring tripwire inherited from chain step 3 (a joiner that
  wires seed-bootstrap with its own key self-anchors as `genesis`) — today only
  owners call `initializeSeedBootstrap`; that NOTE stands.

**Checked and found nothing:** the host's `TrustCircleService.isMember` is not an
authorization gate (listing and removal only, no route auth depends on it); no
other inbound control protocol needs this predicate (seed delivery is
deliberately open to strangers for enrollment, and the control-DB repo protocol
belongs to the queued gater ticket); the unit spec's private-field injection
(`trustedOwnerStore`, `controlDatabase`, `controlNode`) still matches
`CadreNode`'s internals, and the `peerId` getter reads `controlNode`, which
`start()` assigns before `controlDatabase` — so self-exclusion cannot silently
degrade. `docs/architecture.md`'s anchor and push-wake paragraphs were verified
accurate against the code as written.

## Validation

`yarn lint` and `yarn typecheck` clean at the repo root. Unit: cadre-core 689
passed / 1 skipped (51 files), cadre-host 448 passed / 3 skipped, cadre-cli 94
passed. Integration (against a fresh `yarn build` of cadre-core — the scenarios
resolve its `dist`, not `src`): push-wake scenario 3 (the acceptance case) and
scenario 4 (the replication/enrollment case) both green, `cadre-host-owner-node`
9 passed.

Push-wake scenarios 1 and 2 still fail at `authorizePeer` with
`membership-not-admitted:low-confidence-downsize`, before any wake logic runs.
That is the pre-existing two-node-cluster commit failure already listed in
`tickets/.pre-existing-known.md` against `blocked/control-db-convergence-optimystic-p2p`
— not re-reported, and not reachable to validate until that blocker clears.
