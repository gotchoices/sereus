description: Persisted the vouching authority (key + signature) onto each CadrePeer membership row, so a reader can later prove which authority approved a peer. No enforcement yet — ticket 4 consumes it.
files:
  - packages/cadre-core/src/control-schema.ts (CadrePeer: +VouchAuthority/+VouchSig, AuthorizedInsert binding, AuthorizedUpdate immutability)
  - schemas/control.qsql (byte-aligned mirror; control-schema-drift guards it)
  - packages/cadre-core/src/seed-bootstrap.ts (insertCadrePeerRow writes voucher == context; reauthorizePeer re-binds; +NOTE tripwire)
  - packages/cadre-core/src/control-database.ts (queryCadrePeers surfaces vouchAuthority/vouchSig)
  - packages/cadre-core/test/control-cadrepeer-voucher-constraint.spec.ts (crypto-free predicate spec, 7 cases)
difficulty: medium
---

# Complete: persist the vouching authority on each CadrePeer row

Step 2 of the Option-B membership chain. Voucher (`VouchAuthority`/`VouchSig`) is now
written and readable on every `CadrePeer` row; **enforcement is deliberately absent** —
ticket 4 (`membership-authorized-predicate-and-gates`) checks the recorded voucher against
a node-local trusted-authority anchor and closes the non-member wake hole.

## What landed (as reviewed, already committed in 2e41e54)

- **Schema, both synced copies:** `CadrePeer` gains `VouchAuthority text null` +
  `VouchSig text null`. `AuthorizedInsert` requires `new.VouchAuthority =
  context.AuthorityKey and new.VouchSig = context.Signature` — the stored voucher MUST
  equal the (authority, signature) pair the existing `verify(digest(PeerId, StampId))`
  branch validated. `AuthorizedUpdate` self-branch adds voucher immutability
  (`new.VouchAuthority = old.VouchAuthority and new.VouchSig = old.VouchSig`); the
  authority-rotation branch re-binds the voucher to the re-authorizing authority.
- **Write path:** `insertCadrePeerRow` (shared by `authorizePeer` + `insertSelfPeerRecord`)
  and `reauthorizePeer` (write-while-alone re-touch) both write the voucher = the context
  pair.
- **Read path:** `queryCadrePeers()` widened additively to
  `{ peerId, multiaddr, stampId, vouchAuthority, vouchSig }`. `queryPeerRecord` unchanged
  (address resolution needs no voucher).

## Review findings

Adversarial pass over the committed implement diff (read first, before the handoff).
Angles checked: schema-drift/byte-alignment, fail-closed behavior, NULL-safety, insert-path
completeness, self-refresh interaction, type safety, tests (happy/edge/error), docs.

**Correctness — CONFIRMED SOUND (no fix needed):**
- **Fail-closed on null voucher.** A null-voucher insert cannot succeed: `new.VouchAuthority
  = context.AuthorityKey` evaluates to SQL NULL (not true) when either side is null, so the
  `AuthorizedInsert` conjunction fails. The real write path also always supplies a non-null
  authority key (`signDigest` throws without a private key before the insert runs). Net:
  no voucher-less `CadrePeer` row can exist.
- **Immutability check is NULL-safe in practice.** Because no null-voucher row can be
  inserted (above), `old.VouchAuthority` is always non-null on any existing row, so the
  strict-`=` immutability predicate the handoff flagged as "NULL-unsafe by design" never
  meets a null `old` — the concern is real in the abstract but unreachable given the insert
  guard. Confirmed.
- **Only one CadrePeer insert path** (`insertCadrePeerRow`); grep-verified. No second,
  voucher-less insert that the tightened constraint would now silently fail closed.
- **Self-refresh (`updateSelfPeerRecord`) still admitted.** It SETs only
  Multiaddr/UpdatedAt/Sig, so `new.Vouch* = old.Vouch*` holds untouched → the self-branch
  passes. Covered crypto-free by the spec's "admits an untouched self-update" case.

**Docs — checked, already current:** `docs/STATUS.md` documents the voucher persistence as
step 2 of the Option-B chain and (line ~215) marks gate enforcement as ticket-4's job.
`schemas/control.qsql` is byte-aligned with `control-schema.ts` (drift guard passes). No
doc update required.

**Test coverage — adequate, one handoff drift noted (no code impact):**
- The crypto-free spec actually has **7** cases (handoff said "6/6"), and it covers StampId
  single-use/uniqueness + StampId-rotation rejection rather than the handoff's claimed
  "admits delete" — i.e. the committed spec is *broader* than the handoff described; the
  stale count/description is a handoff artifact, not a code defect.
- End-to-end proof of the real (crypto) insert+delete through the new constraint:
  `cadre-host-authority-node.integration.ts` full add→remove cycle **passes**.

**Tripwire (conditional; parked, not ticketed):** `reauthorizePeer` rebinds `VouchAuthority`
to *this* node's authority key. Benign now — the write-while-alone drain only re-touches
rows this node itself authored. It only becomes a concern if a future path lets authority A
re-touch a row authority B vouched (voucher would silently flip to A), and only once
ticket-4's predicate anchors on `VouchAuthority`. Recorded as a `NOTE:` code comment at the
`reauthorizePeer` re-bind site (`seed-bootstrap.ts`) for greppability.

**Major findings:** none — no new tickets filed.
**Minor findings requiring an inline fix:** none — the implementation was clean; the only
edit this pass made is the tripwire NOTE comment above.

## Verification run (this review)

- `yarn typecheck` (cadre-core): clean.
- `yarn lint` (monorepo): 0 problems.
- cadre-core targeted specs — `control-cadrepeer-voucher-constraint`, `control-schema-drift`,
  `control-member-key-constraint`, `cadre-node-control-replication`,
  `cadre-node-control-cohort`, `peer-authorization`, `authority-key`,
  `cadre-node-authorized-surface`: **64/64 passed** (8 files).
- Integration — `cadre-host-authority-node`: **7/7 passed** (incl. real authorizePeer
  insert + removePeer delete through the new constraint).
- Integration — `control-db-two-node-convergence`: **FAILING, pre-existing/flaky**, not
  from this diff. Two consecutive runs failed with two *different* p2p-layer signatures
  (`membership-not-admitted:low-confidence-downsize` cluster-sizing rejection; then a Yamux
  `StreamResetError`), every frame inside the external `../optimystic` `db-p2p`/`db-core`
  workspace — the live 2-node replication substrate, not `CadreControl`. `docs/STATUS.md`
  (~line 552) already characterizes this exact 2-of-2 validator rejection as "optimystic-side
  networking work, not a one-line sereus change." Documented in `tickets/.pre-existing-error.md`
  for the triage pass (it is not yet in `.pre-existing-known.md`). Not skipped, disabled, or
  papered over.

## Downstream (unchanged from handoff)

- Enforcement lands in ticket 4; `listMembers`/`listAuthorizedMembers` return-type widening
  to carry the voucher is ticket 4's job. Left intentionally.
