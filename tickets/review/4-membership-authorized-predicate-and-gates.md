----
description: A peer now counts as a real member only when an authority key this node trusts locally vouched for it, with a valid signature — so an outsider who merely publishes rows into the shared database can no longer wake a sleeping node or query its strand addresses.
files:
  - packages/cadre-core/src/peer-authorization.ts (new verifyCadrePeerVoucher)
  - packages/cadre-core/src/cadre-node.ts (listAuthorizedMembers / isAuthorizedMember / hasAnchoredVoucher, ~L2680-2760)
  - packages/cadre-core/src/index.ts (export)
  - packages/cadre-core/test/cadre-node-authorized-surface.spec.ts (9 predicate tests, real crypto)
  - packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (all 4 scenarios reworked)
  - packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts (authorized asserts in add→remove cycle)
  - packages/integration-tests/src/scenarios/control-{db-two-node,cohort-auto,write-while-alone}-convergence.integration.ts (comment-only: addressable-surface decisions)
  - docs/architecture.md, docs/STATUS.md
difficulty: hard
----

# Review: authorized membership enforced against the node-local anchor

Step 4 of the membership chain — the step that closes the hole where an outsider
could wake a sleeping node by publishing its own rows into the replicated
control DB. Naming note (tickets were written pre-rename): "authority" ==
**owner** in code — `VouchAuthority`→`VouchOwner`, `TrustedAuthorityStore`→
`TrustedOwnerStore`.

## What shipped

- **`verifyCadrePeerVoucher(peerId, stampId, ownerPublicKey, signature)`**
  (`peer-authorization.ts`): read-side mirror of the voucher written by
  `insertCadrePeerRow` — verifies over `cadrePeerVoucherDigest(peerId, stampId)`
  (NOT the plain `peerAuthorizationDigest`; the voucher binds the row's
  anti-replay `StampId` nonce). Never throws; malformed input → `false`.
- **The 4-condition predicate** (`CadreNode.listAuthorizedMembers`, consulted by
  `isAuthorizedMember`): not-self ∧ complete voucher (`StampId`/`VouchOwner`/
  `VouchSig` non-null) ∧ `VouchOwner` ∈ node-local `TrustedOwnerStore` ∧
  signature verifies. Fail-closed on every missing piece, including a null
  anchor (pre-start) and an empty anchor (un-enrolled node authorizes no one).
  Row check lives in one private helper `hasAnchoredVoucher`; `isAuthorizedMember`
  deliberately reuses `listAuthorizedMembers` (one query, one code path — noted
  in a doc comment) instead of a single-row read.
- **Gates**: no wiring change needed — `strand-wake-protocol` and
  `strand-addr-protocol` receivers were already pointed at `isAuthorizedMember`
  (ticket 1), so both inherited the real check. `resolvePeerAddrs`, push
  fan-out, `listMembers`/`isMember` stay on the addressable surface, untouched.

## How to validate (what the tests prove)

- **Unit (`cadre-node-authorized-surface.spec.ts`, real ed25519 signatures)**:
  anchored+valid → authorized; self excluded even with a valid voucher; null and
  partial vouchers fail; valid-but-unanchored owner fails (the self-minted-owner
  attack); forged/replayed signature fails (incl. sig by a different key than
  the claimed `VouchOwner`, and a sig over another `StampId`); empty anchor and
  missing anchor authorize no one; fresh-party shape.
- **push-wake-e2e scenario 3 — THE acceptance case** (green): outsider O's
  self-minted owner key + self-vouched `CadrePeer` row are written into Rx's
  replicated tables (satisfying every replicated-schema constraint), so
  `Rx.isMember(O)` is TRUE — and the wake is still rejected (`accepted:false`,
  strand stays `hibernating`) and the strand-addr RPC returns empty over the
  real wire. Then the positive control: one `Rx.trustOwnerKeys([oOwnerPub])`
  pin flips the identical state to authorized and the same strand-addr dial
  returns live addrs — proving the refusal was the anchor check, and covering
  the strand-addr non-member↔member contrast the ticket asked to mirror.
