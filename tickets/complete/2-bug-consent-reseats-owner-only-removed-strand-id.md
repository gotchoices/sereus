description: When a party deleted one of its networks, someone holding an unused invitation could bring that network's entry back under the same name. Deletion records now name the deleted entry and the invitation path refuses any name that was ever deleted, so removal is final.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, packages/cadre-core/test/control-authorization-domain-separation.spec.ts, packages/cadre-core/test/control-ownerkey-self-authorization.spec.ts, docs/architecture.md
----

# Complete: network-entry deletion is final against the unsigned (consent) path

## What shipped

A `CadreControl.Strand` row seated purely owner-signed writes no `FormationUsage`
record, so the consent branch's "once per id, ever" rule — which keys off a surviving
usage row — could not foreclose it. After a legitimate owner-signed removal, a spare
unbound invite use could re-seat the same strand id unsigned.

Two parts:

1. **`Revocation` gained `RowKey text not null`** — the removed row's primary key
   (`OwnerKey.Key` / `ValidationKey.Key` / `CadrePeer.PeerId` / `DeviceToken.PeerId` /
   `Strand.Id`), between `TableName` and `StampId` in the column list and in the
   owner-signed `Authorized` digest, now
   `digest('CadreControl.Revocation', 'remove', TableName, RowKey, StampId)`.
   Primary key stays `(TableName, StampId)` — one name may carry several tombstones
   across seat/remove cycles.
2. **`Strand.AuthorizedInsert`'s consent branch gained a final clause**:
   `not exists (select 1 from Revocation R where R.TableName = 'Strand' and R.RowKey = new.Id)`.
   A strand id may be consent-seated once ever AND never after any removal of that id,
   however it was seated. The owner-signed branch is untouched, so re-join stays
   owner-gated.

Added during review (see findings): every guarded table's `RevocationRecorded` CHECK
now also binds `R.RowKey = old.<primary key>`, so a delete cannot file a tombstone that
misnames the row it retires.

Writers: `peer-authorization.ts` `revocationDigest(tableName, rowKey, stampId)`;
`control-database.ts:deleteGuardedRow`; `seed-bootstrap.ts` `deleteDeviceToken` /
`removePeer`. Schema edited in both copies (`schemas/control.qsql` and the inlined
`CONTROL_SCHEMA` in `packages/cadre-core/src/control-schema.ts`); the drift spec pins
they match. Design rationale lives as constraint comments in the schema itself.

Deliberately untouched: `schemas/strand.qsql`'s per-strand `Strand.Revocation` (a
different RBAC layer, different threat model) and
`control-devicetoken-stamp-constraint.spec.ts`'s local crypto-free `Probe` schema.
No migration — repo has no backwards-compat requirement yet.

## Review findings

### Checked

- **Read the implement diff first, before the handoff summary.** Full diff
  `8e2d1c8..267f1bf` over `schemas/`, `packages/`, `docs/`.
- **Every `CadreControl.Revocation` writer in the repo.** Six insert sites (three in
  `src/`, three test helpers) — all on the 3-column shape. No stragglers.
- **The implementer's flagged risk that `integration-tests` hand-builds tombstones.**
  Resolved by inspection rather than by running the package: a repo-wide grep for
  `Revocation` returns zero hits under `packages/integration-tests`, so there is no
  such code to break. (The package still was not *executed* — see Gaps.)
- **Delete paths for every guarded table.** `deleteGuardedRow` (Strand /
  ValidationKey), `seed-bootstrap` `removePeer` / `deleteDeviceToken`. `OwnerKey` has
  no production delete path at all, only test helpers — so its tombstone convention is
  exercised only by tests.
- **Other `Strand` insert sites.** `reference-app-web/src/lib/cadre-web.ts:655` inserts
  owner-signed; it writes no tombstones and is unaffected.
- **Schema drift.** The embedded `CONTROL_SCHEMA` was regenerated mechanically from
  `schemas/control.qsql` rather than hand-mirrored, and the drift guard passes.
- **Docs against the new reality.** `docs/architecture.md` `Strand` / `Revocation`
  table rows and the Strand Membership Bootstrap section read correctly; two
  now-stale sentences updated (below). `docs/STATUS.md` and `docs/strands.md` mention
  `Revocation` only in unrelated contexts. No `bug-consent-reseats` or `RESIDUAL`
  reference to this bug survives anywhere in `src/`, `schemas/`, or `docs/`.
- **The convergence caveat and the pre-plant argument.** Both hold; see below.

### Found and fixed in this pass (minor)

