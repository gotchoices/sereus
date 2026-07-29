----
description: Every signed control-plane approval now carries a fixed label saying which table and action it authorizes, so an approval signed for one purpose (e.g. granting a narrow role) can no longer be replayed to grant a different one (e.g. full ownership).
files: schemas/control.qsql, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/device-token.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/control-authorization-domain-separation.spec.ts, packages/cadre-core/test/digest-variadic-parity.spec.ts, packages/integration-tests/src/harness/test-network.ts
----

# Complete: domain-separated CadreControl approvals

## What was wrong

An owner authorized a control-plane write by signing a digest over just the row's fields —
nothing said which table or action the approval was for. Several rules built byte-identical
digests, so one approval satisfied several rules. Worst case (reproduced live before the fix):
an owner's approval to add a narrow **validation key** was, unchanged, a valid approval to add
that same key as a full **owner** — direct privilege escalation to the validation-key holder.
Also: the stored, replicated `CadrePeer.VouchSig` satisfied `OwnerKey` insert for any reader;
a `DeviceToken` insert approval doubled as its delete; the offline enrollment vouch doubled as
a device-token approval.

## What shipped

Every signed control-plane message is a digest over a field vector that **leads with two fixed
literals**: `digest(<domain>, <action>, <row fields...>)`.

- `<domain>` = `'CadreControl.<Table>'`, or `'Cadre.Enrollment'` for the offline peer vouch.
- `<action>` = `'add'` | `'remove'` | `'vouch'` (owner-signed membership vouch, deliberately
  shared by `CadrePeer` insert + owner-update) | `'publish'` (peer *self-signed* record
  branches of `CadrePeer`/`DeviceToken`).
- One builder, `controlAuthorizationFields(domain, action, rowFields)` in
  `packages/cadre-core/src/control-authorization.ts`, is the single definition; both digest
  producers (`control-database.ts:buildAuthorizationMessage` — raw bytes; `peer-authorization.ts`
  helpers — base64url) route through it. `ControlTable` moved there.

Schema (both copies byte-identical, drift-spec enforced): all digests retagged; the old trailing
`'remove'` marker dropped (subsumed by the action field); `DeviceToken`'s single
`check on insert, delete` split into `AuthorizedInsert`/`AuthorizedDelete`; `FormationInvite`'s
`AuthorizedAddOrRemove` likewise split with the `coalesce(new, old)` pairs dropped;
`FormationUsage` and both self-signed update branches moved off ambiguous `||`-string-concat
digests onto tagged multi-field vectors.

Writers updated across `control-database.ts` and `seed-bootstrap.ts`; `signPeerAuthorization`
deleted in favour of explicit `deviceTokenAddDigest`/`deviceTokenRemoveDigest`.

**No backwards compatibility, by design**: an old untagged signature stops verifying everywhere,
including previously stored `VouchSig` values.

## Review findings

### Verified as correct

- **Injectivity of the encoding the whole scheme rests on.** Read the crypto plugin's
  `encodeFields` (`../optimystic/packages/quereus-plugin-crypto/src/crypto.ts`): a format byte
  followed by per-field `tag ‖ varint(length) ‖ payload`. That framing is prefix-free, so two
  different field sequences — including sequences of different length — always encode to
  different bytes. Leading with the domain and action tags is therefore genuinely sufficient to
  separate the rules.
- **TS ⇔ SQL parity for the leading tags.** `digest-variadic-parity.spec.ts` case (d) pins that
  TS array elements and SQL string literals hash the same bytes, with a wrong-domain negative.
  This is the one silent-failure mode of the migration and it is now covered.
- **All six cross-domain replay pairs** in `control-authorization-domain-separation.spec.ts`
  refuse by constraint *name*, not by an incidental error, and each has a positive control
  proving the captured signature is genuine.
- **Missed-signer sweep.** Grepped every digest producer and consumer in `packages/*/src`. No
  in-repo signer was left on an untagged construction. `DeviceToken`'s owner-update `'vouch'`
  branch and `FormationUsage`'s validation branch have no in-repo producer — but they had none
  before this change either, so nothing regressed.
- **No functional break in the device-token flow.** `updateSelfDeviceToken` writes with
  `OwnerKey = null`, so it takes the self-signed `'publish'` branch and never needed the owner
  digest that changed.

