description: Two places in the code independently rebuilt the same "delete a row and record that it was retired" write; both now call the one shared helper, so a future fix to that logic only has to land once.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-membership-hub.spec.ts, packages/cadre-core/test/device-token-registry.spec.ts
difficulty: medium
----

# Review: `removePeer` / `deleteDeviceToken` folded into `ControlDatabase.deleteGuardedRow`

## What the change is

Removing a cadre peer, and clearing a device's push token, are both "owner-signed
delete plus a `Revocation` tombstone retiring the row's single-use stamp, in one
transaction". `ControlDatabase` already had that sequence factored out as
`deleteGuardedRow` (used by `deleteStrand` / `deleteValidationKey`).
`SeedBootstrapService.removePeer` and `.deleteDeviceToken` each hand-wrote it again.
Both now delegate.

Two files touched, no schema change, no behavior change intended.

### `packages/cadre-core/src/control-database.ts`

- `deleteGuardedRow` is now **public**, and its `table` param widened from
  `Extract<RevocableTable, 'Strand' | 'ValidationKey'>` to
  `Exclude<RevocableTable, 'OwnerKey'>` (the four tables with a delete path;
  `OwnerKey` only ever takes a genesis insert). Body unchanged.
- `inTransaction` went back to **private**. It was public solely so
  `SeedBootstrapService` could compose its own delete/tombstone pair; that caller is
  gone and a repo-wide grep for `.inTransaction(` finds only the two calls inside
  `ControlDatabase` itself. This is one step beyond the ticket's letter — see
  *Judgment calls* below.
- Doc comments retargeted: three `{@link SeedBootstrapService.removePeer}`
  "transaction shape mirrors…" references now point at `deleteGuardedRow` as the
  shared body, and `queryCadrePeerStampId` / `queryDeviceTokenStampId` no longer claim
  callers that no longer exist.

### `packages/cadre-core/src/seed-bootstrap.ts`

- `removePeer` keeps, in this order: the owner-key precondition, the
  `controlDatabase` null check, and the `queryCadrePeerStampId` absent-row gate. Only
  the signing + transaction body delegates, still wrapped in
  `mutateCadrePeer('peer-remove', …)`.
- `deleteDeviceToken` keeps the owner-key precondition and null check, then delegates
  fully — its own absent-row check is gone (`deleteGuardedRow` no-ops internally, and
  nothing here notifies).
- New private `signMessageBytes(message: Uint8Array)` adapts `deleteGuardedRow`'s
  raw-bytes signing callback to `signDigest`'s base64url-string form.
- New private `requireOwnerPublicKey()` — see *Judgment calls*.
- `cadrePeerRemoveDigest` / `deviceTokenRemoveDigest` / `revocationDigest` imports
  dropped (still exported from `peer-authorization.ts`, still used directly by
  `control-revocation-replay.spec.ts`).

## Judgment calls made (not in the ticket's design — check these first)

**`requireOwnerPublicKey()` was needed and is new surface.** The field
`ownerPublicKey` is typed `string | null` (a read-only service has no owner key), but
`deleteGuardedRow`'s `ownerKey` param is `string`. The old code passed
`this.ownerPublicKey` straight into `db.exec` parameter arrays, which are loosely
typed, so the nullability never had to be resolved. It does now. The new helper calls
`requireOwnerPrivateKey()` first (preserving the exact error and the
owner-key-before-DB-read ordering the unit tests assert), then rejects a null public
key. **Its second throw is unreachable** — the constructor derives the public key
whenever a private key is set — so `'Owner public key required to authorize peers'`
has no test and cannot get one without reaching into the constructor. A reviewer who
dislikes an unreachable throw could instead derive the public key eagerly into a
non-null field. Flagging it rather than defending it.

**`inTransaction` privatized.** Narrowing public API is beyond "fold two callers into
one helper". Justification: its doc comment's stated reason for being public was
exactly the duplication this ticket removes, so leaving it public would have left a
comment that lied. Zero external callers exist (the many `inTransaction` hits in
`test/` are each a spec-local helper function of the same name, not a method call).
If the reviewer wants the surface kept, reverting is a one-word change plus a doc
edit.

**`queryDeviceTokenStampId` is now dead.** `deleteDeviceToken` was its only caller and
no test uses it. Kept, as the `DeviceToken` member of a four-method public read set
whose three siblings *are* used by tests, with its doc reworded to say so. Legitimate
review outcomes: delete it, or add the missing test. Not silently left as a stale
comment.

## How to validate

Commands run, all green from `packages/cadre-core`:

