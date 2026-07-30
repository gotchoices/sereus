description: Two files independently rebuild the same "owner-signed delete plus a retirement record" write for removing a peer or a device token; merge them onto the one existing helper so a future fix to that logic only has to land in one place.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-membership-hub.spec.ts
difficulty: medium
----

# Fold `removePeer` / `deleteDeviceToken` into `ControlDatabase.deleteGuardedRow`

## Status check first (read before touching anything)

The transaction-shape half of the original ticket is **already done**: both
`SeedBootstrapService.removePeer` and `SeedBootstrapService.deleteDeviceToken`
(`packages/cadre-core/src/seed-bootstrap.ts`) already call the public
`ControlDatabase.inTransaction(label, body)` helper — neither hand-rolls
begin/commit/rollback any more. That landed in an earlier ticket
(`debt-membership-gate-hub-writers`). Don't re-do it.

What's still duplicated is the *contents* of the transaction: read the row's
current `StampId`, sign a `'remove'`-tagged digest over it, sign a second
`'CadreControl.Revocation'`-tagged digest, then in one transaction delete the
row and insert the `Revocation` tombstone. `ControlDatabase` already has this
exact shape factored out as a private helper, `deleteGuardedRow` (currently
used by `deleteStrand` / `deleteValidationKey`), at
`packages/cadre-core/src/control-database.ts:851`. `removePeer`
(`seed-bootstrap.ts:518`) and `deleteDeviceToken` (`seed-bootstrap.ts:434`)
each still hand-write that same sequence for `CadrePeer` and `DeviceToken`.

This ticket folds those two into `deleteGuardedRow` — the "Better" option from
the original plan. Design below is resolved; no open questions for you to
decide.

## Design

### 1. Widen `deleteGuardedRow` and make it public

`packages/cadre-core/src/control-database.ts:851-888`. Today:

```ts
private async deleteGuardedRow(
  table: Extract<RevocableTable, 'Strand' | 'ValidationKey'>,
  keyColumn: GuardedKeyColumn,
  keyValue: string,
  ownerKey: string,
  signMessage: (message: Uint8Array) => string
): Promise<void>
```

Change the `table` param type to `Exclude<RevocableTable, 'OwnerKey'>` (the
four tables that actually have a delete path — `Strand`, `ValidationKey`,
`CadrePeer`, `DeviceToken`; `OwnerKey` only ever gets a genesis insert, never a
delete) and drop `private` so `SeedBootstrapService` can call it directly —
same visibility change `inTransaction` already got for the same reason (see
its doc comment at `control-database.ts:898` for the precedent). Update the
method's doc comment to name the two new callers and drop the
`Strand`/`ValidationKey`-only framing.

No signature changes beyond the `table` type: `keyColumn` (`GuardedKeyColumn`
= `'Key' | 'Id' | 'PeerId'`) already covers `CadrePeer`/`DeviceToken`'s
`'PeerId'`, and `signMessage: (message: Uint8Array) => string` is unchanged.

### 2. `removePeer` — delegate, but keep the no-notify-on-absent gate

`removePeer` currently does its own no-op check (row absent → log + return,
*before* touching `mutateCadrePeer`) and this must stay **outside** the
delegated call, not fold into it. Reason: `control-membership-hub.spec.ts`
has a test — `'does not notify when the removal target is already absent'`
(`packages/cadre-core/test/control-membership-hub.spec.ts:128`) — asserting
zero membership-listener notifications when `removePeer` targets a peer with
no row. `mutateCadrePeer` notifies unconditionally once its body resolves
without throwing (it has no idea whether the body actually wrote anything),
so if the outer absent-row check is removed and `deleteGuardedRow`'s *own*
internal absent-row check (which no-ops silently) is the only guard left,
calling `removePeer` on an absent peer would still fire a spurious
notification — a real regression, not a style nit.

So: keep `removePeer`'s existing `requireOwnerPrivateKey()` (first line) and
existing `queryCadrePeerStampId` no-op gate exactly as they are today. Only
the signing + transaction body (the part after the gate) delegates:

```ts
await this.controlDatabase.mutateCadrePeer('peer-remove', () =>
  this.controlDatabase!.deleteGuardedRow(
    'CadrePeer', 'PeerId', peerId, this.ownerPublicKey,
    message => this.signMessageBytes(message),
  ));
```

(`deleteGuardedRow` will re-read the `StampId` itself — a second, cheap
SELECT. That's fine; it's the same benign race window `deleteGuardedRow`'s
own doc comment already discusses ("stamp read is outside the transaction"),
just now also reachable from `removePeer`. If it fires, `deleteGuardedRow`
no-ops internally and `mutateCadrePeer` still notifies — an extremely narrow
concurrent-removal edge case, not the common "remove an absent peer" case the
test above covers. Leave a `NOTE:` comment at the call site rather than
engineering it away.)

Delete the now-dead `cadrePeerRemoveDigest` / `revocationDigest` calls and
the local `signature` / `revocationSignature` consts from `removePeer`'s body.

### 3. `deleteDeviceToken` — delegate fully

No `mutateCadrePeer` wrap needed here (`DeviceToken` doesn't feed the
membership snapshot), so this one is a straight swap: keep
`requireOwnerPrivateKey()` first, then delegate the rest (stamp read through
transaction) straight to `deleteGuardedRow`:

