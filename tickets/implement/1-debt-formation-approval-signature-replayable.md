description: An approval that lets someone join a network is now tied to one specific person and one specific join, but the tests that exercise it still call the old code and no longer compile — fix the test call sites so the build and suite are green again.
prereq:
files: packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-constraint-helpers.ts
difficulty: medium
----

# Make the tree compile again after the formation-approval binding change

## STATE OF THE TREE (read this first)

**The working tree does NOT compile.** Two earlier runs landed the entire schema + writer
half of the approval-binding change and then ran out of budget before touching the specs.
The two changed `ControlDatabase` methods have a new signature; the specs still call the old
one. Nothing below is speculative — it is all mechanical call-site work plus one helper
reshape. New adversarial test cases are deliberately NOT in this ticket; they are
`debt-formation-approval-replay-cases` (same stage, sequence 1.5).

### Already landed — do NOT redo, do NOT re-verify

- `schemas/control.qsql` (`FormationUsage`, ~line 479) and its mirror
  `packages/cadre-core/src/control-schema.ts` (~line 493): `UsageStampId text not null unique`
  and `PeerId text not null` added, `PeerId` removed from the `with context (...)` list,
  `Authorized` verifies
  `digest('CadreControl.FormationUsage', 'vouch', new.Token, new.UsageStampId, new.StrandId, new.PeerId, new.Disclosure)`.
  Drift guard between the two: `test/control-schema-drift.spec.ts`.
- `packages/cadre-core/src/control-database.ts`:
  - `export interface FormationUsageResult { useNumber: number; usageStampId: string }` (line ~72).
  - `export function formationVouchMessage({token, usageStampId, strandId, peerId, disclosure})`
    (line ~152) — the TS mirror of the SQL digest, same field order.
  - `redeemInvitation` (line ~1013) and `recordFormationUsage` (line ~1082) both take a
    **required `peerId: string`** and an **optional `usageStampId?: string`** (minted fresh when
    absent), and both now return `Promise<FormationUsageResult>` — `recordFormationUsage` no
    longer returns a bare `number`.
  - `execFormationUsageInsert` (line ~1120) inserts
    `(Token, UseNumber, UsageStampId, PeerId, Disclosure, StrandId, StrandStampId)` with
    `with context PeerSignature = ?, Now = ?, ValidationKey = ?, ValidationSignature = ?`.
- `packages/cadre-core/src/index.ts` exports `formationVouchMessage` + `FormationUsageResult`.
- `packages/cadre-core/src/control-formation-recorder.ts` — doc comment updated; `recordUsage`
  and `provisionAndRecord` **already pass `peerId`**.
- `packages/integration-tests/src/harness/test-network.ts:198` — **already passes `peerId`**.
- `docs/architecture.md` — `ValidationKey` (~line 35) and `FormationUsage` (~line 40) rows updated.

### Confirmed by investigation (don't re-derive)

- **Non-test call sites are all done.** A repo-wide grep for `recordFormationUsage` /
  `redeemInvitation` outside `dist/` finds only `control-formation-recorder.ts` and
  `integration-tests/src/harness/test-network.ts`, both already passing `peerId`. The only
  remaining compile errors are in the two spec files below.
- **Duplicate-nonce error text.** The optimystic vtab renders
  `` `UNIQUE constraint failed: ${tableName}.${column}` `` with an **unqualified** table name
  (`quereus-plugin-optimystic/src/optimystic-module.ts` → `uniqueConstraintMessage`, ~line 817),
  so a repeated `UsageStampId` surfaces as
  `UNIQUE constraint failed: FormationUsage.UsageStampId`. It is NOT a named CHECK, so
  `expectConstraintFailure` (which matches `/CHECK constraint failed: (<names>)\b/`,
  `test/control-constraint-helpers.ts:24`) cannot express it — assert it with
  `rejects.toThrow(/UNIQUE constraint failed: FormationUsage\.UsageStampId/i)`.
  Precedent for the wording: `strand-membership-invite.spec.ts:405`.

## Work

### `packages/cadre-core/test/control-formation-invite.spec.ts`

- Import `formationVouchMessage` and `generateStampId` alongside the existing
  `buildAuthorizationMessage` import (line 11).
