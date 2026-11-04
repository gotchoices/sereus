description: When a machine is removed from a cadre while it is online, it is sent the replacement key meant to lock it out of the cadre's private workspaces, so a tampered copy of the app on a stolen phone could use that key to get back in. Store the replacement key encrypted to the machines that remain, so the removed machine receives only data it cannot open.
prereq: scenario-machine-removal-rotates-party-key
architecture: docs/architecture.md#removing-a-machine
difficulty: hard
repro: verified
files: packages/cadre-core/src/sealed-party-key.ts (new), packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/test/fixtures/control-schema/v4.qsql, packages/cadre-core/src/control-authorization.ts (`pendingStrandPartyKeyRowFields`), packages/cadre-core/src/control-database.ts (`removeMachine`, `signPendingPartyKeyReplacements`, `signPendingStrandPartyKeyInsert`, `insertPendingStrandPartyKey`, `readStoredPendingPartyKey`, `queryPendingStrandPartyKey`, `swapStrandPartyKeys`), packages/cadre-core/src/types.ts (`PendingStrandPartyKeyRow`), packages/cadre-core/src/cadre-node.ts (`removeMachine`, `partyKeyRotation` deps, `driveRotationIfPending`, `driveTrackedPendingRotations`), packages/cadre-core/src/strand-party-key-rotation.ts, packages/cadre-core/package.json, packages/cadre-core/test/cadre-node-remove-machine.spec.ts, packages/cadre-core/test/control-database-strand-peer.spec.ts, packages/cadre-core/test/control-store-migration.spec.ts, packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts, docs/architecture.md, docs/strands.md
----
# Seal the pending party key to the machines that remain

Removing a machine replaces the party's membership key K with a fresh key K' in each closed strand, so the removed machine is left holding a key that no longer counts. K' waits in `PendingStrandPartyKey.PrivateKey` until the strand side of the move is done. That row is written in the same control transaction as the machine's tombstone, and the machine being removed ends up with it in its own store, in the clear.

## Reproduction

Ran in the fix stage's source ticket, in `machine-removal-rotates-party-key.integration.ts` (A1 the owner, A2 stopped, A3 online and being removed), straight after `owner.removeMachine(a3MachineId)`:

```ts
const a1Pending = await owner.getControlDatabase()!.queryPendingStrandPartyKey(strandId);
await owner.stop();
const a3Pending = await a3Node.getControlDatabase()!.queryPendingStrandPartyKey(strandId);
```

Observed in one run: A3 held no control connections, `a3Pending` was not null, and `a3Pending.privateKey` equalled `a1Pending.privateKey`. A1 was stopped before this read, so the answer came from A3's own store. An earlier run with A1 still up showed the same key on A3, and A3's `StrandPartyKey` still naming K.

Not re-run at this stage: the stale-build guard refused the suite because `../quereus` was being edited (`@quereus/quereus: dist is stale`). If the guard still reports a stale sibling when you run the scenario, `tickets/rules/sibling-repos.md` applies: do not build it, and record that the proof is blocked on the sibling's build.

## Decision: encrypt the key, do not try to withhold the row

The row can arrive by two paths that were never separated: the commit itself, since the machine is still in the control cohort when the transaction commits, or a background read on the machine before the cut. Sealing closes both, so the fix does not need to tell them apart.

Each recipient gets K' encrypted to its machine identity key, in one envelope stored on the row:

- **Who can open it:** every live machine this node trusts, plus this node, minus the machine being removed. Which machines hold an owner key is not recorded anywhere, so all of them are recipients. A machine without an owner signer opens nothing today, and `plan/party-key-rotation-across-parties` wants its reconciler to read the pending key.
- **Identity key, not owner key:** an owner signer exposes `sign` and no way to decrypt, and a removed machine holding an owner key could open anything sealed to that key.

The four constraints from `docs/architecture.md` → "Removing a machine" hold without change, because the row is still written in the same transaction:

- The tombstone never arrives without the pending signal. The membership reconciler's `isRotationPending` only asks whether a row exists, and never needs to open it.
- Any recipient owner machine can resume after a crash, and two owner machines open the same K' and converge on it.
- A removal is still one owner approval, and the swap a second.
- `Superseded` handling stays. An earlier pending key was legitimately sealed to a machine a later removal removes, so its seat may still need revoking.