### Fixed in this pass (minor)

- `control-authorization.ts` / `control-database.ts`: the list of control table names was
  duplicated — the `ControlTable` union moved to the new module while the runtime `Set` that
  guards `countRows`' dynamic `from` clause stayed behind, so a new table could be added to one
  and missed in the other. Now a single `CONTROL_TABLES` tuple, with the union derived from it
  and the guard built from it.
- `types.ts`: `CadrePeerRow.vouchSig` still documented the pre-tag `digest(peerId, stampId)`.
- `seed-bootstrap.ts` (`reauthorizePeer`): same stale digest description in a comment.
- `control-authorization-domain-separation.spec.ts`: the `FormationInvite` case asserted only
  the refusal, with no positive control. Added the properly `'remove'`-tagged delete, so the
  test proves the split works in both directions rather than only that *something* refuses.

### Filed as a new ticket (major)

- **`backlog/bug-strand-approval-domain-separation`** — the `Strand` schema has the same class
  of defect, untouched by this ticket. `Member.Authorized`'s direct-admit branch verifies a
  manager's signature over `digest(new.Key)`; `Manager.Authorized`'s admin-removal branch
  verifies another manager's signature over `digest(old.MemberKey)`. Byte-identical. So the
  approval a manager signs to admit key X is also a valid authorization for anyone to delete X's
  `Manager` row — and the normal way to seat an admin (admit as member, then promote) mints
  exactly that signature. `MinOneManager` bounds a total wipe but not targeted demotion. The
  in-flight `bug-strand-manager-authority-antireplay` names the general shape but not this
  cross-table pair, and a nonce alone would not close it.

### Recorded as tripwires, not tickets

- **Party scope.** The tag scopes an approval to a table and an action, not to a *party*: two
  parties sharing an owner key would accept each other's approvals. Fine while each party has
  its own owner key. Parked as a `NOTE:` at `OwnerKey.Authorized` in both schema copies (added
  during implement; confirmed present and accurate).
- **Anti-replay nonce gaps** (`DeviceToken` has no `StampId`; remove-then-replay resurrection)
  are already owned by the sibling `fix/` tickets `bug-devicetoken-authority-antireplay`,
  `bug-strand-manager-authority-antireplay`, `bug-control-remove-then-replay-resurrection`. Not
  re-filed. This ticket closed only the cross-domain axis.

### Checked and clean, nothing to report

- **Docs.** Read every doc touching this area. `docs/architecture.md` (signing idiom, `cadre
  enroll register`) and `docs/STATUS.md` both describe the tagged digests accurately. The
  remaining `digest(...)` references in `architecture.md` are strand-layer and correct for that
  layer.
- **Schema drift.** `control-schema-drift.spec.ts` passes, so the embedded copy and
  `schemas/control.qsql` are identical.
- **Source hygiene.** The new module is 80 lines, one exported function, no imports (kept light
  on purpose so the offline enroll verifier does not pull in the runtime). No oversized files or
  comment-block-instead-of-function patterns introduced.

### Out-of-repo residual (unchanged from the handoff, restated so it is not lost)

The `'Cadre.Enrollment'` / `'vouch'` digest is only *verified* in-repo. Whatever owner tooling
signs an enrollment vouch lives outside this repo and must adopt the tagged digest, or
`cadre enroll register` will silently report an invalid signature. Same caveat for any external
validation-key holder signing `FormationUsage` disclosures.

## Validation run (2026-07-29)

- `yarn lint` at repo root — clean.
- `packages/cadre-core`: `yarn typecheck` clean; full suite `57 files, 801 passed, 1 skipped`.
- Implement stage additionally ran `packages/integration-tests` typecheck + build clean and a
  full scenario run whose only failures were the 8 already listed in
  `tickets/.pre-existing-known.md` (all blocked on `control-db-convergence-optimystic-p2p`).
  Not re-run in review — the review edits are confined to `cadre-core` comments, one test
  assertion, and the table-list de-duplication, all covered by the cadre-core suite.
- One flake observed during implement (`control-formation-invite.spec.ts > resolveStrand …`,
  5151 ms vs a 5000 ms limit under parallel load) did **not** recur in the review run.