- **Reshape `rawInsertFormationUsage` (lines 70–83) to an options object** — it grows past a
  readable positional list, and the follow-on ticket needs to choose the nonce, the joiner, and
  the validation context:

  ```ts
  async function rawInsertFormationUsage(opts: {
    token: string;
    useNumber: number;
    strandId: string;
    strandStampId: string;
    usageStampId?: string;      // defaults to a fresh unique value
    peerId?: string;            // defaults to a fresh unique value
    disclosure?: string;        // defaults to ''
    validationKey?: string;
    validationSignature?: string;
  }): Promise<void>
  ```

  Insert `(Token, UseNumber, UsageStampId, PeerId, Disclosure, StrandId, StrandStampId)` with
  `with context PeerSignature = ?, Now = ?, ValidationKey = ?, ValidationSignature = ?`
  (`PeerId` is a COLUMN now, not a context value). Keep `Now` going through
  `canonicalDatetime`. Update the five existing call sites (~300, 309, 391, 405, 427) to the
  object form.
- Add `peerId` to every `redeemInvitation` call (~152, 180, 198, 219, 237, 255, 452, 481, 519,
  520) and every `recordFormationUsage` call (~268, 269, 321, 505, 637, 652, 663, 680, 701, 718,
  729, 742, 949). Any unique string is fine where the test does not care (`'peer-' + rand()`).
  543/544 already pass one.
- Rewrite the `.toBe(n)` assertions on `recordFormationUsage` as
  `expect((await db.recordFormationUsage({...})).useNumber).toBe(n)`.
- **Reshape the `FormationUsage.Authorized validation-key branch` block's helpers** (lines
  597–626) so the follow-on ticket can add cases without re-editing them:
  - A local `interface Redemption { token; strandId; usageStampId; peerId; disclosure }` — the
    exact five fields one sign-off is bound to. The field names deliberately match
    `recordFormationUsage`'s params so a test can spread a `Redemption` straight into the call.
  - `vouch(privateKey: string, fields: Redemption): string` must build its bytes with
    **`formationVouchMessage(fields)`**, not a hand-written `buildAuthorizationMessage` field
    list, so the spec and the writer share ONE definition of what an approver signs.
  - `validatingInvite(tag, options?: { totalUses?: number; bound?: boolean })` returns a
    `Redemption`: it seats the owner-signed host strand, inserts the `ValidationUrl` invite
    (passing `strandId: <host>` when `bound`), and mints `usageStampId` via `generateStampId`
    plus a fresh `peerId` and a `${tag}-disclosure`.
  - Update the block's existing six cases to the new helpers. Keep the record-only shape
    (`recordFormationUsage` against a pre-existing owner-signed strand) — that single-rejector
    technique is what makes `expectConstraintFailure(..., 'Authorized')` meaningful, and it is
    documented at spec:584–596.
- While in the happy-path case (`admits redemption when an ENROLLED ValidationKey signed the
  vouch digest`, ~line 658), assert the stored row carries the nonce and peer that were signed:
  `select UsageStampId, PeerId from CadreControl.FormationUsage where Token = ?`. One-line
  addition on a case that is already being touched.

### `packages/cadre-core/test/control-revocation-replay.spec.ts`

- Add `peerId` to `redeemInvitation` (~702, 732, 771, 780, 797, 809, 844) and
  `recordFormationUsage` (~824, 860); the two `recordFormationUsage` assertions become
  `.useNumber`.

## Validate

Foreground, streamed with `tee` (never silent redirection — the runner's idle timer kills a
silent command):

- `yarn lint 2>&1 | tee /tmp/lint.log`
- `yarn build 2>&1 | tee /tmp/build.log`
- the `cadre-core` suite, at minimum `control-formation-invite`, `control-revocation-replay`,
  `control-schema-drift`.

## Out of scope

- The new adversarial replay cases — `debt-formation-approval-replay-cases` (sequence 1.5).
- **Verifying `context.PeerSignature`.** `PeerId` is writer-asserted: binding it stops an
  approval being re-filed under another joiner's name but does not prove the named joiner
  consented. Filed as `backlog/debt-formation-usage-peer-signature-unverified`.
- **Calling the `ValidationUrl`.** Still `plan/feat-formation-validation-webhook-unwired`.
