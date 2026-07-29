description: Every signed control-plane approval now carries a fixed label saying which table and action it authorizes, so an approval signed for one purpose (e.g. granting a narrow role) can no longer be replayed to grant a different one (e.g. full ownership). Review the schema retag, the shared digest builder, and the new cross-domain replay tests.
files: schemas/control.qsql, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/device-token.ts, packages/cadre-core/test/control-authorization-domain-separation.spec.ts, packages/cadre-core/test/digest-variadic-parity.spec.ts, packages/integration-tests/src/harness/test-network.ts
----

# Review: domain-separated CadreControl approvals

## What was wrong

An owner authorized a control-plane write by signing a digest over just the row's fields —
nothing said which table or action the approval was for. Several rules built byte-identical
digests, so one approval satisfied several rules. Worst case (reproduced live before the fix):
an owner's approval to add a narrow **validation key** was, unchanged, a valid approval to add
that same key as a full **owner** — direct privilege escalation to the validation-key holder.
Also: the stored, replicated `CadrePeer.VouchSig` satisfied `OwnerKey` insert for any reader;
a `DeviceToken` insert approval doubled as its delete; the offline enrollment vouch doubled as
a device-token approval.

## What changed

Every signed control-plane message is now a digest over a field vector that **leads with two
fixed literals**: `digest(<domain>, <action>, <row fields...>)`.

- `<domain>` = `'CadreControl.<Table>'`, or `'Cadre.Enrollment'` for the offline peer vouch.
- `<action>` = `'add'` | `'remove'` | `'vouch'` (owner-signed membership vouch, shared by
  `CadrePeer` insert + owner-update by design) | `'publish'` (**design delta vs the implement
  ticket**: a fourth action added for the peer *self-signed* update branches of
  `CadrePeer`/`DeviceToken` — the three owner-action names didn't fit a self-published record;
  documented in `control-authorization.ts`).
- One builder, `controlAuthorizationFields(domain, action, rowFields)` in the new
  `packages/cadre-core/src/control-authorization.ts`, is the single definition; both digest
  producers (`control-database.ts:buildAuthorizationMessage` — raw bytes; `peer-authorization.ts`
  helpers — base64url) route through it. `ControlTable` moved there (re-exported from
  `control-database.ts`).

Schema changes (both copies byte-identical, drift-spec enforced):

- All digests retagged. `OwnerKey`/`CadrePeer` deletes dropped the old trailing `'remove'`
  marker (subsumed by the action field).
- `DeviceToken`: the single `check on insert, delete` split into `AuthorizedInsert` ('add') and
  `AuthorizedDelete` ('remove') — an insert approval no longer deletes.
- `FormationInvite`: `AuthorizedAddOrRemove` split into `AuthorizedInsert`/`AuthorizedDelete`,
  `coalesce(new, old)` pairs dropped. No in-repo writer deletes a `FormationInvite` (verified).
- `FormationUsage` and both self-signed update branches: ambiguous `||`-string-concat digests
  replaced with tagged multi-field vectors (injective encoding).
- Party-scope `NOTE:` comment added at `OwnerKey.Authorized` in both copies: the tag scopes an
  approval to table+action, **not** to a party — fine while each party has its own owner key;
  binding a party identity is a separate design (deliberately not ticketed, per source ticket).

Writers updated: `insertStrand` / `insertValidationKey` / `insertFormationInvite`
(control-database.ts); `insertCadrePeerRow` / `removePeer` / `reauthorizePeer` /
`insertSelfDeviceToken` / `deleteDeviceToken` (seed-bootstrap.ts — device-token writers now use
new `deviceTokenAddDigest`/`deviceTokenRemoveDigest`); `peerRecordSignedPayload` /
`deviceTokenSignedPayload` ('publish' vectors). `signPeerAuthorization` was **deleted** — its
only callers were the two device-token writers; `peerAuthorizationDigest` (now
`'Cadre.Enrollment'`/`'vouch'`) remains for `verifyPeerAuthorization` + cadre-cli enroll.
`test-network.ts` needed prose-only updates (its sign-callbacks sign whatever bytes the
writers build, so tags ride through).

**No backwards compatibility, by design**: an old untagged signature stops verifying
everywhere, including previously stored `VouchSig` values.

## Tests to lean on

- **`test/control-authorization-domain-separation.spec.ts`** (new) — all 6 cross-domain replay
  pairs refused **by constraint name**: ValidationKey-add→OwnerKey-add (this one was RUN
  against the pre-fix schema and FAILED, proving the escalation live before the schema change),
  OwnerKey-add→ValidationKey-add, stored `CadrePeer.VouchSig`→OwnerKey-add,
  OwnerKey-remove→CadrePeer-delete, DeviceToken-add→DeviceToken-delete,
  FormationInvite-add→FormationInvite-delete. Positive controls included (the genuine
  properly-tagged sig then succeeds).
- **`test/digest-variadic-parity.spec.ts`** — new case pins TS-array-elements ⇔ SQL-literal-arg
  parity for the leading tag fields (the property the whole scheme rests on), plus wrong-domain
  / wrong-action negatives.
- `peer-authorization.spec.ts` regression case: tagged inline construction verifies true AND
  the legacy untagged construction verifies FALSE.

## Validation run (all green, 2026-07-29)

- `yarn lint` (repo root), `yarn typecheck` + `yarn build` in `packages/cadre-core`.
- Full `packages/cadre-core` suite: 57 files, 801 passed, 1 skipped.
- `packages/integration-tests`: `yarn typecheck` + `yarn build` clean; a full scenario run
  executed too — only failures were the 8 already listed in `tickets/.pre-existing-known.md`
  (all blocked on `control-db-convergence-optimystic-p2p`), nothing new.
- `packages/cadre-cli` typecheck clean (its `enroll` command consumes `verifyPeerAuthorization`).

## Honest gaps / reviewer attention

- **Enrollment vouch producers are out-of-repo.** The `'Cadre.Enrollment'`/`'vouch'` digest is
  only *verified* in-repo (`verifyPeerAuthorization`, cadre-cli `enroll register`); the owner
  tooling that *signs* a vouch lives outside this repo and must adopt the tagged digest, or
  enrollment verification silently returns false. Worth an explicit check that no in-repo
  signer was missed.
- **`FormationUsage` validation-branch signer**: no in-repo producer exists (`signFormation`
  is an interface implemented only by test mocks that never hit the schema), so the retag
  changed no writer. If an external validation-key holder signs these, same caveat as above.
- Anti-replay **nonce** gaps are intentionally untouched and stay with the sibling fix tickets:
  `bug-devicetoken-authority-antireplay` (DeviceToken has no StampId — its 'add'/'remove'
  digests are still replayable within their own domain), `bug-strand-manager-authority-antireplay`,
  `bug-control-remove-then-replay-resurrection` (nonce lifetime). This ticket closed only the
  cross-domain axis.
- **Flake observed once**: `control-formation-invite.spec.ts > resolveStrand: classifies
  bound (present) / unbound / missing host strands` timed out (5151 ms vs 5000 ms limit) under
  full-suite parallel load; passes in isolation and on full-suite re-run. Timing flake, not a
  digest regression — if it recurs, bump that test's timeout.
- The 5 newer domain-separation tests build raw SQL insert/delete shapes for
  CadrePeer/DeviceToken/FormationInvite from the schema; they pass, but a reviewer eyeballing
  those raw statements against the real writers is cheap insurance.
