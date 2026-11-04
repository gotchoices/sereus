description: When a machine is removed from a cadre while it is online, it used to be sent the replacement key meant to lock it out of the cadre's private workspaces. The replacement key is now stored encrypted to the machines that remain, so the removed machine receives only data it cannot open.
architecture: docs/architecture.md#removing-a-machine
difficulty: hard
repro: verified
files: packages/cadre-core/src/sealed-party-key.ts (new), packages/cadre-core/test/sealed-party-key.spec.ts (new), packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/test/fixtures/control-schema/v4.qsql, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-party-key-rotation.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, yarn.lock, packages/cadre-core/test/cadre-node-remove-machine.spec.ts, packages/cadre-core/test/control-database-strand-peer.spec.ts, packages/cadre-core/test/control-store-migration.spec.ts, packages/cadre-core/test/strand-party-key-rotation.spec.ts, packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts, docs/architecture.md
----
# Seal the pending party key to the machines that remain

Removing a machine replaces the party's membership key K with a fresh key K' in each closed strand. K' waits in the `PendingStrandPartyKey` row until the strand side of the move is done, and that row is written in the same control transaction as the removed machine's tombstone, so it reaches the removed machine. Before this ticket the row carried K' in the clear. Now the row carries K' public half in the clear and its private half sealed to the identity keys of the machines that remain, so the removed machine holds a row it cannot open.

## What changed

**New module `sealed-party-key.ts`** (pure functions, exported from the package root): `sealPartyKey(privateKey, strandId, recipients)`, `openPartyKey(sealed, strandId, self)` (the key, null when `self` is not a recipient, a throw when the entry does not open), `partyKeyRecipients(sealed)`. Envelope: JSON `{ v: 1, eph, to: { <peerId>: { nonce, sealed } } }`. One ephemeral X25519 key per envelope; per recipient, X25519 against the recipient's ed25519 identity key converted to Montgomery form; HKDF-SHA256 salted with the ephemeral public key and with `sereus:pending-party-key:v1:<strandId>` as info; XChaCha20-Poly1305 under a random nonce. Recipients are keyed by control peer id and the key sealed to is derived from the peer id (`CadreMachine.publicKey`), never a stored column. `@noble/curves ^2.0.1` added to cadre-core's dependencies (already in the install through libp2p).