```
yarn workspace @serfab/cadre-core typecheck     # exit 0
yarn workspace @serfab/cadre-core build         # exit 0
yarn lint                                        # (repo root) exit 0
yarn vitest run                                  # 71 files, 1094 passed, 1 skipped
```

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

The specific tests that carry this change's invariants — run these first if you touch
anything:

- **`test/control-membership-hub.spec.ts:128`** — *"does not notify when the removal
  target is already absent"*. The single most breakable thing here.
  `mutateCadrePeer` notifies whenever its body resolves, with no idea whether the body
  wrote a row, so `removePeer`'s absent-row gate **must** stay outside the delegated
  call. Simplify `removePeer` into a bare delegation and this test — and only this
  test — goes red.
- **`test/control-revocation-replay.spec.ts:1316`** — *"removePeer retires the stamp
  end to end (raw-bytes and digest-string signers agree)"*. Proves the schema's
  `Authorized` CHECK accepts a signature minted through the base64url-digest-string
  path (`removePeer` → `signDigest`) identically to one minted through the raw-bytes
  path (`deleteStrand`/`deleteValidationKey`). This is what `signMessageBytes` is
  keeping true. A failure here means the signing encodings diverged, not that a
  refactor detail slipped.
- **`test/seed-bootstrap.spec.ts:992` / `:998`** — owner-key error precedes the
  control-DB error, both before any DB read. Pins the precondition ordering in both
  `removePeer` and (by the same shape) `deleteDeviceToken`.
- **`test/seed-bootstrap.spec.ts:1037`** — real-node insert → delete → re-insert
  round trip, asserting the stamp lands in `CadreControl.Revocation`.
- **`test/device-token-registry.spec.ts:226`** — *"clears the token (owner delete);
  subsequent resolve is null"*, including a second `clearDeviceToken()` as a no-op.
  This is what covers `deleteDeviceToken`'s absent-row path now that its own early
  check is gone. Note the guard it exercises is partly `CadreNode.clearDeviceToken`'s
  own row check (`cadre-node.ts:2448`), not only `deleteGuardedRow`'s — the helper's
  internal no-op is reached directly only via
  `CadreNode.pruneDeviceTokens`/`deleteDeviceToken` on an absent peer, which has no
  dedicated test. **Coverage gap, honestly a floor not a ceiling.**
- **`test/control-authorization-binding.spec.ts`** + the `Strand` /
  `ValidationKey` deleter tests in `control-revocation-replay.spec.ts` — the
  pre-existing `deleteGuardedRow` callers, confirming the type/visibility change did
  not disturb them.

## Known gaps

- **No new tests were written.** The change is a behavior-preserving fold and the
  existing suite already pins every invariant it could break, so the suite is the
  regression net. That means: nothing new covers `deleteGuardedRow` being *reached*
  with `'CadrePeer'` / `'DeviceToken'` on an absent row, and nothing covers
  `requireOwnerPublicKey`'s second branch. If the reviewer wants belt-and-braces, a
  test asserting zero membership notifications when `deleteGuardedRow('CadrePeer', …)`
  is invoked directly on an absent row would lock the §2 reasoning to the helper
  rather than to `removePeer`'s caller.
- **Concurrent-removal race, recorded as a tripwire not a ticket.** `removePeer` now
  reads the stamp twice (its own gate, then `deleteGuardedRow`'s). A peer removed by
  another writer between the two reads no-ops silently *and still notifies*, where
  before it no-op'd without notifying. Narrow — it needs two concurrent owner-device
  removals of the same peer — and it mirrors the caveat `deleteGuardedRow`'s own doc
  comment already carries about its stamp read sitting outside the transaction. Parked
  as a `NOTE:` at the `mutateCadrePeer` call site in `seed-bootstrap.ts:558`. No
  locking added.
- **Second SELECT per removal.** `removePeer` reads the stamp, then
  `deleteGuardedRow` reads it again. Deliberate (the gate must precede
  `mutateCadrePeer`), cheap, and the alternative — threading the already-read stamp
  into `deleteGuardedRow` — would let a caller sign over a stamp the helper never
  verified. Left as is.
- **Log lines changed.** `deleteDeviceToken` no longer emits
  `'Device token removed (owner-signed, stamp retired): %s'`; it now emits
  `deleteGuardedRow`'s `'%s deleted: %s (stamp retired)'`. `removePeer` keeps its own
  bracketing lines *and* gains the helper's. Nothing asserts on log output, but anyone
  grepping production logs for the old `DeviceToken` string will come up empty.
