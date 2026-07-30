description: Four places that delete a protected row and record that it was retired now share one implementation instead of four hand-written copies, so a future fix to that logic only has to land once.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/control-membership-hub.spec.ts, packages/cadre-core/test/device-token-registry.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, docs/architecture.md
difficulty: medium
----

# Complete: every guarded delete shares one body behind four named methods

## What shipped

Removing a cadre peer, clearing a device's push token, deleting a strand, and deleting a
validation key are all the same write: an owner-signed `delete`, plus a
`CadreControl.Revocation` tombstone permanently retiring that row's single-use `StampId`,
both in ONE transaction. Without the tombstone the stamp frees up and the original
never-expiring approval (which the removed party holds a copy of) can re-seat the row.

`ControlDatabase.deleteGuardedRow` is now the only implementation of that sequence.
`SeedBootstrapService.removePeer` / `.deleteDeviceToken` had each hand-written it against
the raw `Database` handle; both now delegate.

Public surface, after review (see *Review findings* for why it differs from the
implement-stage shape):

| method | table | notes |
| --- | --- | --- |
| `ControlDatabase.deleteStrand(strandId, ownerKey, signMessage)` | `Strand` | pre-existing |
| `ControlDatabase.deleteValidationKey(key, …)` | `ValidationKey` | pre-existing |
| `ControlDatabase.deleteCadrePeer(peerId, …)` | `CadrePeer` | new — wraps `mutateCadrePeer` |
| `ControlDatabase.deleteDeviceToken(peerId, …)` | `DeviceToken` | new |

`deleteGuardedRow` and `inTransaction` are both **private**. No caller outside
`ControlDatabase` composes a multi-statement control transaction any more.

Behavior-preserving throughout: no schema change, no digest change, no signature-encoding
change. `SeedBootstrapService` keeps what is genuinely its own — the owner-key
precondition, the control-DB null check, and `removePeer`'s absent-row gate — and a new
private `signMessageBytes` adapts the raw-bytes `signMessage` callback to `signDigest`'s
base64url-string form (both encodings sign identical bytes; pinned by an existing test).

## Review findings

Read the implement diff (`git show e977951`) before the handoff summary, as required.
The implementation was correct — the delegated digests are byte-identical to the
hand-written ones (`buildAuthorizationMessage('CadreControl.<T>', 'remove', [key, stamp])`
matches `cadrePeerRemoveDigest` / `deviceTokenRemoveDigest`; the tombstone matches
`revocationDigest`), and the full suite passed as claimed. What follows is what it
overlooked.

### Fixed in this pass (minor)

- **`(table, keyColumn)` was an unguarded pair on a public method.** The implement stage
  made `deleteGuardedRow(table, keyColumn, keyValue, …)` public. Nothing in the types
  linked the two: `deleteGuardedRow('DeviceToken', 'Id', peerId, …)` compiled and would
  have emitted `select StampId from CadreControl.DeviceToken where Id = ?` at runtime.
  Every guarded table has exactly one primary key, so the pair was redundant as well as
  unsafe. Now derived from a single `GUARDED_KEY_COLUMN` map
  (`control-database.ts:196`), which also removed the mapping's eight repetitions across
  `queryStampId`'s four wrappers and the deleters. The `keyColumn` parameter is gone.
- **The generic method did not belong on the public surface.** `ControlDatabase` already
  exposed *named* deleters (`deleteStrand`, `deleteValidationKey`); publishing a generic
  `deleteGuardedRow` broke that symmetry and pushed table names into callers. Added
  `deleteCadrePeer` / `deleteDeviceToken` as thin named wrappers and made
  `deleteGuardedRow` private again. Callers now cannot pass a table name at all.
- **The `mutateCadrePeer` membership-notify wrapper sat in the wrong place.** It was in
  `SeedBootstrapService.removePeer`, so any future `CadrePeer` remover could forget it —
  against `mutateCadrePeer`'s own documented "EVERY `CadrePeer` writer goes through here"
  contract. Moved inside `ControlDatabase.deleteCadrePeer`. Exactly equivalent
  (gate → notify(delete) either way), but now unforgettable.
- **A doc comment asserted something false.** `deleteGuardedRow`'s `table` type excludes
  `OwnerKey`, justified as "`OwnerKey` only ever takes a genesis insert, never a delete."
  Wrong: `control-schema.ts:86` has an `OwnerKey` `'remove'` branch (requiring a
  *different* owner as signer) and `control-revocation-replay.spec.ts` drives it with
  hand-rolled SQL. The accurate reason — no *production* owner-key removal path exists
  yet, and the body would need no change when one lands — now stands in its place. The
  exclusion itself was kept: widening adds untested surface with no caller.
- **Two session-relative / stale comments.** `inTransaction`'s "Private *again* now
  that…" narrated the refactor rather than the code; rewritten timelessly.
  `control-revocation-replay.spec.ts:1313` described the signer encodings in terms of
  `deleteGuardedRow`, which callers can no longer see; retargeted at the named deleters.
