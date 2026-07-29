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
