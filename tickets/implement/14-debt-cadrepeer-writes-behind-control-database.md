---
description: Nothing stops future code from adding or removing a party member by writing the database table directly, which quietly skips the security bookkeeping that admits that member's traffic. Move the last two direct writes behind the one API that does the bookkeeping, and add a lint rule so the direct route fails the build.
prereq: debt-membership-gate-coalescing-refresh
files:
  - packages/cadre-core/src/control-database.ts (add `insertCadrePeer` + `reauthorizeCadrePeer` beside `deleteCadrePeer`; `mutateCadrePeer`, `queryStampId`, `buildAuthorizationMessage`, `execWrite` are the pieces to reuse)
  - packages/cadre-core/src/seed-bootstrap.ts (`insertCadrePeerRow` ~line 374, `reauthorizePeer` ~line 610 — the two SQL statements that move; `removePeer` ~line 557 already delegates and does not change)
  - eslint.config.mjs (new `no-restricted-syntax` block + its two test-file exemptions)
  - packages/cadre-core/test/control-authorization-domain-separation.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts (raw-SQL constraint fixtures — stay as-is, get lint exemptions)
  - packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/control-membership-hub.spec.ts (existing coverage that must stay green)
difficulty: medium
---

# Close the direct-SQL route to the party-member table

## Background

Each node keeps an in-memory snapshot of the peers it believes are approved party
members, and refuses inbound control-database traffic from anyone not in it. The
snapshot is rebuilt on write, not read live, so **every** write to
`CadreControl.CadrePeer` must trigger that rebuild or the node denies the traffic of the
member it just approved.

`ControlDatabase.mutateCadrePeer(reason, body)` is the wrapper that does the triggering:
it takes the write lock, runs the body, asserts the body committed, then notifies the
membership listener. Every production writer already goes through it. What is missing is
that a writer can *not* go through it and nothing complains — `getDatabase().exec('insert
into CadreControl.CadrePeer …')` compiles, lints, and runs. That mistake has been made
twice already.

Two production statements still sit outside `control-database.ts`, in
`SeedBootstrapService`:

| site | statement | today |
| --- | --- | --- |
| `insertCadrePeerRow` | owner-vouched `insert into CadreControl.CadrePeer …` | wraps its own `mutateCadrePeer` and `getDatabase().exec` |
| `reauthorizePeer` | voucher-rewriting `update CadreControl.CadrePeer …` | same |

The delete already lives on the class (`ControlDatabase.deleteCadrePeer` →
`deleteGuardedRow`) and does not change.

## What to build

### Phase 1 — move the two statements onto `ControlDatabase`

Add two methods next to `deleteCadrePeer`, matching the shape the class already uses for
owner-signed writes (`insertStrand`, `insertValidationKey`, `deleteStrand`): the caller
supplies the owner public key and a `signMessage: (message: Uint8Array) => string`
callback, and the method builds the digest itself via `buildAuthorizationMessage`.

```ts
/** Owner-vouched membership INSERT. Returns false when the in-lock existence
 *  check found the row already seated (the loser of a legitimate first-row race). */
insertCadrePeer(
  row: {
    peerId: string;
    publicKey: string | null;
    multiaddr: string;
    updatedAt: number;
    sig: string | null;
  },
  ownerKey: string,
  signMessage: (message: Uint8Array) => string,
): Promise<boolean>;

/** Owner re-touch of an existing membership row (write-while-alone re-replication):
 *  bump UpdatedAt and rewrite VouchOwner/VouchSig. Returns false when no row exists. */
reauthorizeCadrePeer(
  peerId: string,
  updatedAt: number,
  ownerKey: string,
  signMessage: (message: Uint8Array) => string,
): Promise<boolean>;
```

Bodies are the existing ones, relocated verbatim:

- **`insertCadrePeer`** — mint `stampId = generateStampId(row.peerId)` (keep the peer id
  as the input, *not* the local node's peer id: that is what the current code does), sign
  `buildAuthorizationMessage('CadreControl.CadrePeer', 'vouch', [peerId, stampId])`, then
  `mutateCadrePeer('peer-insert', …)` around: in-lock existence check via the private
  `queryStampId('CadrePeer', peerId)` → `false` when present; otherwise the eight-column
  insert with `VouchOwner`/`VouchSig` persisted equal to the context pair → `true`.
- **`reauthorizeCadrePeer`** — read the row's current `StampId` *before* taking the lock
  (as today), return `false` when null **without** notifying, else sign the same
  `'vouch'` digest over `(peerId, stampId)` and `mutateCadrePeer('peer-reauthorize', …)`
  around the `update … set UpdatedAt, VouchOwner, VouchSig where PeerId = ?`.

Both bodies run **inside** the write lock, so they must use bare `this.db!.exec`, never
`execWrite` — the lock is not re-entrant and re-entry hangs silently (see the NOTE on
`withWriteLock`).

Reuse the raw-bytes digest builder (`buildAuthorizationMessage`), *not* an import of
`peer-authorization.ts`. `cadrePeerVoucherDigest` is the base64url twin of the same field
vector and `control-revocation-replay.spec.ts` already pins that both encodings produce
the same signed bytes, so a signature minted either way satisfies the same schema CHECK.
Keep `control-database.ts` free of the `peer-authorization.ts` import it does not have today.

Move the security rationale comments (voucher digest, stamp anti-replay, race
idempotence, the `VouchOwner` rebinding NOTE on the re-touch) with the code; leave a short
pointer in `SeedBootstrapService` rather than duplicating them.

### Phase 2 — thin the `SeedBootstrapService` callers

`insertCadrePeerRow` and `reauthorizePeer` keep only what is genuinely theirs: the
owner-key precondition, the `signMessageBytes` adapter, and the derivation of the row
fields (`ed25519PublicKeyB64FromPeerId`, comma-joined multiaddrs). Both then delegate.

**Preserve the existing error precedence exactly** — there is unit coverage on it:

- `insertCadrePeerRow`: control-database-missing check **first**
  (`'Control database not initialized'`), owner-key check second. Today the owner-key
  error surfaces from `signDigest` after the DB check; calling `requireOwnerPublicKey()`
  before the DB check would flip the order.
- `reauthorizePeer`: owner-key check **first** (`requireOwnerPrivateKey()`), DB check
  second — the order it has today.

`removePeer` is unchanged: it already delegates to `deleteCadrePeer`, and its pre-delete
absent-row gate (which exists so an already-absent peer does not fire a spurious
membership notification) stays where it is.

`mutateCadrePeer` **stays public**. `control-membership-hub.spec.ts` drives it directly
against a real `ControlDatabase` to pin the commit-boundary asserts, and the
membership-gate test fakes declare it structurally. Leaving it public is not the hole —
the failure mode is a writer *forgetting* the wrapper, not one calling it.

### Phase 3 — make the direct route fail lint

Moving the statements does not remove `getDatabase()`, so add the machine check the
ticket exists for: a `no-restricted-syntax` block in `eslint.config.mjs` that flags
`CadrePeer` write SQL wherever it is not allowed.

- Match both string forms: `Literal[value=/…/]` (plain-string SQL, as the specs use) and
  `TemplateElement[value.raw=/…/]` (backtick SQL, as the source uses).
- Pattern: case-insensitive `insert into CadreControl.CadrePeer`,
  `update CadreControl.CadrePeer`, `delete from CadreControl.CadrePeer` (escape the dot).
- Message: name `ControlDatabase.insertCadrePeer` / `reauthorizeCadrePeer` /
  `deleteCadrePeer` as the route, and say why (the membership snapshot refresh).
- Exempt, via a later `files:`-scoped override that turns the rule off:
  `packages/cadre-core/src/control-database.ts` (the destination),
  `packages/cadre-core/test/control-authorization-domain-separation.spec.ts` and
  `packages/cadre-core/test/control-revocation-replay.spec.ts` (fixtures that drive raw
  SQL against a bare database on purpose — they test the constraints, not membership).
  Comment each exemption with its reason so the list stays reviewable.

Note in the config comment that this catches literal SQL only: SQL assembled from
variables slips through. That is fine — the rule targets the copy-paste mistake that has
actually happened twice, not a determined bypass.

### Phase 4 — docs

`docs/STATUS.md` and `docs/architecture.md` describe the membership/voucher rules; update
any line that names `SeedBootstrapService` as the home of the `CadrePeer` insert/update
so it points at `ControlDatabase`. Update the `{@link SeedBootstrapService.insertCadrePeerRow}`
reference in `peer-authorization.ts`'s `verifyCadrePeerVoucher` doc. Do not add a new doc file.

## Edge cases & interactions

- **Absent row on re-touch must not notify.** `reauthorizeCadrePeer` on a peer with no
  row returns `false` and the membership listener is never called. A test that counts
  listener invocations is the check.
- **Insert race, both orderings.** Two writers racing the same peer's first row (the
  node's own background self-publish vs. a foreground `authorizePeer` of its own id): the
  loser's in-lock existence check must see the winner's committed row and return `false`
  without touching it — voucher, addresses and self-`Sig` unchanged. `seed-bootstrap.spec.ts`
  already covers both orderings; it must stay green.
- **Notify fires after commit, once per write.** `assertCommitBoundary` must not trip from
  the relocated bodies. Confirm neither body opens a transaction and that neither calls
  `execWrite` or another locked public method from inside the lock (silent permanent hang).
- **Throwing body does not notify.** An insert that fails the schema CHECK (bad signature,
  revoked stamp) propagates and leaves the snapshot untouched.
- **Error precedence.** Keyless service and uninitialized-DB cases each raise the message
  they raise today, in the order stated in Phase 2 — one test per method.
- **Voucher round-trips.** A row inserted through the new method must verify under
  `verifyCadrePeerVoucher(peerId, stampId, ownerKey, vouchSig)`; a row re-touched must
  verify under the rewritten `VouchOwner`. This is what proves the raw-bytes digest and
  the base64url digest agree in the moved code.
- **Removal still tombstones.** `removePeer` → `deleteCadrePeer` behaviour is unchanged;
  re-run the revocation/replay specs to confirm the move did not perturb the shared
  `deleteGuardedRow` path.
- **Lint rule does not misfire.** `yarn lint` clean after the exemptions; and deliberately
  pasting a `CadrePeer` insert into an unexempted file must error (verify once by hand,
  then revert — do not commit a fixture for it).

## Not in scope

The signing, digest, and trust-policy logic itself, and the write-lock / notify
mechanics. Behaviour must be identical afterwards — this is about where the statements
live and what stops a new one appearing elsewhere.

## TODO

- Add `insertCadrePeer` to `ControlDatabase`, beside `deleteCadrePeer`, with the relocated
  body and its security rationale comments.
- Add `reauthorizeCadrePeer` to `ControlDatabase`, preserving the pre-lock stamp read and
  the no-row/no-notify early return.
- Rewrite `SeedBootstrapService.insertCadrePeerRow` and `reauthorizePeer` as thin
  delegating wrappers, keeping today's error precedence in each.
- Confirm no `CadrePeer` insert/update/delete statement remains outside
  `control-database.ts` other than the two constraint-test fixtures.
- Add the `no-restricted-syntax` rule and its three scoped exemptions to `eslint.config.mjs`,
  each commented with its reason.
- Update `docs/STATUS.md`, `docs/architecture.md`, and the `peer-authorization.ts` doc link
  where they name the old home of these writes.
- Run `yarn lint`, `yarn build`, and the `cadre-core` unit suite (`seed-bootstrap.spec.ts`,
  `control-membership-hub.spec.ts`, `control-revocation-replay.spec.ts`,
  `control-authorization-domain-separation.spec.ts` in particular); stream output with
  `2>&1 | tee` so the runner's idle timer does not expire.
- Hand off to `review/` noting whether the lint rule was verified to fire on a
  deliberately misplaced statement.
