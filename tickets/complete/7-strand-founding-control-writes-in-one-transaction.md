description: Founding a strand now writes its control-database rows (the strand row, the party's membership key and, when the app asks for one, an invitation) as one transaction under one owner approval, and hands the new key to the strand's start instead of reading it back. The reference apps found and invite in that one step.
architecture: docs/architecture.md#strand-membership-bootstrap
files: packages/cadre-core/src/control-database.ts (`FoundingRows`, `FoundingInvite`, `insertFoundingRows`, `signStrandInsert`, `signStrandPartyKeyInsert`, `signFormationInviteInsert`, `StrandIdTable`), packages/cadre-core/src/cadre-node.ts (`publishStrand`, `founderStrandRow`, `writeFoundingRows`, `insertOrAdoptFounding`, `seatFoundingRows`, `adoptConcurrentFounding`, `publishFoundingInviteIfAbsent`, `publishFoundingRow`, `publishFoundingStrand`, `resumeFounding`, `attachFoundingRow`, `registerPublishedInvitation`), packages/cadre-core/src/types.ts (`FoundStrandConfig.formationInvite`), packages/cadre-core/src/index.ts, packages/cadre-core/src/strand-move.ts (NOTE at `publishStrand`), packages/cadre-core/src/strand-database.ts (error text), packages/cadre-core/test/cadre-node-owner-signer.spec.ts, packages/cadre-core/test/strand-move.spec.ts, packages/reference-app-rn/src/chat-strand.ts (`createClosedChatStrand`), packages/reference-app-rn/src/use-cadre.ts (`createClosedStrandWithInvite`), packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, packages/reference-app-rn/README.md, packages/reference-app-web/src/lib/cadre-web.ts (`createClosedChatStrand`, `createInvitation`), docs/architecture.md (Strand Membership Bootstrap → "Entry point", "Plumbing"), docs/strands.md (~370)
----
# Strand founding writes its control rows in one transaction

Implemented in `ticket(implement): strand-founding-control-writes-in-one-transaction`; reviewed below.

## What changed

**Control database.** `ControlDatabase.insertFoundingRows(rows, ownerKey, sign)` writes the `Strand` row, an optional `StrandPartyKey` row and an optional `FormationInvite` bound to the strand (`StrandId` = the strand id) in one `lockedWithRetry(inTransaction('found strand'))`, label `strand-found`. `insertStrand`, `insertStrandPartyKey` and `insertFormationInvite` were each split into a private `sign…Insert` half (stamp, digest, signature, plus the invitation's `canonicalDatetime` read) that returns `{ sql, params }`, and the single-row methods run that through `execWrite`. So each table's digest field order is in one place. All signing happens before the write lock is taken. `StrandIdTable` gains `'StrandPartyKey'` so `isStrandIdConflict` can classify that table's key conflict.

**CadreNode.**
- `publishStrand` keeps its pre-read and idempotent branch. Its write half is now `writeFoundingRows`, which opens one approval and calls `insertOrAdoptFounding`.
- `foundStrand` → `publishFoundingRow` does its single `queryStrand`. With no row it calls `publishFoundingStrand` → `writeFoundingRows` directly, so it no longer reads the row a second time. With a row it calls `resumeFounding`: adopt as before, then publish the invitation on its own (its own approval) unless already stored.
- For a closed strand, `seatFoundingRows` mints the party key and writes the rows without reading `StrandPartyKey` first. The minted key is threaded to `addStrand` as `partyMemberPrivateKey`, so the launch's `resolveStrandPartyKey` does not read it back.
- Approval text: `Publish the strand <id> to the cadre`, plus `, with an invitation to the app <sAppId>` when an invitation is included.

**Conflict branches.**
- `Strand.Id` conflict: `adoptConcurrentFounding` re-reads the row and adopts it via `requireMatchingStrandRow`, or throws as before. No key is passed forward. A requested invitation is published separately unless `queryFormationInvite(token)` already finds it bound to this strand.
- `StrandPartyKey.Id` conflict (a key stored with no strand row): the rows are written again without the key, under the same `sign`. The function returns no key, so the launch reads the stored one. This differs slightly from the plan, which read the key in the write half; the read count is the same, and the read happens at launch.
- Every other rejection surfaces unchanged.

**API.** `FoundStrandConfig.formationInvite?: { token; expiresAtMs?; totalUses?; validationUrl? }`. `sAppId` comes from `sAppConfig.id`. After the commit, `registerPublishedInvitation` (extracted from `publishFormationInvite`) registers the token with the solicitation service. `FoundingRows` and `FoundingInvite` are exported from the package index.

**Reference apps.** Both mint the invitation first, then found with it.
- RN: `createClosedChatStrand(node, id, invitation?)`. `use-cadre.ts` no longer calls `publishFormationInvite`; the now-unused `cadre-phone.ts` wrapper was removed.
- Web: `createClosedChatStrand(cadre, invitation)`, called by `createInvitation` after `createOpenInvitation`.
- Each app's reachability / dialability guard still runs before anything is minted or founded. The web e2e responder fixture and the integration helper `foundWithInvitation` (`strand-moves-between-cadres`) still publish separately, as allowed.

**Docs.** architecture.md "Entry point" was rewritten (one transaction, one approval, key carried forward, conflict handling) and the "Plumbing" bullet adjusted. The `strands.md` founder-mint sentence and the comments that described "a publish interrupted before its mint" (ensureStrandPartyKey, resolveStrandPartyKey, the launch comment, the founder-key error text) now describe the heal as being for a closed row stored without its key.

## Use cases to validate

- Fresh closed founding with an invitation: one approval, three signatures, one control transaction. `queryFormationInvite(token).strandId` is the strand, and `StrandPartyKey` is seated. Pinned in `cadre-node-owner-signer.spec.ts`.
- Fresh open founding: one transaction holding the strand row only.
- Repeat `foundStrand` on a published row with `formationInvite`: the invitation is published alone, or skipped when the same token is already stored for this strand. Verified by reading the code only; no test.
- Concurrent founder / blinded pre-read: `publish-strand.spec.ts` ~301 and ~322 pass unchanged. They now go through the merged transaction's `Strand.Id` branch.
- Party key seated before the row: `strand-move.spec.ts` and the integration scenario `strand-moves-between-cadres` both take the `StrandPartyKey.Id` branch, and the stored key is kept.

## Tests

- **Added:** one block at the top of `cadre-node-owner-signer.spec.ts` → "asks once for an action that signs several rows". It founds a closed strand with `formationInvite` and pins approvals = 1, signatures = 3 and that the invitation is bound to the strand. This is the ticket's user-visible contract, and the count would also catch the launch re-minting a key.
- **Adjusted:**
  - `strand-move.spec.ts`: the ordering spy moves from `insertStrand` to `insertFoundingRows`.
  - `use-cadre.spec.ts`: expects `createClosedChatStrand(…, 'closed-1', invitation)`, and the dead `publishFormationInvite` mock is dropped.
- **Runs:**
  - Full `@serfab/cadre-core` suite: 2,531 passed, 1 failed (below). After the strand-move fix, `strand-move` alone passes 4/4, and `publish-strand` + `cadre-node-owner-signer` pass 43/43.
  - RN `chat-strand`, `use-cadre`, `solo-founding`: 34/34.
  - Web unit tests: 11/11.
  - Integration `strand-formation-cross-party-seed` (2/2) and `strand-moves-between-cadres` (1/1).
  - `yarn lint` and the typechecks of cadre-core (with tests), RN, web (app and e2e) and integration-tests.

## Known gaps — read these

- **`FOUNDING_CONTROL` was not re-pinned**, against the ticket's TODO. `control-founding-consult-budget.spec.ts` already fails at HEAD on its genesis phase: 20 consults and 34 commits against a budget of 4 consults and 3 commits. Commit `2bb8641a` (`control-collections-created-at-cadre-founding`, in `blocked/`) made genesis commit every control table's collection, and that ticket owns re-pinning this spec. The founding phase measured 4 consults over 4 unnamed tree blocks and 3 commits (was 8 / 5 / 3), but on an optimystic build that includes uncommitted working-tree edits. Re-pinning one phase would also give it a different `MEASURED_ON` from the rest. So the arm was appended to the blocked ticket's re-pin item, and `tickets/.pre-existing-error.md` records the genesis failure. Because genesis now holds every named control block, the dropped `queryStrand` read probably shows no saving in this solo measurement at all; that is inferred, not measured.
- **The two-machine saving is not measured.** For a closed strand on a two-machine party, the control commits drop from two to one, and the found-and-invite flow from three to one. `message-cost-accounting` cannot show this because its strand case uses single-machine parties. Per the ticket, the instrument was not extended.
- **Retry after a possibly-stored attempt.** The plan expected a `lockedWithRetry` retry after a possibly-stored first attempt to land on the `Strand.Id` branch with the invitation already stored. In fact `retryControlWrite` never re-presents a possibly-stored failure (`reportsPossiblyStoredWrite` in `control-write-retry.ts`), so that error reaches the caller. The caller's next `foundStrand` then finds the row on its read and takes `resumeFounding`. That is why the stored-invitation check is on both the conflict path and the resume path.
- **An invitation token stored but bound to a different strand** is not adopted: the separate publish runs and fails on the token's uniqueness with the raw error. This only happens if a caller reuses a token across strands.
- **Commit-time conflict ordering.** If a concurrent founder's commit is refused naming `StrandPartyKey` before `Strand` (the error is rendered at commit, not by the statement), the code writes again without a key, hits `Strand.Id`, and adopts the row. This is inferred from the code and not tested.
- **Strand move cost.** `strand-move` seats the bundle's party key before `publishStrand`, so every moved closed own strand now takes the `StrandPartyKey.Id` branch: one transaction refused locally, then a write without the key, with no extra commit (inferred). A `NOTE:` at the call site records this.
- **Web host `createInvitation` has no automated coverage.** No unit test and no e2e drives the browser's host-side invitation; it is typechecked only.
- **Build housekeeping.** `@serfab/cadre-cli`'s `dist` was stale from an earlier ticket's source edits and was rebuilt so the integration guard would pass. Nothing in cadre-cli changed.
- **`control-collections-created-at-cadre-founding`'s unblock condition held on 2026-10-20 at 00:02.** The stale-build guard passed then, and optimystic rebuilt again at 00:13, still from uncommitted edits. Whoever gardens `blocked/` may want to look.

## Review findings

Read the implement diff first (`ticket(implement): strand-founding-control-writes-in-one-transaction`), then the handoff.

**Checked, no defect found:**

- **Conflict classification.** `isStrandIdConflict(error, 'Strand')` matches `UNIQUE constraint failed: Strand.Id` only; the pattern is anchored after `failed: `, so `StrandPartyKey.Id` and `JoinedStrand.Id` cannot match it, and the `StrandPartyKey` pattern cannot match `Strand.Id`. A `FormationInvite.Token` conflict surfaces raw, as the handoff says.
- **Branch flow.** In `insertOrAdoptFounding`, a `Strand.Id` refusal from either attempt in `seatFoundingRows` (first write or the keyless re-write) reaches the outer catch and adopts. Every other error rethrows. The invitation in the conflict branch is published under the same open approval's `sign`; in `resumeFounding` it asks for its own.
- **Schema claim in `insertFoundingRows`.** Checked against `schemas/control.qsql`: neither `StrandPartyKey.AuthorizedInsert` nor `FormationInvite.AuthorizedInsert` reads `Strand`, so the row order inside the transaction does not matter to the constraints.
- **Locking.** All signing (and the invitation's `canonicalDatetime` read) happens before `lockedWithRetry`; the body uses bare `db.exec`, matching the existing `reap JoinRequest` transaction.
- **Key handoff.** `partyKey` is only returned when this machine wrote the row, so `founded` is true whenever `addStrand` receives `partyMemberPrivateKey`; the watcher's retry path re-reads the same stored key (the existing NOTE in `addStrand` still holds).
- **Reference apps.** `CHAT_SAPP_ID` equals `getChatSAppConfig().id` in both apps, so the invitation's app id and the founding's `sAppConfig.id` agree. Minting the invitation before founding means a failed founding leaves only an in-memory, expiring solicitation registration, where the old order could leave a published strand with no invitation.
- **Docs.** Read every doc the change touches or names: `docs/architecture.md` (Entry point, Plumbing, "Composing an action" at ~242), `docs/strands.md` ~370, `docs/reference-app-rn.md` ~1248, `packages/reference-app-rn/README.md`. All reflect the new flow.

**Fixed in this pass (minor):**

- **Untested branch pinned.** The repeat-founding path (stored invitation kept without an approval, a new token published alone and bound to the strand) was verified only by reading. It has real branching and is part of `FoundStrandConfig.formationInvite`'s stated contract, so one block was added to the existing "asks once for an action that signs several rows" test in `cadre-node-owner-signer.spec.ts`. It reuses the strand already founded there, so it adds almost no run time.
- **Duplicated type.** `FoundStrandConfig.formationInvite` repeated `FoundingInvite`'s fields inline; it is now `Omit<FoundingInvite, 'sAppId'>` (a type-only import in `types.ts`), so the field docs live in one place.
- **Doc structure.** The architecture.md "Entry point" bullet had grown to cover four topics in one paragraph. It is now a one-sentence item with labelled sub-paragraphs ("One transaction", "Resuming", "A stored party key"), and the resume sentence now says a token already stored for the strand is kept.

**Tripwires / accepted as-is:**

- Strand moves take the `StrandPartyKey.Id` branch for every closed own strand. The implementer's `NOTE:` at `strand-move.ts` `adoptStrand` covers it; no change.
- Commit-time conflict ordering (a concurrent founder's commit refused naming `StrandPartyKey` before `Strand`) resolves correctly by reading the code: re-write without a key, then `Strand.Id`, then adopt. Not tested; not worth a multi-node test for an ordering the code already handles.
- A token reused across strands surfaces the raw uniqueness error. It is a caller error, documented in the handoff; no change.

**Tests reviewed:** the implementer's added count test (approvals = 1, signatures = 3, invitation bound) pins the ticket's user-visible contract; kept. The `strand-move.spec.ts` spy retarget and the `use-cadre.spec.ts` expectation change are adjustments to the new call shape; kept. Nothing cut.

**Not filed:**

- `cadre-node.ts` is 10,794 lines (`wc -l`); `debt-cadre-node-single-file-size` already tracks it.
- `control-database.ts` is 5,430 lines (`wc -l`) with no size ticket. This change added about 100 lines of signing halves that sit beside their single-row writers, which is the right place for them, so no ticket was filed for it here.
- Re-pinning `FOUNDING_CONTROL` stays with `control-collections-created-at-cadre-founding`, as the handoff says.

**Validation:**

- `yarn lint` clean. cadre-core typecheck clean, and `@serfab/cadre-core` rebuilt after the `types.ts` change. RN and web typechecks clean.
- `publish-strand`, `cadre-node-owner-signer` and `strand-move`: 47/47 passed. RN `use-cadre.spec.ts`: 24/24. Web unit tests: 11/11.
- Full cadre-core suite: 2,530 passed, 3 failed, 1 skipped.
  - `control-founding-consult-budget`: genesis overrun, already in `tickets/.pre-existing-known.md`.
  - Two tests in `control-database-solo-warm-start.spec.ts`: genesis `ensureOwnerKey()` timed out at 15 s under full-suite load. The file passes 6/6 alone. This ticket does not touch the genesis path. Recorded in `tickets/.pre-existing-error.md` for triage.