```ts
await this.controlDatabase.deleteGuardedRow(
  'DeviceToken', 'PeerId', peerId, this.ownerPublicKey,
  message => this.signMessageBytes(message),
);
```

`deleteGuardedRow`'s own absent-row no-op replaces the method's existing
early `queryDeviceTokenStampId` check — safe to delete that check entirely
since there's no notify side effect riding on it here (unlike `removePeer`).

### 4. Shared signing adapter

Both call sites need the same adapter from `deleteGuardedRow`'s raw-bytes
`signMessage` callback shape to `SeedBootstrapService`'s base64url-string
`signDigest`. Factor one private method instead of writing the lambda twice:

```ts
/** Adapts deleteGuardedRow's raw-bytes signMessage callback to signDigest's base64url-string form. */
private signMessageBytes(message: Uint8Array): string {
  return this.signDigest(uint8ArrayToString(message, 'base64url'));
}
```

`uint8ArrayToString` is already imported in `seed-bootstrap.ts:2`.

This is intentionally still a *different code path* than
`deleteStrand`/`deleteValidationKey`'s callers, which sign raw bytes directly
— that's on purpose and tested (see Edge cases below), not something to
unify further.

### 5. Dead imports / doc cleanup

Once both methods delegate, `cadrePeerRemoveDigest`, `deviceTokenRemoveDigest`,
and `revocationDigest` (imported at `seed-bootstrap.ts:26` from
`./peer-authorization.js`) become unused in this file — remove them from the
import list (they're still exported from `peer-authorization.ts` and used
directly by `control-revocation-replay.spec.ts`, so don't touch that file).
Update the `{@link ...}` references to these three in nearby doc comments
(`signDigest`'s doc at `seed-bootstrap.ts:482-487`, `removePeer`'s doc at
`seed-bootstrap.ts:499-517`, `deleteDeviceToken`'s doc at
`seed-bootstrap.ts:416-433`) so they don't point at dead call sites — describe
the delegation to `ControlDatabase.deleteGuardedRow` instead.

## Edge cases & interactions

- **No-notify-on-absent-peer invariant** (see Design §2) —
  `control-membership-hub.spec.ts:128` ("does not notify when the removal
  target is already absent") must still pass unchanged. This is the one
  behavior that's easy to accidentally break by over-simplifying the
  delegation.
- **Owner-key-first ordering** — `seed-bootstrap.spec.ts:992` ("requires an
  owner private key") and `:998` ("requires the control database to be
  initialized") assert `removePeer` throws on those preconditions *before*
  any DB read. Keep `requireOwnerPrivateKey()` (and the `controlDatabase`
  null check) as the first lines of both `removePeer` and `deleteDeviceToken`
  — do not move them behind the delegated call.
- **Dual signing-encoding coverage** — `control-revocation-replay.spec.ts:1316`
  ("removePeer retires the stamp end to end (raw-bytes and digest-string
  signers agree)") exists specifically to prove the schema's `Authorized`
  CHECK accepts a signature produced via the base64url-digest-string path
  (`removePeer`, through `signDigest`) equally to one produced via the
  raw-bytes path (`deleteGuardedRow`'s other callers, `deleteStrand`/
  `deleteValidationKey`). The adapter in Design §4 preserves this — `signDigest`
  still does the real `sign(...)` call with `'base64url'` input encoding, only
  the TS-level plumbing changes. If this test starts failing, the encoding
  equivalence broke, not just a refactor detail.
- **Concurrent removal race** — see the `NOTE:` called out in Design §2: a
  peer removed by another writer between `removePeer`'s outer stamp check and
  `deleteGuardedRow`'s inner one now surfaces as a silent no-op-with-notify
  instead of no-op-without-notify. Narrow, pre-existing-shape race (mirrors
  `deleteGuardedRow`'s own documented caveat); leave the `NOTE:` in place
  rather than adding new locking.
- **`deleteStrand` / `deleteValidationKey` must not regress** — they already
  call `deleteGuardedRow`; only its type signature and visibility change, not
  its body, so their behavior should be untouched. Re-run
  `control-revocation-replay.spec.ts`'s `'deleteValidationKey retires the
  stamp end to end'` and the `Strand` equivalent to confirm.

## TODO

- Widen `deleteGuardedRow`'s `table` param to `Exclude<RevocableTable,
  'OwnerKey'>` and make the method public; update its doc comment.
- Add `SeedBootstrapService.signMessageBytes` private adapter method.
- Rewrite `removePeer` to keep its existing owner-key/absent-row gate, then
  delegate the signed delete + tombstone to `mutateCadrePeer(() =>
  controlDatabase.deleteGuardedRow('CadrePeer', 'PeerId', ...))`.
- Rewrite `deleteDeviceToken` to keep `requireOwnerPrivateKey()` first, then
  delegate fully to `controlDatabase.deleteGuardedRow('DeviceToken',
  'PeerId', ...)`.
- Remove now-dead `cadrePeerRemoveDigest` / `deviceTokenRemoveDigest` /
  `revocationDigest` imports from `seed-bootstrap.ts` and update the doc
  comments that referenced them.
- Run `yarn workspace @serfab/cadre-core test` (or the package's vitest
  config) — in particular `seed-bootstrap.spec.ts`,
  `control-revocation-replay.spec.ts`, `control-membership-hub.spec.ts` —
  and `yarn workspace @serfab/cadre-core typecheck`/`lint` if separate from
  the root scripts.