### Rejected alternative: write K' in a second transaction after the cut

The removal transaction would carry a row with no key, and K' would follow once the machine is hung up. Rejected for three reasons:

- It relies on timing across machines. A sibling that lags on the tombstone keeps serving the removed machine, and could hold the K' row before it holds the tombstone.
- A crash between the two transactions loses K', so the next driver needs a further owner approval to mint another.
- A removed machine that holds an owner key is still not stopped.

## Interfaces

Schema version 4 is not in the latest tag (`v1.21.0`), so edit it in place: the table in `control-schema.ts`, `schemas/control.qsql` and `test/fixtures/control-schema/v4.qsql`, with no version raise. Re-check first with `git merge-base --is-ancestor 1607354c <latest tag>`. If v4 has shipped since, its fixture is frozen and a rename or dropped column is refused, so stop and rethink the column change rather than editing the fixture.

```sql
table PendingStrandPartyKey (
    Id text primary key,    -- the strand id
    PublicKey text,         -- K' public half (base64url). In the clear so a second removal can list it in Superseded without opening the row.
    SealedKey text,         -- the envelope below
    Superseded text null,
    StampId text unique,
    -- AuthorizedInsert digest: new.Id, new.PublicKey, new.SealedKey, coalesce(new.Superseded, ''), new.StampId
    ...
```

```ts
// sealed-party-key.ts: pure functions, no node or database dependency.
export interface PartyKeyRecipient { peerId: string; publicKeyB64: string }

export function sealPartyKey(privateKey: string, strandId: string, recipients: readonly PartyKeyRecipient[]): string;

/** The plain key, or null when `self` is not a recipient. Throws on an entry that does not open (altered row or wrong strand). */
export function openPartyKey(sealed: string, strandId: string, self: { peerId: string; privateKeyB64: string }): string | null;

/** The peer ids the envelope is sealed to. */
export function partyKeyRecipients(sealed: string): string[];

export interface PendingStrandPartyKeyRow {
  publicKey: string;
  sealedKey: string;
  superseded: string[];
  stampId: string;
}
```

**Envelope:** JSON `{ v: 1, eph, to: { <peerId>: { nonce, sealed } } }`, in the style of `owner-key-export.ts`, with these steps:

- One ephemeral X25519 key per envelope.
- Per recipient, `x25519.getSharedSecret` with `ed25519.utils.toMontgomery(recipientPublicKey)`.
- The wrapping key is HKDF-SHA256 over that secret, salted with the ephemeral public key and with the strand id in `info`.
- K' is sealed with XChaCha20-Poly1305 under a random nonce.

A throwaway script run at this stage confirmed that a recipient opens this construction through `ed25519.utils.toMontgomerySecret(seed)`, and that another key is refused with `invalid tag`. Take the recipient's public key from the peer id (`ed25519PublicKeyB64FromPeerId`), never from a stored column.

**Cost:** one X25519 operation for the ephemeral key plus one per recipient, per strand. `packages/cadre-rn/src/noise-crypto.ts` records 57.65 ms per shared secret on a Galaxy S7. Opening happens only when a driver runs.

**The driver keeps its plain-key shape.** `StrandPartyKeyRotationDeps.readPending` still hands it `{ privateKey, superseded, stampId }` under a new type name, and `CadreNode` opens the row with `getSelfSigningKey()` before handing it over. A row this machine cannot open rejects, which the driver already reports as `pending` with a log. The specs in `strand-party-key-rotation.spec.ts` then need only the type name.

**`swapStrandPartyKeys`** compares the stored pending row to `newKey` by public half (`pending.publicKey === strandMemberKeyPair(entry.newKey).publicKeyB64`).

**`signPendingPartyKeyReplacements`** reads `stored.publicKey` for `Superseded`, so a remover that cannot open the stored row can still replace it.

## The removed machine that holds an owner key

The source ticket's third arm: `driveRotationIfPending` and `driveTrackedPendingRotations` check for an owner signer but not whether this machine was removed, and `bindMachines` always adds the machine's own strand peer id. Sealing closes it for the row written by this removal. One case remains: a machine that was a legitimate recipient of an earlier pending key, removed by a later removal, and not yet synced to the replacement. So both drive functions also return early when `removedFromCadre()` is not null, as the owner re-issue drains already stop. They also skip a row not sealed to this machine, so the watch does not log a failure on every change.

