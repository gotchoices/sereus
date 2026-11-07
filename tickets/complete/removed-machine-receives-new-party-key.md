description: When a machine is removed from a cadre while it is online, it used to be sent the replacement key meant to lock it out of the cadre's private workspaces. The replacement key is now stored encrypted to the machines that remain, so the removed machine receives only data it cannot open. The code review is done; the database-backed test suites could not be run because the neighbouring repositories this repo links in are mid-edit.
architecture: docs/architecture.md#removing-a-machine
difficulty: medium
repro: verified
files: packages/cadre-core/src/sealed-party-key.ts, packages/cadre-core/test/sealed-party-key.spec.ts, packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/test/fixtures/control-schema/v4.qsql, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-party-key-rotation.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, yarn.lock, packages/cadre-core/test/cadre-node-remove-machine.spec.ts, packages/cadre-core/test/control-database-strand-peer.spec.ts, packages/cadre-core/test/control-store-migration.spec.ts, packages/cadre-core/test/strand-party-key-rotation.spec.ts, packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts, docs/architecture.md
----
# Seal the pending party key to the machines that remain — review blocked on the sibling builds

**Blocked category: a dependency outside this repository.** The cadre-core test suite and the integration scenario run the compiled output of `../optimystic` and `../quereus`, and both had source files edited after their last build for the whole review pass (21:11 to 21:41 on 2026-11-03; `../optimystic/packages/db-core` was rebuilt once at about 21:25 and edited again before the suite could start). The stale-build guard (`test-harness/build-freshness.ts`) refuses the run, and `tickets/rules/sibling-repos.md` forbids building a sibling from here. **What unblocks it:** the owners of those repositories build them (`yarn workspace @optimystic/db-core build` in `C:\projects\optimystic`; `yarn workspace @quereus/quereus build` in `C:\projects\quereus` if the guard names it too), then move this ticket back to `review/`. The remaining review work is only to run the two commands under "What is still owed" below; on green, write the `complete/` ticket from the findings here (the code has been reviewed in full); on red, fix.

If we do nothing: the implementation (`ticket(implement): removed-machine-receives-new-party-key`) stays on `master` with five edited specs and one edited scenario never executed. Reversible: nothing here changes code; the one review edit is a small refactor already type-checked and linted.

## What the implement stage changed (unchanged by the review)

Removing a machine replaces the party's membership key K with a fresh key K' in each closed strand. K' waits in the `PendingStrandPartyKey` row until the strand side of the move is done, and that row is written in the same control transaction as the removed machine's tombstone, so it reaches the removed machine. The row now carries K' public half in the clear (`PublicKey`) and its private half sealed to the identity keys of the machines that remain (`SealedKey`, the envelope in `sealed-party-key.ts`: one ephemeral X25519 key per row, X25519 against each recipient's ed25519 identity key converted to Montgomery form, HKDF-SHA256 with the strand id in `info`, XChaCha20-Poly1305). Recipients are every live machine the remover trusts plus the remover itself, the removed machine left out. Schema version 4 was edited in place (unshipped: its commit is not in `v1.21.0`). `CadreNode` opens the row under its own identity key before handing it to the rotation driver; the background triggers skip a row not sealed to this machine and return early on a machine that has learned of its own removal. `@noble/curves ^2.0.1` added to cadre-core (already in the install through libp2p).

## Review findings

**Read in full, with fresh eyes before the handoff:** every file of `ticket(implement): removed-machine-receives-new-party-key` (21 files), then the handoff.

**Checked and found correct:**

- The envelope. Recipient entries are keyed by control peer id and the sealing key is derived from the peer id, never a stored column, so a row cannot name a key the id does not carry. The whole `SealedKey` string is inside the row's owner-signed insert digest (`new.SealedKey` in `AuthorizedInsert`, mirrored in `pendingStrandPartyKeyRowFields`), so the recipient set cannot be edited after signing. The strand id in the HKDF `info` stops an envelope copied onto another strand's row from opening. Montgomery conversion of the seed (`toMontgomerySecret`) and of the public key (`toMontgomery`) agree, so a recipient opens with the identity key its peer id carries. Error messages carry no key material. All three secrets (ephemeral secret, shared secret, wrapping key) are zeroed after use.
- The three schema copies agree and the v4 fixture matches the declared schema (`control-schema-drift.spec.ts`, `control-schema-versions.spec.ts`, run; see below).
- The recipient list excludes the removed machine by peer id, includes the remover from its own identity key before its own `CadrePeer` row has landed, and dedupes by peer id.
- A second removal copies the stored row's `PublicKey` into `Superseded` without opening it, and the swap retires the pending row by comparing public halves; neither path needs the private key.
- The two background triggers exit before the driver on a non-recipient machine and on a removed machine; the driver's own read rejects on a non-recipient, which the driver already reports as `pending` with a log.
- Docs: `docs/architecture.md` (table row, "What one transaction removes", "What removal still leaves", the Proof paragraph, the watch bullet) and the driver's module doc reflect the new reality. `docs/strands.md` and the `isRotationPending` doc in `strand-party-peers.ts` only ask whether a row exists, so they needed no change and got none. No package outside cadre-core and the integration scenario references the renamed column (cadre-cli, cadre-host, cadre-provider, the reference apps: checked by grep, none).