- **`RowKey` was writer discipline, not a schema invariant, at the site that matters.**
  `RevocationRecorded` only required *a* tombstone carrying the deleted row's
  `StampId`; nothing forced that tombstone to name the right row. A removal filing
  `RowKey = <anything>` therefore satisfied every constraint while silently failing to
  foreclose the id — which is exactly the bug this ticket set out to close, one level
  down. Fixed: all five `RevocationRecorded` CHECKs now also require
  `R.RowKey = old.<primary key>`.

  The implementer's rejection of a cross-check was sound but scoped to the wrong
  constraint: binding `RowKey` inside `Revocation.Authorized` would break the
  delete-while-alone durability plan (`docs/architecture.md:192`), which re-issues a
  tombstone alone in a later transaction. `RevocationRecorded` fires only on a
  *delete*, so that path never trips it, and the delete's own tombstone is written in
  the same transaction — no convergence cost. This also closes the implementer's own
  "no test pins the RowKey convention per table" gap: a wrong-key writer now fails
  loudly for every guarded table, not just behaviorally for `Strand`.
- **Test added** — `'a signed delete must carry a tombstone naming the REMOVED ROW,
  not just its stamp (RevocationRecorded)'` in `control-revocation-replay.spec.ts`,
  covering `Strand` (where `RowKey` is load-bearing) and `CadrePeer` (pinning that the
  convention is enforced across tables), then proving both rows still remove cleanly
  with a correctly-named tombstone.
- **Comments and docs corrected.** The schema said "`RowKey` is owner-ATTESTED, not
  schema-verified" in two places and `docs/architecture.md` repeated it. That is now
  false for the removal path; the residual is precisely a **standalone** tombstone (no
  accompanying delete), which remains owner-attested. Reworded at
  `Revocation.RowKey`, `Revocation.Authorized`, `Strand.AuthorizedInsert`'s consent
  branch, and both architecture.md sentences.

### Verified, no change needed

- **The "owner can pre-plant a tombstone for an id that never existed" argument.**
  Holds. It is owner-only, the owner already controls invite issuance, and unbound
  strand ids are 128 random bytes minted at redemption, so nothing an owner can
  pre-block is a target an attacker could have reached. Same shape as the existing
  `RowIsGone` pre-plant note.
- **The convergence caveat.** The new clause is a write-time check against locally
  visible rows, like `NotRevoked`. A node that has not synced the tombstone accepts the
  re-seat; after merge tombstone and row coexist. Same class as the pre-existing
  `StampId` note, and it fails in the safe direction. Documented in the schema.
- **Consent clause scoped to `R.TableName = 'Strand'`.** A tombstone for another table
  naming a colliding id does not foreclose a strand id. Agreed this is fine:
  `RowIsGone` confines `TableName` to the five guarded tables, and a `CadrePeer` id
  colliding with a 128-random-byte strand id is not a reachable condition.
- **Owner-signed re-seat after tombstone.** Deliberate and tested — the owner branch
  ignores `Revocation`, so re-join works with a fresh stamp and signature.

### Tripwires (recorded, not filed as tickets)

- The consent branch's `not exists` over `Revocation` scans an append-only table that
  is never pruned, on every consent seat. Fine now — consent seats are rare and cadres
  are a handful of peers. Parked on the existing "unbounded growth is fine today;
  revisit if either changes" note on the `Revocation` table in `schemas/control.qsql`,
  which now covers a read path as well as the write side.

### Major findings

None. Nothing found warranted a new `fix/`, `plan/`, or `backlog/` ticket: the one
substantive defect was a two-token-per-constraint tightening with existing test
coverage around it, which is cheaper to land than to describe.

### Gaps this review did not close

- **`integration-tests` still not executed.** Cross-package, builds against `dist`,
  wall clock well past the agent-runnable limit. The specific risk the implementer
  flagged (hand-built tombstones there) is ruled out by grep, but the package's
  end-to-end behavior under the new schema is unverified. Leave to CI / a human.
- **Old-shape databases are not migrated.** Intentional per `AGENTS.md` ("no backwards
  compat yet") — an existing control database with a 2-column `Revocation` will not
  load against this schema.

## Validation

- Targeted: 10 spec files (revocation-replay, schema-drift, domain-separation,
  ownerkey-self-auth, authorization-binding, devicetoken-stamp-constraint,
  seed-bootstrap, device-token-registry, formation-invite, stream-authorization) —
  235 tests pass.
- Full `@serfab/cadre-core` suite: 67 files, 1029 pass, 1 skip (pre-existing
  win32-conditional in `key-store.spec.ts`, unrelated to this change and already
  skipped before it).
- `yarn typecheck` and `yarn lint` at repo root: clean.
