description: Founding a strand writes its control-database rows (the strand row, the party's membership key and, when the app invites at once, the invitation) as up to three separate commits and two owner approvals, and re-reads rows it just wrote; write them in one transaction under one approval and carry the values forward instead of re-reading.
architecture: docs/architecture.md#strand-membership-bootstrap
files: packages/cadre-core/test/publish-strand.spec.ts, packages/cadre-core/test/cadre-node-owner-signer.spec.ts, packages/cadre-core/src/cadre-node.ts (`publishStrand` ~5946, `insertStrandRow` ~6002, `foundStrand` ~6091, `publishFoundingRow` ~6121, `attachFoundingRow` ~6148, `ensureStrandPartyKey` ~6326, `resolveStrandPartyKey` ~6382, `publishFormationInvite` ~6425), packages/cadre-core/src/control-database.ts (`insertStrand` ~2604, `deleteStrandAndPartyKey` ~2683 as the model, `insertStrandPartyKey` ~2734, `insertFormationInvite` ~4059, `inTransaction` ~3727, `lockedWithRetry`, `isStrandIdConflict` ~661), packages/cadre-core/src/types.ts (`FoundStrandConfig` ~1456), packages/reference-app-rn/src/use-cadre.ts (`createClosedStrandWithInvite` ~784), packages/reference-app-rn/src/chat-strand.ts (`createClosedChatStrand` ~155), packages/reference-app-web/src/lib/cadre-web.ts (`createInvitation` ~423), packages/reference-app-web/src/lib/chat-strand.ts, packages/cadre-core/test/control-founding-consult-budget.spec.ts (`FOUNDING_CONTROL`, `MEASURED_ON`), docs/architecture.md (Strand Membership Bootstrap → "Entry point")
----
# Strand founding writes its control rows in one transaction

## What happens today (traced)

`foundStrand` on a fresh closed strand:

1. `publishFoundingRow` reads the `Strand` row (`queryStrand`), finds none, calls `publishStrand`.
2. `publishStrand` reads the `Strand` row again, then under one owner approval: `insertStrand` (one autocommit, `execWrite`), then `ensureStrandPartyKey`, which reads `StrandPartyKey` and inserts it (a second autocommit). The minted key is returned to nobody.
3. `attachFoundingRow` → `addStrand` → `launchStrand` → `resolveStrandPartyKey` reads `StrandPartyKey` a second time to get the key step 2 just minted.
4. The app then mints an invitation (`createOpenInvitation`, in-memory only) and calls `publishFormationInvite` bound to the strand: a second owner approval and a third control commit. Both reference apps do exactly this (`createClosedStrandWithInvite` in RN, `createInvitation` on web).

On a solo founder this is all local. On a party with a second machine in the control cohort, every control commit is a two-member commit and every read of a never-written control table is a consult of the cohort, so steps 1–4 cost three commits and four reads where one commit and one read would do.

## Design

### One control transaction for the founding rows

New `ControlDatabase` method, modelled on `deleteStrandAndPartyKey` (sign everything first, then one `lockedWithRetry(() => inTransaction(...))`):

```ts
/** The control rows one founding writes together; see insertFoundingRows. */
interface FoundingRows {
  strand: { id: string; type: 'o' | 'c'; memberPrivateKey?: string };
  /** This party's membership identity key for a closed strand; absent for an open strand. */
  partyKey?: string;
  /** A formation invitation bound to this strand (`StrandId` = strand.id). */
  formationInvite?: { token: string; sAppId: string; expiresAtMs?: number; totalUses?: number; validationUrl?: string };
}

insertFoundingRows(rows: FoundingRows, ownerKey: string, signMessage: ControlSign): Promise<void>
```

- Mint each row's stamp and build each row's signed message exactly as `insertStrand`, `insertStrandPartyKey` and `insertFormationInvite` do today. Extract each of those three into a "prepare" half (stamp, canonical fields, signature → SQL + params) and an "exec" half, and have the existing single-row methods call the same halves, so the digest field order stays in one place per table. `insertFormationInvite`'s `canonicalDatetime` read belongs to the prepare half.
- **All signing and the `canonicalDatetime` read happen before the write lock is taken.** Signing may prompt the user; holding the control write lock across a prompt would stall every other control write.
- Then one `lockedWithRetry(() => this.inTransaction('found strand', ...), {}, 'strand-found')` running the two or three inserts with bare `this.db!.exec` (the lock is held; `execWrite` would self-deadlock).
- The control schema allows this: `StrandPartyKey.AuthorizedInsert` and `FormationInvite.AuthorizedInsert` read only `OwnerKey` and `Revocation`, not the `Strand` row, so statement order inside the transaction does not matter (`schemas/control.qsql` ~215, ~524). Insert `Strand` first anyway, for readability.

### `CadreNode` uses it, and reads each row once

- `publishFoundingRow` keeps its single `queryStrand` read. When it finds no row it no longer calls `publishStrand` (which re-reads); it calls a private write half directly (the successor of `insertStrandRow`), under one `withinOwnerApproval` whose action text names the invitation too when one is included.
- The write half mints the party key for a closed strand (`generateStrandMemberKey`) and calls `insertFoundingRows` **without reading `StrandPartyKey` first**. On success it returns the row and the minted key.
- `publishStrand` (public, standalone) keeps its own read and uses the same write half, so its behaviour is unchanged apart from writing one transaction instead of two.
- `foundStrand` threads the minted key to `addStrand` through the existing `StrandConfig.partyMemberPrivateKey`, so `resolveStrandPartyKey` does not re-read it. On the adopt path (row already published) and the race-adopt path below it passes nothing and the launch reads the stored key as today.

### Conflict resolution on the merged write

A uniqueness rejection rolls the whole transaction back, so each case retries or adopts as a whole:

- **`Strand.Id` conflict** (`isStrandIdConflict(error, 'Strand')`): today's resolution — re-read the `Strand` row, adopt it when it matches (`requireMatchingStrandRow`), rethrow otherwise. Pass no party key forward (the launch reads whatever is stored). If an invitation was requested, publish it afterwards as its own write unless `queryFormationInvite(token)` already finds it: a `lockedWithRetry` retry after a first attempt that may have stored (see `reportsPossiblyStoredWrite` in `control-write-retry.ts`) lands here with the invitation already in place.
- **`StrandPartyKey.Id` conflict** (`isStrandIdConflict(error, 'StrandPartyKey')`; add `'StrandPartyKey'` to the `StrandIdTable` union at `control-database.ts` ~625): a party key row exists with no `Strand` row, which today's `ensureStrandPartyKey` adopts. Re-run `insertFoundingRows` without the `partyKey` arm, under the same `sign`, and adopt the stored key (`queryStrandPartyKey`). This replaces the pre-read every founding pays today with a read only on this rare path.
- Every other rejection (unauthorized signer, retired stamp, `NotRevoked`) surfaces unchanged.

### Invitation through `foundStrand`

`FoundStrandConfig` gains:

```ts
/**
 * A formation invitation to publish bound to this strand, in the same control transaction and
 * owner approval as the strand row. Mint it first with `createOpenInvitation`. When the strand is
 * already published the invitation is published on its own (its own approval), as
 * `publishFormationInvite` would.
 */
formationInvite?: { token: string; expiresAtMs?: number; totalUses?: number; validationUrl?: string };
```

`sAppId` comes from `config.sAppConfig.id`; `StrandId` is the strand id. After the commit, call `strandSolicitationService?.registerMintedInvitation(token, expiresAtMs ?? +Infinity)` exactly as `publishFormationInvite` does (it is already registered by `createOpenInvitation` when minted here, so this is a no-op then, but a token minted elsewhere needs it).

Both reference apps switch their found-and-invite flow to mint the invitation first, then `foundStrand({ ..., formationInvite })`. Keep each app's reachability / dialability guard before the founding, as now. The web e2e fixture (`reference-app-web/e2e/fixtures/formation-responder.ts`) publishes two invitations against one strand and may stay as it is.

## Edge cases & interactions

- **App killed between the control commit and the strand start.** The row and key are committed together; the next `foundStrand` adopts the row and the launch reads the stored key. No half-state (row without key) can be created by this path any more. The heal in `publishStrand`'s idempotent branch and in `resolveStrandPartyKey` stays for rows written by older code and for `publishStrand` callers. Verify by inspection.
- **Two machines of one party founding the same id at once.** One transaction wins; the loser's whole transaction (strand row, key, invitation) rolls back and it adopts the winner's row as a non-founder, exactly as today. The loser's requested invitation is then published separately, bound to the winner's strand. Verify by inspection.
- **Retry after a possibly-stored first attempt** (`lockedWithRetry`). Stamps and signatures are minted once, outside the retried body, as `insertStrand` does today, so a retry re-presents the same rows and hits the `Strand.Id` conflict branch. The invitation check above covers the invitation half. Verify by inspection.
- **Open strand.** No party key; the transaction holds the strand row and, optionally, the invitation.
- **Owner approval declined.** Nothing is written, as today.
- **Already-published strand with `formationInvite`.** The adopt path publishes the invitation alone under its own approval; a caller asking for an invitation always gets one.
- **Concurrent sibling ticket `control-membership-rows-cached-until-changed`** (blocked) caches `CadrePeer`/`Revocation` reads; it does not touch these rows. No interaction beyond the budget spec's numbers.

## Tests

No new test. `packages/cadre-core/test/publish-strand.spec.ts` already covers publish, repeat, the founding race (~301, ~322), `foundStrand` resume and adopt (~434-740) and the closed-strand party key (~68); run it, and adjust any case that stubs the old two-step write. `cadre-node-owner-signer.spec.ts` pins how many approvals a founding asks for; if it counts the found-and-invite flow, it should now see one. Re-pin `FOUNDING_CONTROL` in `control-founding-consult-budget.spec.ts` (it founds an open strand, so expect the dropped `queryStrand` read to show; the commit count should not rise) with a new `MEASURED_ON` and a one-line history entry. The control saving for a closed strand on a two-machine party (two commits → one) is not visible in `message-cost-accounting`, whose strand case uses single-machine parties; say so in the review handoff rather than extending the instrument.

## TODO

- Split `insertStrand` / `insertStrandPartyKey` / `insertFormationInvite` into prepare + exec halves; add `insertFoundingRows`.
- Replace `insertStrandRow` with the merged write half; make `publishFoundingRow` call it directly; thread the minted key into `addStrand`.
- Conflict branches: `Strand.Id` (adopt + separate invitation if missing), `StrandPartyKey.Id` (re-run without the key, adopt stored).
- `FoundStrandConfig.formationInvite`; adopt-path publishes it alone.
- Switch both reference apps' found-and-invite flows to the option.
- Re-pin `FOUNDING_CONTROL`; run `yarn workspace @serfab/cadre-core test` and `yarn lint`.
- docs/architecture.md → Strand Membership Bootstrap → "Entry point": founding is one control transaction (row, party key, optional bound invitation) under one approval, then the start; drop "two control writes".
