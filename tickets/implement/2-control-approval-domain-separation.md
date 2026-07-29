description: Approvals that an owner signs for one kind of control change are byte-identical to approvals for other kinds, so an approval meant to grant a narrow role also works to grant full ownership. Give every signed approval a fixed label saying what it authorizes.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/peer-authorization.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/device-token.ts, packages/integration-tests/src/harness/test-network.ts
difficulty: hard
----

# Domain-separate every signed CadreControl approval

## The defect

An owner authorizes a control-plane write by signing a SHA-256 digest over the fields of the
row being written. Nothing in that digest says **which table** or **which action** the approval
was for. Several tables happen to build the identical byte string, so one approval satisfies
several different rules.

### Inventory of every signed message in `CadreControl`

Read off `schemas/control.qsql` (and its byte-identical twin
`packages/cadre-core/src/control-schema.ts`):

| Table | Constraint | Fires on | Signed digest | Signer in repo |
|---|---|---|---|---|
| `OwnerKey` | `Authorized` | insert | `digest(new.Key, new.StampId)` | none (tests only) |
| `OwnerKey` | `Authorized` | delete | `digest(old.Key, old.StampId, 'remove')` | none (tests only) |
| `ValidationKey` | `Authorized` | insert | `digest(new.Key, new.StampId)` | `ControlDatabase.insertValidationKey` |
| `Strand` | `Authorized` | insert | `digest(new.Id, new.Type, coalesce(new.MemberPrivateKey,''), new.StampId)` | `ControlDatabase.insertStrand` |
| `CadrePeer` | `AuthorizedInsert` | insert | `digest(new.PeerId, new.StampId)` | `SeedBootstrapService.insertCadrePeerRow` |
| `CadrePeer` | `AuthorizedDelete` | delete | `digest(old.PeerId, old.StampId, 'remove')` | `SeedBootstrapService.removePeer` |
| `CadrePeer` | `AuthorizedUpdate` (owner branch) | update | `digest(new.PeerId, new.StampId)` | `SeedBootstrapService.reauthorizePeer` |
| `CadrePeer` | `AuthorizedUpdate` (self branch) | update | `digest(PeerId‖'\|'‖Multiaddr‖'\|'‖UpdatedAt)` | `peer-record.ts` (peer's own key) |
| `DeviceToken` | `AuthorizedInsert` | insert **and** delete | `digest(coalesce(new.PeerId, old.PeerId))` | `insertSelfDeviceToken` / `deleteDeviceToken` |
| `DeviceToken` | `AuthorizedUpdate` (owner branch) | update | `digest(new.PeerId)` | none |
| `DeviceToken` | `AuthorizedUpdate` (self branch) | update | `digest(PeerId‖'\|'‖Platform‖'\|'‖Token‖'\|'‖UpdatedAt)` | `device-token.ts` (peer's own key) |
| `FormationInvite` | `AuthorizedAddOrRemove` | insert **and** delete | 7-field digest over the row | `ControlDatabase.insertFormationInvite` |
| `FormationUsage` | `Authorized` | insert | `digest(new.Token ‖ new.Disclosure)` | validation-key holder |

### Collision classes

**Class A — `digest(X, StampId)`** is shared by four rules: `OwnerKey` insert,
`ValidationKey` insert, `CadrePeer` insert, and the `CadrePeer` owner-update branch.

- **`ValidationKey` → `OwnerKey` is direct privilege escalation.** Both `Key` columns hold an
  ed25519 public key in the same base64url form, so an owner's approval to add a narrow
  validation key is, unchanged, a valid approval to add that same key as a full owner. The
  natural recipient of that approval is the validation-key holder itself.
- **`CadrePeer.VouchSig` is a *stored, replicated* column** holding exactly this signature
  (`seed-bootstrap.ts:insertCadrePeerRow` persists the context pair onto the row so readers can
  re-check it). Any node that can read the table therefore holds a signature that satisfies
  `OwnerKey.Authorized` and `ValidationKey.Authorized` for `Key = <that PeerId string>`. The
  resulting `OwnerKey.Key` is a base58btc peer id, not a valid ed25519 key, so the row cannot
  itself sign anything — the damage is an unauthorized write into the party's most privileged
  table by any reader, not new signing authority. Fix it anyway; a table whose membership
  strangers can append to is not an authorization anchor.
- `CadrePeer` insert vs its owner-update branch is **deliberate** — same table, same semantics
  ("this owner vouches this membership row"). Keep those two sharing one tag.

**Class B — `digest(X, StampId, 'remove')`** is shared by `OwnerKey` delete and `CadrePeer`
delete. The `'remove'` marker separates add from remove but not table from table.

**Class C — `digest(PeerId)`** is shared by `DeviceToken` insert, `DeviceToken` delete, the
`DeviceToken` owner-update branch, and `peer-authorization.ts:peerAuthorizationDigest` — which
is a *different domain entirely*: the offline vouch that `cadre enroll register` verifies
(`packages/cadre-cli/src/commands/enroll.ts`). So an enrollment vouch handed to a new device
doubles as an approval to delete that peer's push token, and vice versa.

**Framing weaknesses (same family, no cross-table collision):** `FormationUsage.Authorized` and
both self-signed update branches build their digest by `||`-concatenating fields into a single
string instead of using the injective multi-field encoding. `digest(Token || Disclosure)` splits
ambiguously, and `PeerId|Multiaddr|UpdatedAt` (peer record) vs `PeerId|Platform|Token|UpdatedAt`
(device token) can be made to collide by a peer choosing a `Multiaddr` containing `|`. Both
payloads are signed by the same peer key, so this is not an escalation — but it is the same
defect and is cheap to close while the framing is being touched.

## Reproduction

The prior review of `bug-control-ownerkey-self-authorization` reproduced the
`ValidationKey → OwnerKey` promotion against a real control database. This ticket's research
re-derived the collision statically from the schema; a live re-run was cut short by the token
budget, so **the implementer should land the reproducing test first and watch it fail before
changing the schema.** Sketch (model it on
`packages/cadre-core/test/control-ownerkey-self-authorization.spec.ts`, which already has the
`CadreNode` + raw-`Database` harness, `signAs`, and `expectConstraintFailure` helpers):

```ts
// 1. Owner enrols a narrow validation key through the shipped API, capturing the signature.
let capturedSig: string | null = null;
await db.insertValidationKey(validation.publicKey, founder.publicKey, (message) => {
  const sig = signAs(founder, message);
  capturedSig = sig;
  return sig;
});
const stampId = String((await rawDb.get(
  'select StampId from CadreControl.ValidationKey where Key = ?', [validation.publicKey]))?.StampId);

// 2. Re-present the SAME (Key, StampId, signature) as an OwnerKey insert.
//    Pre-fix this is ACCEPTED and the validation key becomes a full owner.
await expectConstraintFailure(rawInsertOwnerKey(
  founder.publicKey, capturedSig, validation.publicKey, stampId), 'Authorized');
```

`CadreNode`'s accessors for the libp2p node / peer id were not confirmed during research — check
the class before writing the `CadrePeer.VouchSig` variant of this test (`getControlDatabase()`
exists; `getPeerId()` / `getLibp2pNode()` do **not**).

## The scheme

Every signed control-plane message becomes a digest over a field vector whose first two
elements are fixed literals:

```
digest(<domain>, <action>, <row field 1>, ..., <row field n>, <nonce>)
```

- **`<domain>`** — `'CadreControl.<Table>'` for a table rule, or `'Cadre.Enrollment'` for the
  offline peer vouch that no table verifies.
- **`<action>`** — `'add'`, `'remove'`, or `'vouch'` (the membership-vouch semantics shared by
  `CadrePeer` insert and its owner-update branch). The existing trailing `'remove'` marker on
  `OwnerKey` / `CadrePeer` deletes is subsumed by this field and must be dropped from the tail.
- **`<nonce>`** — the row's `StampId` where one exists today. Tables that lack one
  (`DeviceToken`, `Strand.Manager` on the strand side) keep lacking one here; adding the nonce
  column is the subject of `bug-devicetoken-authority-antireplay` and
  `bug-strand-manager-authority-antireplay`, which plug into this same vector.

This is the single scheme those sibling tickets were waiting on: **domain and action land here;
nonce presence and nonce lifetime (`bug-control-remove-then-replay-resurrection`) land there.**

### Shared builder

Add `packages/cadre-core/src/control-authorization.ts` as the one definition of the vector, so
the byte layout cannot drift between the two producers that exist today
(`control-database.ts:buildAuthorizationMessage`, which returns raw bytes, and
`peer-authorization.ts`, which returns base64url):

```ts
export type ControlDomain = `CadreControl.${ControlTable}` | 'Cadre.Enrollment';
export type ControlAction = 'add' | 'remove' | 'vouch';

/** The full ordered field vector a control-plane signature covers. */
export function controlAuthorizationFields(
  domain: ControlDomain,
  action: ControlAction,
  rowFields: string[],
): string[] {
  return [domain, action, ...rowFields];
}
```

`ControlTable` currently lives in `control-database.ts`; move it here and re-export, so
`peer-authorization.ts` does not have to import the module that pulls in Quereus, Optimystic and
libp2p. `buildAuthorizationMessage(domain, action, rowFields)` becomes a thin
`digest(controlAuthorizationFields(...), 'sha256', 'bytes')`; `cadrePeerVoucherDigest` /
`cadrePeerRemoveDigest` / `peerAuthorizationDigest` become the `'base64url'` equivalents.

No backwards compatibility: change every producer and every verifier together. An old signature
simply stops verifying, which is the intent.

### Party binding — deliberately out of scope

The source ticket asks whether the party identifier should be bound in too, so an approval
cannot be carried between two parties that share an owner key. **Not in this ticket, and not as
a follow-up ticket.** There is nowhere sound to bind it: the schema is one shared constant
string applied to every party (and a drift test pins it byte-for-byte against
`schemas/control.qsql`), and a party id supplied through write context is chosen by the writer,
so binding to it anchors nothing. A real fix needs a party-identity row in the control database
that the digests can subquery, which is a separate design.

Leave a `NOTE:` comment at the `OwnerKey.Authorized` site in **both** schema copies:

```
-- NOTE: the domain tag scopes an approval to a table and an action, not to a PARTY. Two
-- parties that share an owner key would accept each other's approvals. Fine today (each
-- party has its own owner key); if shared-owner multi-party ever ships, bind a party
-- identity row into these digests.
```

## Test requirements

New spec `packages/cadre-core/test/control-authorization-domain-separation.spec.ts` — for each
previously-colliding pair, sign an approval for one rule and assert the other refuses it **by
constraint name** (`expectConstraintFailure`, not a bare `rejects.toThrow()`):

- `ValidationKey` approval presented as an `OwnerKey` insert
- `OwnerKey` enrolment approval presented as a `ValidationKey` insert
- a stored `CadrePeer.VouchSig` presented as an `OwnerKey` insert
- an `OwnerKey` remove approval presented as a `CadrePeer` delete
- a `DeviceToken` insert approval presented as a `DeviceToken` delete
- a `FormationInvite` insert approval presented as a `FormationInvite` delete

Plus: extend `digest-variadic-parity.spec.ts` with a case carrying leading literal tag fields
(the TS side passes them as array elements, the SQL side as literal arguments — the parity that
makes this whole scheme work).

Suites that must stay green because they sign or assert these digests:
`control-ownerkey-self-authorization`, `control-authorization-binding`,
`control-cadrepeer-voucher-constraint`, `control-formation-invite`, `control-schema-drift`,
`device-token`, `device-token-registry`, `peer-authorization`, `peer-record`,
`peer-record-resolution`, `publish-strand`, `publish-formation-invite`, `seed-bootstrap`,
`cadre-node-authorized-surface`, `membership-connection-gater`, and the integration harness
signer in `packages/integration-tests/src/harness/test-network.ts`.

## TODO

### Phase 1 — pin the bug

- Write the reproducing test (sketch above) asserting a `ValidationKey` approval is refused as
  an `OwnerKey` insert; confirm it FAILS against the current schema before touching anything.

### Phase 2 — shared builder

- Add `src/control-authorization.ts` with `ControlDomain`, `ControlAction`, `ControlTable`
  (moved from `control-database.ts`), and `controlAuthorizationFields`.
- Re-point `buildAuthorizationMessage` at it and change its signature to
  `(domain, action, rowFields)`.
- Re-point `peerAuthorizationDigest` / `cadrePeerVoucherDigest` / `cadrePeerRemoveDigest` at it;
  `peerAuthorizationDigest` takes domain `'Cadre.Enrollment'`, action `'vouch'`.
- Export the new module from `src/index.ts`.

### Phase 3 — schema, both copies byte-identical

- `OwnerKey.Authorized`: insert → `('CadreControl.OwnerKey', 'add', new.Key, new.StampId)`;
  delete → `('CadreControl.OwnerKey', 'remove', old.Key, old.StampId)` (drop the trailing
  `'remove'`).
- `ValidationKey.Authorized`: `('CadreControl.ValidationKey', 'add', new.Key, new.StampId)`.
- `Strand.Authorized`: `('CadreControl.Strand', 'add', new.Id, new.Type,
  coalesce(new.MemberPrivateKey, ''), new.StampId)`.
- `CadrePeer`: insert and the owner branch of `AuthorizedUpdate` both →
  `('CadreControl.CadrePeer', 'vouch', new.PeerId, new.StampId)`; delete →
  `('CadreControl.CadrePeer', 'remove', old.PeerId, old.StampId)`.
- `DeviceToken`: split the single `AuthorizedInsert check on insert, delete` into
  `AuthorizedInsert` (on insert, `new.PeerId`, action `'add'`) and `AuthorizedDelete` (on
  delete, `old.PeerId`, action `'remove'`); owner branch of `AuthorizedUpdate` → action
  `'vouch'`. This closes the insert-replays-as-delete axis; the missing-nonce axis stays with
  `bug-devicetoken-authority-antireplay`.
- `FormationInvite`: split `AuthorizedAddOrRemove` into `AuthorizedInsert` (`new.*`, `'add'`)
  and `AuthorizedDelete` (`old.*`, `'remove'`), dropping the `coalesce(new, old)` pairs. Check
  first whether any writer deletes a `FormationInvite` — research found none in the repo.
- `FormationUsage.Authorized`: replace `digest(new.Token || new.Disclosure)` with
  `digest('CadreControl.FormationUsage', 'vouch', new.Token, new.Disclosure)` and find every
  validation-key signer to match.
- Self-signed branches: replace the `||`-concatenated single-field digests in
  `CadrePeer.AuthorizedUpdate` and `DeviceToken.AuthorizedUpdate` with tagged multi-field
  digests, and update `peer-record.ts:peerRecordSignedPayload` /
  `device-token.ts:deviceTokenSignedPayload` to match.
- Add the party-scope `NOTE:` comment at `OwnerKey.Authorized`.
- Keep `schemas/control.qsql` and `packages/cadre-core/src/control-schema.ts` byte-identical
  (`control-schema-drift.spec.ts` enforces this); lowercase SQL keywords.

### Phase 4 — writers

- `control-database.ts`: `insertStrand`, `insertValidationKey`, `insertFormationInvite`.
- `seed-bootstrap.ts`: `insertCadrePeerRow`, `removePeer`, `reauthorizePeer`,
  `insertSelfDeviceToken`, `deleteDeviceToken`.
- `packages/integration-tests/src/harness/test-network.ts` and any other harness signer.
- Update the `buildAuthorizationMessage` doc comment — it currently documents the untagged
  vector as the canonical construction, and that prose is what a future signer will copy.

### Phase 5 — validate

- New domain-separation spec green; every suite listed above green.
- `yarn lint`, `yarn typecheck`, `yarn test` in `packages/cadre-core`; then the integration
  harness build so the cross-package signer is proven to compile against the new signature.
- Update `docs/architecture.md` and `docs/STATUS.md` where they describe the authorization
  digest construction.

## Handoff honesty

Research is static analysis of the schema plus the four signing modules; every collision above
is read directly off the digest expressions and their producers. The live re-reproduction was
not re-run in this session (token budget), which is why Phase 1 exists — do not skip it.

<!-- resume-note -->
## Resume note (2026-07-29, run hit budget before any code change)

A prior implement run read every relevant source file and then hit its token budget BEFORE
touching the working tree. **No code, schema, or test changes were made** — start at Phase 1.
Verified facts, so the next run can skip re-discovery:

- The ticket's inventory of digest sites is accurate against the current sources; no
  discrepancies found in `schemas/control.qsql`, `control-schema.ts`, `control-database.ts`,
  `peer-authorization.ts`, `seed-bootstrap.ts`, `peer-record.ts`, or `device-token.ts`.
- Test harness helpers to model Phase 1 on, all in
  `packages/cadre-core/test/control-ownerkey-self-authorization.spec.ts`:
  `freshKeyPair`/`signAs` (~line 46-59), `rawInsertOwnerKey` (~line 88),
  `expectConstraintFailure` (~line 148, asserts by constraint NAME), `bootFreshParty`
  (~line 166 — confirms `CadreNode.getControlDatabase()` exists; boots
  `new CadreNode({ controlNetwork: { partyId, bootstrapNodes: [] }, profile: 'transaction' })`
  then `db.getDatabase()` for raw SQL). Each test boots its own node; 60s timeouts.
- `buildAuthorizationMessage(fields)` is `control-database.ts:88`; `ControlTable` union +
  `CONTROL_TABLES` set are `control-database.ts:124-142` (move both per Phase 2).
- Owner-key signing sites in `seed-bootstrap.ts`: `insertCadrePeerRow` signs voucher at
  ~line 342 (also persists VouchOwner/VouchSig), `insertSelfDeviceToken` ~367 and
  `deleteDeviceToken` ~387 both go through `signPeerAuthorization` (~406) →
  `peerAuthorizationDigest`, `removePeer` signs remove digest ~466, `reauthorizePeer` signs
  voucher ~526. Single private `signDigest` (~431) applies the owner key everywhere.
- Self-signed payload builders: `peer-record.ts:peerRecordSignedPayload` (line 53,
  `PeerId|Multiaddr|UpdatedAt` joined then single-field digest) and
  `device-token.ts:deviceTokenSignedPayload` (line 36, `PeerId|Platform|Token|UpdatedAt`).
  Both sign the base64url digest string (input encoding 'base64url'), unlike the owner
  writers which sign raw digest bytes — keep that distinction when re-pointing them.
- `digest-variadic-parity.spec.ts` has a `sqlVerify(fields, sig, key)` helper that builds
  variadic `digest(?, …, ?)` placeholders — the leading-literal-tag parity case is just
  `['CadreControl.X', 'add', ...rowFields]` through the same helper.
- `control-schema-drift.spec.ts` normalizes ONLY line endings / trailing whitespace, so the
  two schema copies must match to the character otherwise.
- `verifyPeerAuthorization` (peer-authorization.ts:62) is the offline `cadre enroll register`
  verifier — it must move to the `'Cadre.Enrollment'`/`'vouch'` tagged digest together with
  `signPeerAuthorization`, or enrollment breaks silently (verify returns false, no throw).

## Resume note 2 (2026-07-29, second run also hit budget before any code change)

This run re-read every source file listed above and confirmed the first resume note is
accurate in full. **Still no code, schema, or test changes — start at Phase 1.** Two runs have
now burned their whole budget on reading; the next run should START WRITING immediately (Phase 1
test first) and treat both resume notes as sufficient discovery — do not re-read the sources
up front, open them only when an edit needs exact surrounding text. Additional verified facts
beyond resume note 1:

- **`test-network.ts` likely needs NO code change.** Its two signers (`createStrand` ~line 111,
  `createInvitation` ~line 151) pass `signMessageEd25519` callbacks that sign whatever bytes
  `insertStrand` / `insertFormationInvite` build internally — the new domain/action tags ride
  through automatically. Only its doc comments (lines 26-33, 148-150) describe the untagged
  field vector and need prose updates. Same holds for any caller passing a sign-callback into
  `ControlDatabase` methods; the tag lands in exactly one place per table (the writer).
- Full referencer inventory (grep for the six digest-helper names), beyond files already in the
  `files:` header: `packages/cadre-core/src/cadre-node.ts`, `packages/cadre-core/src/types.ts`,
  `packages/cadre-core/src/strand-membership-writer.ts` (strand-side `signStrandPayload` —
  OUT of scope, different subsystem), and test suites
  `control-authorization-binding.spec.ts`, `peer-authorization.spec.ts`, `peer-record.spec.ts`,
  `device-token.spec.ts`, `membership-connection-gater.spec.ts`,
  `cadre-node-authorized-surface.spec.ts`, `control-ownerkey-self-authorization.spec.ts`
  (its local `enrollMessage`/`removeMessage` builders at lines 62-67 must gain the
  `'CadreControl.OwnerKey'`/`'add'|'remove'` tags and drop the trailing `'remove'`),
  `digest-variadic-parity.spec.ts` (helper `sqlVerify` confirmed at line 48; case (a) at
  line 57 signs the Strand shape and must gain the tags too, since
  `buildAuthorizationMessage`'s signature changes).
- `seed-bootstrap.ts` exact confirmed lines: `insertCadrePeerRow` private helper 322-352 (signs
  `cadrePeerVoucherDigest` at 342, single `db.exec` at 347 persists VouchOwner/VouchSig),
  `insertSelfDeviceToken` 366, `deleteDeviceToken` 386, `signPeerAuthorization` 406,
  `signDigest` 431, `removePeer` 450 (signs at 466), `reauthorizePeer` 502 (signs at 526).
  All owner signing funnels through `signDigest(digestB64url)` — signs the base64url digest
  STRING (input 'base64url'), while `control-database.ts` writers sign raw bytes from
  `buildAuthorizationMessage`; both decode to the same digest bytes, keep each side's encoding.
- Schema digest sites, `schemas/control.qsql` line numbers (control-schema.ts = same content
  offset +11 lines, wrapped in the `CONTROL_SCHEMA` template literal): OwnerKey insert 43,
  OwnerKey delete 49, ValidationKey 59, Strand 72, CadrePeer insert 104, delete 117,
  self-update 133, owner-update 139, DeviceToken insert/delete 161, self-update 173,
  owner-update 177, FormationInvite 196-204, FormationUsage validation branch 238
  (`digest(new.Token || new.Disclosure)`).
- **Unresolved discovery (only one left):** who produces the `ValidationSignature` context
  value for `FormationUsage` (the validation-key holder's signature over
  `Token || Disclosure`). `redeemInvitation` / `recordFormationUsage`
  (control-database.ts:756/823) just pass it through from params. Grep for
  `validationSignature` / `ValidationSignature` producers (likely strand-formation responder
  and/or a test) before retagging that digest in Phase 3.

## Resume note 3 (2026-07-29, third run hit budget MID-IMPLEMENTATION)

**Tree is partially migrated and currently does NOT typecheck** (two test files still call the
old `buildAuthorizationMessage(fields)` shape). Phases 1–3 are COMPLETE; Phase 4 is half done.
Do not redo earlier phases — pick up at "Remaining" below.

Done this run:

- **Phase 1 complete.** `packages/cadre-core/test/control-authorization-domain-separation.spec.ts`
  created with the ValidationKey→OwnerKey replay case (captures the shipped
  `insertValidationKey` signature, re-presents it as a raw OwnerKey insert). RAN against the
  pre-fix schema and FAILED as intended ("promise resolved instead of rejecting") — the
  escalation was reproduced live, then the schema was changed. The 5 remaining pairs from
  "Test requirements" still need adding to this spec.
- **Phase 2 complete** (minus index export). `src/control-authorization.ts` holds
  `ControlTable` (moved from control-database.ts), `ControlDomain`, `ControlAction`,
  `controlAuthorizationFields`. DESIGN DELTA vs the ticket: `ControlAction` gained a FOURTH
  member `'publish'` for the peer SELF-signed branches (`CadrePeer`/`DeviceToken`
  `AuthorizedUpdate` self branch) — 'add'/'remove'/'vouch' all denote owner-signed semantics
  and none fit a self-published record. Documented in the module.
- **Phase 3 complete, both copies byte-identical.** `schemas/control.qsql` fully retagged:
  every digest leads with (domain, action); OwnerKey delete dropped the trailing `'remove'`;
  DeviceToken single insert+delete constraint split into `AuthorizedInsert` ('add', new.PeerId)
  and `AuthorizedDelete` ('remove', old.PeerId); FormationInvite `AuthorizedAddOrRemove` split
  into `AuthorizedInsert` ('add', new.*) / `AuthorizedDelete` ('remove', old.*) with the
  coalesce(new,old) pairs dropped; FormationUsage → `digest('CadreControl.FormationUsage',
  'vouch', new.Token, new.Disclosure)`; self-update branches → `('CadreControl.CadrePeer',
  'publish', new.PeerId, new.Multiaddr, cast(new.UpdatedAt as text))` and
  `('CadreControl.DeviceToken', 'publish', new.PeerId, new.Platform, new.Token,
  cast(new.UpdatedAt as text))`; party-scope NOTE added above `OwnerKey.Authorized`.
  `control-schema.ts` was REGENERATED by wrapping the qsql body in the existing 11-line
  header + template literal (qsql contains no backticks/`${`; drift spec normalizes CRLF).
- **Phase 4 partial:**
  - `control-database.ts` DONE: `buildAuthorizationMessage(domain, action, rowFields)` now
    digests `controlAuthorizationFields(...)`; doc comment rewritten for the tagged vector;
    `ControlTable` moved out and re-exported together with `ControlDomain`/`ControlAction`;
    `insertStrand` / `insertValidationKey` / `insertFormationInvite` retagged;
    `insertFormationInvite` doc prose updated for the constraint split.
  - `peer-authorization.ts` DONE: private `taggedDigest` helper;
    `peerAuthorizationDigest` → `('Cadre.Enrollment', 'vouch', [peerId])`;
    `cadrePeerVoucherDigest` → `('CadreControl.CadrePeer', 'vouch', [peerId, stampId])`;
    `cadrePeerRemoveDigest` → `('CadreControl.CadrePeer', 'remove', [peerId, stampId])`
    (trailing `'remove'` field dropped); NEW `deviceTokenAddDigest` / `deviceTokenRemoveDigest`
    for the split DeviceToken constraints. The verify* functions needed no change (they call
    the retagged helpers).

Remaining (in order):

- `seed-bootstrap.ts`: `insertSelfDeviceToken` (~line 367) must sign
  `deviceTokenAddDigest(peerId)` and `deleteDeviceToken` (~387) `deviceTokenRemoveDigest(peerId)`
  instead of `signPeerAuthorization` — which is now enrollment-domain and will NOT verify
  against the DeviceToken constraints, so `device-token` / `device-token-registry` suites fail
  until this lands. Check remaining callers of `signPeerAuthorization` (`authorizePeer` per its
  old doc) — keep it only for the genuine enrollment vouch. Update both methods' doc comments
  (they still describe the shared single-field digest and "AuthorizedInsert gates insert AND
  delete").
- `peer-record.ts` `peerRecordSignedPayload` (~53): replace the `PeerId|Multiaddr|UpdatedAt`
  joined-string digest with
  `digest(controlAuthorizationFields('CadreControl.CadrePeer', 'publish', [peerId, multiaddr, String(updatedAt)]), 'sha256', 'base64url')`;
  update the module header + fn docs (they document the `'|'` concat as canonical).
- `device-token.ts` `deviceTokenSignedPayload` (~36): same, with
  `('CadreControl.DeviceToken', 'publish', [peerId, platform, token, String(updatedAt)])`; update docs.
- `src/index.ts`: export `control-authorization.js`.
- Tests: `control-ownerkey-self-authorization.spec.ts` `enrollMessage`/`removeMessage`
  (lines 62–67) → `buildAuthorizationMessage('CadreControl.OwnerKey', 'add'|'remove', [key, stampId])`
  — **typecheck currently fails here, fix first**; `digest-variadic-parity.spec.ts` case (a)
  (~57) → new signature, plus add the leading-literal-tag parity case (TS array elements vs SQL
  literal args); extend the domain-separation spec with the 5 remaining pairs (FormationInvite
  case can capture the shipped `insertFormationInvite` signature; the others build digests via
  the new helpers and raw SQL).
- `test-network.ts`: prose-only comment updates (lines 26–33, 148–150) — its sign-callbacks
  ride through unchanged.
- `docs/architecture.md` + `docs/STATUS.md` where they describe the authorization digest
  construction.
- Validate: `yarn lint`, `yarn typecheck`, `yarn test` in `packages/cadre-core` (all suites in
  "Test requirements"), then the integration-tests build.

Learnings (settled questions — do not re-research):

- FormationUsage validation-branch signer: NO in-repo producer. `signFormation` is an
  interface method (`strand-solicitation.ts:129`) implemented only by test mocks that never
  hit the schema, so the retag required no writer change.
- No writer deletes a `FormationInvite` (grep confirmed) — the AuthorizedDelete split
  orphans no caller.
- Phase 1 harness boots a `CadreNode` per test exactly like the ownerkey spec (~20 s a run).

## Resume note 4 (2026-07-29, fourth run hit budget MID-IMPLEMENTATION)

Phase 4 is now COMPLETE (all writers + all previously-broken test files migrated). Tree is
believed to typecheck — the last edits fixed every known `buildAuthorizationMessage` /
`inviteMessage` call-site mismatch, and a final grep confirmed no un-migrated
`inviteMessage({...})` calls remain — but NO validation command has been run this run
(budget). Pick up at "Remaining" below; run `yarn typecheck` in `packages/cadre-core` FIRST.

Done this run (in addition to resume note 3's list):

- `seed-bootstrap.ts` DONE: `insertSelfDeviceToken` now signs
  `signDigest(deviceTokenAddDigest(peerId))`, `deleteDeviceToken` signs
  `signDigest(deviceTokenRemoveDigest(peerId))`; `signPeerAuthorization` DELETED (its only
  callers were the two device-token methods; the genuine enrollment vouch is signed
  out-of-band and only VERIFIED in-repo, by `cadre-cli` enroll via `verifyPeerAuthorization`).
  Stale doc comments fixed: `insertCadrePeerRow`, `deleteDeviceToken` (no longer claims
  AuthorizedInsert gates delete), `removePeer` (tagged remove digest), `reauthorizePeer`
  (no longer cites `digest(peerId)`), `signDigest` helper list.
- `peer-record.ts` DONE: `peerRecordSignedPayload` digests
  `controlAuthorizationFields('CadreControl.CadrePeer', 'publish', [peerId, multiaddr, String(updatedAt)])`;
  module header rewritten (no more `'|'`-concat prose).
- `device-token.ts` DONE: `deviceTokenSignedPayload` →
  `('CadreControl.DeviceToken', 'publish', [peerId, platform, token, String(updatedAt)])`;
  header rewritten.
- `src/index.ts` DONE: exports `controlAuthorizationFields` + `ControlDomain`/`ControlAction`
  from `control-authorization.js`, and `deviceTokenAddDigest`/`deviceTokenRemoveDigest` from
  `peer-authorization.js`.
- `control-ownerkey-self-authorization.spec.ts` DONE: `enrollMessage`/`removeMessage` retagged
  (`'CadreControl.OwnerKey'` + `'add'`/`'remove'`, trailing `'remove'` field dropped).
- `digest-variadic-parity.spec.ts` DONE: case (a) retagged (Strand 'add' + action-swap
  negative), case (b) rewritten for the tagged multi-field peer-record payload, NEW case (d)
  pins TS-array-elements ⇔ SQL-literal-tag parity (`digest('CadreControl.OwnerKey', 'add', ?, ?)`
  with a wrong-domain negative). Header doc updated.
- `control-authorization-binding.spec.ts` DONE: every `buildAuthorizationMessage` call tagged
  (Strand/ValidationKey/OwnerKey); `inviteMessage` helper gained a leading
  `action: 'add' | 'remove'` param; all call sites pass `'add'` except the delete-branch test,
  whose forged + legitimate delete sigs now use `'remove'` (comment updated — the insert sig
  no longer satisfies the delete, by design).

Remaining (in order):

- Run `yarn typecheck` in `packages/cadre-core`; fix any leftover call-site drift (mid-run
  IDE diagnostics raced the edits, so trust the compiler, not the stale diagnostics).
- Extend `test/control-authorization-domain-separation.spec.ts` with the 5 remaining pairs
  from "Test requirements" (only ValidationKey→OwnerKey exists so far):
  OwnerKey-add→ValidationKey-add; stored `CadrePeer.VouchSig`→OwnerKey-add;
  OwnerKey-remove→CadrePeer-delete; DeviceToken-add→DeviceToken-delete
  (helpers `deviceTokenAddDigest`/`deviceTokenRemoveDigest` exist now);
  FormationInvite-add→FormationInvite-delete (capture the shipped `insertFormationInvite`
  signature, then present it to a raw delete — pre-split it WOULD have passed).
- Audit + fix the remaining suites that build payloads inline (likely assert old shapes):
  `peer-authorization.spec.ts` (line ~13 builds the enrollment digest inline — must gain the
  `'Cadre.Enrollment'`/`'vouch'` tags; line ~91 "inline authorizePeer construction" regression
  case likewise), `peer-record.spec.ts`, `device-token.spec.ts`, `device-token-registry.spec.ts`,
  `membership-connection-gater.spec.ts`, `cadre-node-authorized-surface.spec.ts`,
  `seed-bootstrap.spec.ts` — anywhere they hand-build digests instead of calling the helpers.
- `test-network.ts` (integration harness): prose-only comment updates (lines 26-33, 148-150
  describe the untagged vector); its sign-callbacks need no code change.
- `docs/architecture.md` + `docs/STATUS.md`: update authorization-digest prose.
- Validate: `yarn lint`, `yarn typecheck`, `yarn test` in `packages/cadre-core` (all suites in
  "Test requirements"), then `yarn build` in `packages/integration-tests`. Stream long
  commands through `tee`.
- Then write the review/ handoff and delete this ticket per stage rules.

Learnings this run:

- `signPeerAuthorization` removal is safe: grep showed its only callers were the two
  device-token writers; `peerAuthorizationDigest` itself stays (exported, used by
  `verifyPeerAuthorization` + cadre-cli enroll + its spec).
- `control-database.ts` already re-exports `ControlTable`/`ControlDomain`/`ControlAction`
  from `control-authorization.js` (line 16), so existing importers keep working.

## Resume note 5 (2026-07-29, fifth run hit budget — ALL CODE + TESTS WRITTEN, only docs + validation left)

`yarn typecheck` in `packages/cadre-core` PASSED at the start of this run (confirming resume
note 4's call-site fixes). Everything on note 4's "Remaining" list is now done EXCEPT the two
docs files and the validation commands. All edits this run were test files + harness prose +
one doc comment in `src/seed-bootstrap.ts`.

Done this run:

- **Domain-separation spec COMPLETE** — all 6 pairs from "Test requirements" now in
  `test/control-authorization-domain-separation.spec.ts`: (1) ValidationKey-add→OwnerKey-add
  (pre-existing, reproduced live pre-fix), (2) OwnerKey-add→ValidationKey-add,
  (3) stored `CadrePeer.VouchSig`→OwnerKey-add (reads VouchSig back off the replicated row),
  (4) OwnerKey-remove→CadrePeer-delete (expects `AuthorizedDelete`; then proves the sig
  genuine by running the real OwnerKey delete with it), (5) DeviceToken-add→DeviceToken-delete
  (then deletes with the proper 'remove'-tagged sig), (6) FormationInvite-add→
  FormationInvite-delete (captures the shipped `insertFormationInvite` signature).
  New helpers in the spec: `signB64` (signs base64url digest strings, for the
  peer-authorization helper digests) and `freshStamp`. NONE of the 5 new tests have been
  RUN yet — first validation task.
- `peer-authorization.spec.ts`: canonical-digest test now asserts the
  `('Cadre.Enrollment', 'vouch', peerId)` tagged digest; the inline-construction regression
  test rewritten — tagged inline construction verifies true AND the legacy untagged
  `digest([peerId])` construction verifies FALSE; `ownerSign` doc comment fixed (enrollment
  vouch is signed out-of-band, only verified in-repo).
- `device-token.spec.ts` + `peer-record.spec.ts`: payload tests assert the tagged multi-field
  vectors (`('CadreControl.DeviceToken', 'publish', peerId, platform, token, String(updatedAt))`
  / `('CadreControl.CadrePeer', 'publish', peerId, multiaddr, String(updatedAt))`) instead of
  the old pipe-joined single-field digests; titles/comments updated.
- Stale comment fixes: `control-ownerkey-self-authorization.spec.ts` (~407, tagged wording),
  `membership-connection-gater.spec.ts` (~135), `cadre-node-authorized-surface.spec.ts` (~48),
  `seed-bootstrap.spec.ts` (~1044, "signature over the tagged (PeerId, StampId) digest"),
  `src/seed-bootstrap.ts` `authorizePeer` doc ("Signs a membership voucher").
- `test-network.ts` (integration harness): both prose blocks updated — header now describes
  the domain-tagged vector; `createInvitation` comment lists the tagged FormationInvite
  fields (incl. StrandId) and cites `AuthorizedInsert` (constraint was renamed).
- Audited and found clean (no changes needed): `device-token-registry.spec.ts` (no digest
  builds), `control-authorization-binding.spec.ts` + `digest-variadic-parity.spec.ts`
  (note-4 edits confirmed in place).

Remaining (short — docs, then validation, then handoff):

- `docs/STATUS.md`: lines ~677-680 describe the CadrePeer voucher/remove digests UNTAGGED
  (`digest(peerId, stampId)` / `digest(peerId, stampId, 'remove')` — the 'remove' tail is
  now the action tag instead) and line ~697 cites `digest(PeerId, StampId)`. Update to the
  tagged forms; grep STATUS.md for other `digest(` prose while there.
- `docs/architecture.md`: line ~535 contrasts the strand `'|'`-join idiom with "the control
  layer's multi-field `buildAuthorizationMessage` digest" — still true, add "domain-tagged";
  line ~1147 (`cadre enroll register`) says "signature ... over the peer ID" — now the
  `('Cadre.Enrollment', 'vouch', peerId)` tagged digest; line ~502 also matched
  `buildAuthorizationMessage` and was NOT read this run — check it.
- Validate (nothing run since this run's edits): in `packages/cadre-core` run `yarn lint`,
  `yarn typecheck`, `yarn test 2>&1 | tee` (stream — full suite boots many CadreNodes);
  then build/typecheck `packages/integration-tests` for the harness file.
  Watch specifically: the 5 NEW domain-separation tests (raw SQL insert shapes for
  CadrePeer/DeviceToken were written from the schema, never executed) and the rewritten
  `peer-authorization.spec.ts` regression case.
- Then write the review/ handoff (distilled summary + "Handoff honesty" gaps: no backwards
  compat — old signatures stop verifying by design; party binding deliberately out of scope
  with the NOTE comment in both schema copies; nonce gaps stay with the sibling
  `bug-devicetoken-authority-antireplay` / `bug-strand-manager-authority-antireplay` /
  `bug-control-remove-then-replay-resurrection` tickets) and delete this ticket per stage rules.