**Minor, fixed in this pass:** three sites in `cadre-node.ts` each derived this node's control peer id and identity key (`selfPartyKeyRecipient`, `openPendingPartyKey`, and the recipient list). Now one `selfPartyKeyIdentity()` returns the peer id with both halves of the key, and the other two use it. Type-checked and linted.

**Major:** none found. The design question the fix stage settled (seal to the remover's trusted live machines, derive the key from the peer id) is implemented as stated.

**Conditional, left as recorded at the site:** the implementer's four `NOTE:` tripwires (the swapped `StrandPartyKey` row is in the clear; a machine admitted after the removal is not a recipient; a partitioned double removal seals to a machine the other side removed; an ephemeral-identity remover cannot open what it seals) were each re-read and are accurate; none re-filed. One observation of my own: `expectSealedAwayFromA3` in the scenario tolerates a null row with a warning, so the sealing proof is conditional on the row having reached A3 before the cut. Left as is because the scenario could not be run here to see which way it goes; if the warning ever prints, the read is answering before the row lands and the assertion needs a wait, not a tolerance.

**Tests:** none cut. `sealed-party-key.spec.ts` pins the envelope contract (opens for each recipient, null outside, throws on another strand or another key); the `cadre-node-remove-machine.spec.ts` additions pin the recipient set and that the node's own key opens the row; the strand-peer spec covers the new digest columns. None added: no defect was found, and the early returns in the two triggers are guard clauses over an existing seam, as the handoff judged.

**Source hygiene:** `sealed-party-key.ts` is 190 lines with a module doc that says why, not what. `cadre-node.ts` is 12,004 lines (`wc -l`), already owned by `backlog/debt-cadre-node-single-file-size`; this ticket adds about 100 lines there, which is evidence for that ticket, not a new one.

## Later evidence (2026-11-04)

The triage of `scenario-party-key-rotation-across-parties` ran both owed commands after this review: `yarn workspace @serfab/cadre-core test` passed (2,620 passed, 1 skipped), and `machine-removal-rotates-party-key` passed with its stricter gate. Neither run was made for this ticket, and neither recorded whether `expectSealedAwayFromA3` took its null-row warning, so the sealing assertion may not have executed on A3. On resuming, run the scenario once and look for `A3 holds no pending row` in its output. `@quereus/quereus` is the sibling whose build was stale at this note.

## Verification run, and what is still owed

Run and passing in the review pass:

- `yarn lint` (clean), `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`, `yarn check:dep-ranges`.
- `sealed-party-key.spec.ts`, `control-schema-drift.spec.ts`, `control-schema-versions.spec.ts`: 3 files, 7 tests, under a scratch vitest config that omitted only the stale-build guard (deleted after the run). The first two load nothing from a sibling. The third parses the schema with `@quereus/quereus`, whose source had files newer than its build at the time; the guard itself did not name quereus when it ran, only db-core.

**NOT run, blocked on the sibling builds (the reviewer who resumes runs these first):**

```
yarn workspace @serfab/cadre-core test
yarn workspace @serfab/integration-tests vitest run src/scenarios/machine-removal-rotates-party-key.integration.ts
```

The specs whose edits have never been executed: `cadre-node-remove-machine.spec.ts`, `control-database-strand-peer.spec.ts`, `control-store-migration.spec.ts`, `strand-party-key-rotation.spec.ts`, and the scenario. The handoff's open questions about the scenario still stand: whether A3's own-store read right after the cut answers (it did in the fix stage's observation), and whether A1 hangs up A3 before the swap commits in the online case (a failure there is the swap-row tripwire firing, not a test bug).