## Limits to record, not fix here

Record each as a `NOTE:` at the named site, and index them in the handoff:

- **The swap row holds K' in the clear.** Once the swap runs, `StrandPartyKey.PrivateKey` is K' and replicates as it always has, so a new machine can read it. Reasoned from the code and not run: the removed machine could receive it only from a sibling that holds the swap but not yet the tombstone. The source ticket's run saw A3 stay on K. The scenario below asserts this. Parking site: `swapStrandPartyKeys`, plus a clause in "What removal still leaves". Revisit if the assertion ever fails or such a sibling is observed. Sealing `StrandPartyKey` itself would mean re-sealing for each new machine at admission.
- **A machine admitted after the removal is not a recipient.** An owner machine enrolled during a pending rotation cannot drive it, and an owner machine that can must finish it. Parking site: the `CadreNode` read seam. Revisit if a party is seen stuck that way. The remedy is the replacement path a second removal already uses.
- **A partition can seal to a removed machine.** Two owners removing different machines while partitioned each seal to the machine the other removed, and the row that survives the merge names it. Parking site: `signPendingPartyKeyReplacements`, beside the existing partition sentence in "What removal still leaves".
- **No identity key on the remover.** A node with an ephemeral identity (tests only, per `cadre-node.ts` near line 2932) cannot open what it seals. Seal to the others and log it. Do not refuse the removal, since locking out a stolen phone must not fail on this.

## TODO

- Add `@noble/curves` to `packages/cadre-core/package.json` (`^2.0.1`, as the other packages declare) and run `yarn install`, then check that Metro still resolves it for `cadre-rn`.
- Write `sealed-party-key.ts` and export what the scenario needs (`partyKeyRecipients`) from the package root.
- Add one small spec for it: a recipient opens, a non-recipient gets null, and the wrong strand id throws.
- Change the table in all three schema files, the digest in `pendingStrandPartyKeyRowFields` and its SQL mirror, and the table comment. Make sure `yarn` schema checks and `control-schema-versions.spec.ts` agree.
- Change `ControlDatabase`: `PendingPartyKeyEntry` carries the public half and the envelope, the stored and queried row types change, and `insertPendingStrandPartyKey` takes the same fields.
- In `CadreNode.removeMachine`, build each envelope from `readMachines` (`isSelf || trusted`, not the target). Keep generating K' before `service.removeMachine`, as today.
- Wire `readPending` to open the row. Add the two early returns to the drive functions.
- Update the specs that read or write the row: `cadre-node-remove-machine.spec.ts` (lines 284 to 297), `control-database-strand-peer.spec.ts` (lines 81 to 103), `control-store-migration.spec.ts` (line 182), and any others `yarn workspace @serfab/cadre-core test` turns up, including read-count budgets such as `control-founding-consult-budget.spec.ts`.
- In the `machine-removal-rotates-party-key` scenario, derive `newMemberKey` from `pending.publicKey`, and have `awaitSwapOn` compare public halves in the offline case. No test reads K' from the pending row any more.
- Add the regression to the scenario:
  - In the offline case, right after the removal, read A3's pending row. When it is present, assert that K' does not appear in any of its columns and that `partyKeyRecipients` includes A1 and A2 and excludes `a3MachineId`.
  - In both cases, after the cut, assert that A3's `StrandPartyKey` public half is still `oldMemberKey`.
- Remove the scenario header's "Not proved here" paragraph.
- Update the docs:
  - `docs/architecture.md`, the `PendingStrandPartyKey` table row near line 40: sealed key and clear public half.
  - "What one transaction removes": the row holds the fresh key sealed to the remaining machines.
  - "What removal still leaves": remove the sentence naming this ticket, and add the swap-row and partition limits.
  - The "Proof" paragraph.
  - `strand-party-key-rotation.ts` module doc, "Where the new key lives before it is current".
  - `docs/strands.md` needs no change unless it states the key is in the clear.
- Run `yarn lint`, the cadre-core tests, and the scenario.