- **`docs/architecture.md:192`** listed the guarded deletes that write a `Revocation` row
  as `removePeer` / `deleteStrand` / `deleteValidationKey`, omitting the device-token
  clear, and predated the shared body. Both corrected. No other doc described this
  surface — `docs/STATUS.md:237` states the *invariant* (a clear must retire its stamp in
  the same transaction), which is unchanged and still accurate.

### Test coverage added

The implement stage wrote no new tests and said so plainly; the two gaps it named were
real and are now closed. Both were reachable-today paths, not speculation.

- **`test/control-membership-hub.spec.ts`** — *"notifies even for an absent row when the
  delete is driven directly"*. The existing sibling test proves `removePeer` stays quiet
  for an already-absent peer; nothing proved *why*. This drives `deleteCadrePeer`
  directly and asserts it DOES notify on a no-op — so the quiet provably comes from
  `removePeer`'s stamp gate, and a future reader cannot "simplify" that gate away
  believing the delete covers it. Also asserts nothing was retired, so the no-op is a
  true no-op on disk.
- **`test/device-token-registry.spec.ts`** — *"clearing a token that was never published
  is a no-op, with nothing retired"*. `deleteDeviceToken` lost its own absent-row check;
  the only existing coverage went through `CadreNode.clearDeviceToken`, which has a row
  check of its own, so the shared gate was never actually exercised on this table. Drives
  the service directly.

Both count stamps before/after rather than asserting zero — these suites share one
control DB across their tests.

### Tripwires recorded, not ticketed

- **Concurrent-removal notify.** `removePeer` reads the stamp twice (its gate, then the
  shared body). A peer removed by a second writer in between no-ops silently yet still
  notifies. Needs two concurrent owner-device removals of the same peer; parked as a
  `NOTE:` at the gate in `seed-bootstrap.ts` (the implement stage put it at the old
  `mutateCadrePeer` call site; it moved with the code it describes). The
  `deleteGuardedRow` doc already carries the matching caveat about its stamp read sitting
  outside the transaction.
- **Second SELECT per peer removal.** Kept deliberately: the gate must precede the
  notify, and threading an already-read stamp into the shared body would let a caller
  sign over a stamp the body never verified. Cheap, and documented at the call site.

### Checked and found clean

- **Digest / signature equivalence** across all four tables, including the base64url vs.
  raw-bytes signer split — the pre-existing *"raw-bytes and digest-string signers agree"*
  test covers it and still passes.
- **Precondition ordering** (owner key before control-DB check, both before any DB read)
  preserved in both service methods; `seed-bootstrap.spec.ts:992`/`:998` pin it.
- **Repo-wide callers.** No consumer outside `cadre-core` touched
  `deleteGuardedRow`/`inTransaction` (both were public for less than one commit), so
  narrowing them broke nothing; repo-wide `yarn typecheck` confirms.
- **`queryDeviceTokenStampId` was dead** (its only caller was the code that got folded
  away). It now has a caller: the new device-token test asserts through it. Its doc no
  longer claims users it did not have. Kept rather than deleted — a real assertion is
  worth more than a removed line.

### Not fixed, deliberately

- **`requireOwnerPublicKey`'s second throw is unreachable** (the constructor derives the
  public key whenever a private key is set) and its message says "…to authorize peers"
  even on the device-token path. Left as is: it is a defensive guard resolving a genuine
  `string | null`, it is documented as unreachable, and its wording deliberately matches
  its sibling `requireOwnerPrivateKey`, whose message tests pin. Changing one and not the
  other would be worse than the current mild imprecision.
- **Log-line text changed** by the fold: `deleteDeviceToken` no longer emits
  `'Device token removed (owner-signed, stamp retired): %s'` — the shared body emits
  `'%s deleted: %s (stamp retired)'` instead. Nothing asserts on log output. Recorded
  here so anyone grepping production logs for the old string knows why it vanished.

## Validation

All from a clean tree, all green:

```
yarn workspace @serfab/cadre-core typecheck   # exit 0
yarn workspace @serfab/cadre-core build       # exit 0
yarn typecheck            # (repo root, all workspaces) exit 0
yarn lint                 # (repo root) exit 0
yarn vitest run           # (packages/cadre-core) 71 files, 1096 passed, 1 skipped
```

1096 passing vs. 1094 at implement — the two added tests, no regressions. The one skip is
pre-existing and unrelated. No pre-existing failures surfaced;
`tickets/.pre-existing-error.md` not written.

## No follow-up tickets

Nothing found warranted one. Every defect was a small, contained fix applied here; the
two conditional concerns are tripwires by the letter of the rule (fine now, only matter
under concurrency this system does not yet do); and the coverage gaps were closable in
this pass rather than deferrable.