- **push-wake-e2e scenario 4** (green): the production enrollment story — S and
  Rx pin owner A's key (`trustOwnerKeys(..., 'invite')`), A writes S's
  membership, the row replicates with `VouchOwner`/`VouchSig` intact
  (converge-then-assert: voucher non-null on the reader — the "legit member,
  un-synced voucher" edge), and Rx's wake gate passes on the sibling-written
  row. Stranger stays false on both surfaces.
- **cadre-host-owner-node scenario** (green, real spawned owner node):
  fresh party → empty authorized set; after `acceptPhone` the phone is
  authorized (host's genesis-anchored own key vouched it — the "sibling vouched
  by the party owner" rule-3-passes case); after `removePeer` both surfaces
  false.
- **Convergence scenarios**: assert row replication only → kept on the
  addressable `isMember` with a comment at each site saying why (per-assertion
  decisions the ticket asked for).

Test runs: cadre-core 688 passed / 1 skipped (51 files); cadre-host 448;
cadre-cli 94; root `yarn lint` + `yarn typecheck` clean; integration chunks:
connectivity+cadre-host 37, seed/enrollment/rbac/happy-path 21, owner-node 9,
strand/multi-party chunk 19 passed + 10 pre-existing-red (below).

**Reviewer note: integration-tests resolves cadre-core's built `dist`, not
`src` — run `yarn build` in `packages/cadre-core` before re-running scenarios
or you will validate the stale predicate** (this bit me mid-implement: scenario
3 "failed" against the old dist).

## Known gaps / honest flags

- **Pre-existing upstream red, NOT this ticket**: every 2-node cluster commit
  fails at HEAD with `membership-not-admitted:low-confidence-downsize`
  (optimystic admission gate vs hardcoded `clusterSize: 3`; tracked in
  `blocked/control-db-convergence-optimystic-p2p`). This reddens push-wake
  scenarios 1–2 (they fail at `authorizePeer`, before any wake logic; verified
  identical at baseline before my edits), the three convergence-scenario
  waits, and ~10 strand/multi-party tests. Newly-observed instances are
  reported in `tickets/.pre-existing-error.md` for triage; scenario 1/2 edits
  (anchor pins + authorized asserts) are in place and should go green when the
  blocker clears — a reviewer cannot currently run them to completion.
- **Scenario 3 models replication by direct local writes** (a throwaway
  `SeedBootstrapService` holding O's key writes into Rx's DB) because a live
  {O, Rx} 2-node commit hits the upstream blocker. Byte-identical rows to what
  replication would converge; scenario 4's 3-node cohort proves the wire path.
  If the blocker's resolution changes genesis-admission semantics, revisit
  whether scenario 3 should switch back to live replication.
- **No positive strand-addr integration case between two long-lived members**
  outside scenario 3's post-pin dial; the member+running path is otherwise
  unit-level (`strand-addr-protocol.spec.ts`).
- **Per-call signature verification** — no caching; NOTE at
  `hasAnchoredVoucher` (tripwire, fine at cadre sizes).
- **Rotation**: an owner rotating to a newly-pinned key strands rows vouched by
  the old key (fail rule 3 until re-vouched) — NOTE at the predicate site;
  belongs to `flip-strand-membership-rotation-known-gap`.
- **Genesis over-anchoring tripwire inherited from ticket 3**: a joiner that
  wires seed-bootstrap with its own key self-anchors as `'genesis'` — that key
  would then pass rule 3 for rows it vouched. Today only owners call
  `initializeSeedBootstrap`, so benign; the NOTE in ticket 3's code stands.

## TODO (review stage)

- Adversarial pass over the predicate: any way a row passes with a voucher not
  produced by an anchored owner's live signature? (Pay attention to
  `reauthorizePeer` re-binding `VouchOwner` to the re-toucher's key — currently
  benign per its NOTE, but now trust-relevant.)
- Check the unit spec's private-field injection (`trustedOwnerStore` cast)
  still matches `CadreNode` internals after any refactor.
- Confirm the docs edits (architecture.md wake-gate paragraph, STATUS.md) read
  accurately against the code.