**Schema version 4, edited in place** (it has not shipped: `1607354c` is not in `v1.21.0`, checked with `git merge-base --is-ancestor`). `PendingStrandPartyKey.PrivateKey` is replaced by `PublicKey` (K' public half, base64url, in the clear) and `SealedKey` (the envelope). The `AuthorizedInsert` digest is `new.Id, new.PublicKey, new.SealedKey, coalesce(new.Superseded, ''), new.StampId`, mirrored in `pendingStrandPartyKeyRowFields`. The same text in `control-schema.ts`, `schemas/control.qsql` and the `v4.qsql` fixture.

**`ControlDatabase`.** `PendingPartyKeyEntry` and `insertPendingStrandPartyKey` take `{ publicKey, sealedKey }` (`SealedPendingPartyKey` in `types.ts`); `queryPendingStrandPartyKey` returns `PendingStrandPartyKeyRow { publicKey, sealedKey, superseded, stampId }`. A second removal lists the stored row's `publicKey` in `Superseded` without opening it. `swapStrandPartyKeys` retires the pending row when its public half is the new key's.

**`CadreNode`.** `removeMachine` reads the machines once (`planRemovalAmong` is the plan over a list already read), builds the recipient list (`pendingPartyKeyRecipients`: every live machine this node trusts plus this node from its own identity key, the removed machine left out) and mints one sealed entry per strand (`mintPendingPartyKey`). The rotation driver's `readPending` is now `openPendingPartyKey`, which opens the row under this machine's identity key and rejects when the row is not sealed to it or the node has an ephemeral identity; the driver reports such a strand `pending` with a log, as before for any failed read. The two background triggers (`driveRotationIfPending`, `driveTrackedPendingRotations`) return early on a machine that has learned of its own removal (`removedFromCadre()`), and skip a row not sealed to this machine (`isPendingPartyKeyRecipient`) so the watch does not log a failed run on every change.

**Driver.** `StrandPartyKeyRotationDeps.readPending` hands the driver `OpenedPendingPartyKey { privateKey, superseded, stampId }`, the same shape as before under a new name; the driver's logic is unchanged.

**Docs.** `docs/architecture.md`: the table row, "What one transaction removes", "Who drives", "What removal still leaves" (the sentence naming this ticket replaced by the swap-row and partition limits), the Proof paragraph, and the party key watch bullet. `strand-party-key-rotation.ts` module doc, "Where the new key lives before it is current" and "One run". `docs/strands.md` did not state the key was in the clear, so it is unchanged.

## Tripwires recorded as `NOTE:` (index; the analysis is at each site)

- **The swap row holds K' in the clear.** `ControlDatabase.swapStrandPartyKeys`: the swapped `StrandPartyKey` row replicates as it always has; the removed machine could receive it only from a sibling holding the swap but not yet the tombstone. The scenario asserts the removed machine stays on K. Revisit if that assertion fails or such a sibling is observed.
- **A machine admitted after the removal is not a recipient.** `CadreNode.pendingPartyKeyRecipients`: an owner machine enrolled during a pending rotation cannot drive it. Revisit if a party is seen stuck that way; the remedy is the replacement a second removal already writes.
- **A partition can seal to a removed machine.** `ControlDatabase.signPendingPartyKeyReplacements`, with a clause in "What removal still leaves".
- **An ephemeral-identity remover cannot open what it seals.** `CadreNode.pendingPartyKeyRecipients`: seals to the others and logs; never a refusal.

## Tests

Added or changed, each beside what it verifies:

- `sealed-party-key.spec.ts` (new, one test): a recipient opens; a second recipient opens the same key; a machine outside the envelope gets null; another strand id throws; a recipient's entry under another machine's key throws; the plain key is not a substring of the envelope.
- `cadre-node-remove-machine.spec.ts` (changed): the pending row's public half differs from the current key's; recipients include the node and the machine that stays and exclude the removed one; the node's own identity key opens the row and the opened key's public half matches `publicKey`; the second removal's `Superseded` is the first row's `publicKey`.
- `control-database-strand-peer.spec.ts` (changed): the insert takes the new shape and the replayed-approval refusal covers the new digest columns.
- `control-store-migration.spec.ts`, `strand-party-key-rotation.spec.ts` (changed): the new insert shape and the new type name only.
- `machine-removal-rotates-party-key.integration.ts` (changed): the offline case derives the new member key from `pending.publicKey` and reads A3's own copy of the pending row: it names A1 and A2 and not A3, A3's identity key does not open it, and no column decodes as a private key whose public half is K'. Both cases assert after the cut that A3's `StrandPartyKey` still names K. `awaitSwapOn` compares public halves, so no test reads K' from the pending row. The header's "Not proved here" paragraph is replaced by what the scenario now proves.

## Verification run, and what is still owed

Run and passing:

- `yarn workspace @serfab/cadre-core typecheck` (sources and tests), `yarn workspace @serfab/cadre-core build`, then `yarn workspace @serfab/integration-tests typecheck`.
- `yarn lint` (clean), `yarn check:dep-ranges`.
- `sealed-party-key.spec.ts`, `control-schema-drift.spec.ts` and `control-schema-versions.spec.ts`, run under a scratch vitest config that omits only the stale-build guard, because those three load nothing from the sibling the guard named (`@quereus/quereus` was fresh at that point; see below). The schema specs prove the three schema copies agree and the v4 fixture matches the declared schema.
- `yarn workspace @serfab/cadre-rn vitest run --project polyfills` (33 tests, the Metro resolver spec among them) and `yarn workspace @serfab/reference-app-rn vitest run --project polyfills` (the dependency-globals drift guard). `@noble/curves` was already in every React Native bundle through `@libp2p/crypto`, so nothing new resolves.

**Blocked on a sibling's build, not run:** the stale-build guard refused the cadre-core suite throughout this stage, first naming `@quereus/quereus` and then `@optimystic/db-core` (`../optimystic` has uncommitted edits in progress). Per `tickets/rules/sibling-repos.md` neither was built from here. So these were NOT run and the reviewer should run them first:

```
yarn workspace @serfab/cadre-core test
yarn workspace @serfab/integration-tests vitest run src/scenarios/machine-removal-rotates-party-key.integration.ts
```

The specs whose edits are unexercised: `cadre-node-remove-machine.spec.ts`, `control-database-strand-peer.spec.ts`, `control-store-migration.spec.ts`, `strand-party-key-rotation.spec.ts`, and the scenario. The read-count budgets (`control-founding-consult-budget.spec.ts`) should be unaffected: the table's collections are unchanged, and `removeMachine` still reads the machines once.

## Known gaps and things to look at

- **The scenario's read of A3's own store.** `expectSealedAwayFromA3` reads A3's control database right after the removal, when A3's control connections are already hung up. The source ticket observed such a read answering from A3's store; if it instead hangs or throws on the cut machine, the assertion needs a timeout or a tolerant read. A null row is tolerated (the cut came before the row reached A3) with a warning.
- **`expectA3StaysOnOldKey` in the online case** relies on A1 hanging up A3 before the swap commits (the refresh runs from the removal's notification; the swap follows several strand transactions). A flake there would be the swap-row tripwire firing, not a test bug.
- **`trusted` as the recipient filter.** A live machine whose proof is not anchored on the remover is not a recipient. That is the design the fix ticket chose; the unit spec relies on an invitation-admitted machine being trusted on the remover, which the existing `listMachines` assertions in the same spec already assume.
- **No test for the removed-machine early returns** in the two drive functions, or for the non-recipient skip; both are a guard clause over an existing seam and were judged not to pay for a test. The reviewer may disagree.
- **Error text.** `openPendingPartyKey`'s rejections are logged by the driver as "left unfinished (retried on the next trigger)"; on a non-recipient machine the removal's own drive is the only path to that log, since the triggers ask first.
