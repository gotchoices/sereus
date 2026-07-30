description: When an outside approver signs off on someone joining a network, that approval is not tied to the specific person or the specific join, so a copy of it could be reused to let someone else in — bind each approval to one single join so it can only be spent once. The schema and writer changes are done; the tests that exercise them are not.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, docs/architecture.md
difficulty: medium
----

# Bind a formation approval to one redemption — finish the test + compile pass

## STATE OF THE TREE (read this first)

**The working tree does NOT compile right now.** A prior run landed the whole schema + writer
half of this ticket and then hit its token budget before touching the specs. The specs call the
two changed `ControlDatabase` methods with the old signature, so `yarn build` / `vitest` will
fail on type errors until the "Remaining work" section below is done. Nothing here is
speculative — go straight to fixing the call sites, then add the missing cases.

### Already landed (do not redo)

- `schemas/control.qsql` — `FormationUsage` gained `UsageStampId text not null unique` and
  `PeerId text not null` (with full column comments: append-only ⇒ no `Revocation` pair
  needed, plus the local-visibility convergence `NOTE:`). `PeerId` dropped out of the
  `with context (...)` list; `PeerSignature` stays, with a comment above the list saying no
  constraint reads it. The `Authorized` validation branch now verifies
  `digest('CadreControl.FormationUsage', 'vouch', new.Token, new.UsageStampId, new.StrandId, new.PeerId, new.Disclosure)`,
  and the old `KNOWN GAP:` block is replaced by the what-an-approval-buys / why-a-nonce-not-
  `UseNumber` / why-not-`StrandStampId` reasoning.
- `packages/cadre-core/src/control-schema.ts` — same edits mirrored. **Backticks inside that
  file are escaped (`` \` ``)** because it is one big template literal; the mirrored comments
  use `` \`unique\` ``. Drift guard: `test/control-schema-drift.spec.ts`.
- `packages/cadre-core/src/control-database.ts`:
  - new `export interface FormationUsageResult { useNumber: number; usageStampId: string }`
    (just below `MissingHostStrandError`).
  - new `export function formationVouchMessage({token, usageStampId, strandId, peerId, disclosure})`
    next to `buildAuthorizationMessage`, built on it, same field order as the SQL.
  - `redeemInvitation` and `recordFormationUsage` now take **required `peerId: string`** and
    **optional `usageStampId?: string`** (defaulted to a fresh `generateStampId(localPeerId)`),
    and **both return `Promise<FormationUsageResult>`** — `recordFormationUsage` no longer
    returns a bare `number`.
  - `execFormationUsageInsert` inserts
    `(Token, UseNumber, UsageStampId, PeerId, Disclosure, StrandId, StrandStampId)` with
    `with context PeerSignature = ?, Now = ?, ValidationKey = ?, ValidationSignature = ?`.
- `packages/cadre-core/src/index.ts` — exports `formationVouchMessage` and the
  `FormationUsageResult` type.
- `packages/cadre-core/src/control-formation-recorder.ts` — `recordUsage`'s doc comment no
  longer calls `PeerId` "advisory"; it says the approver signs over it and that it is still
  writer-asserted.
- `docs/architecture.md` — `ValidationKey` row (~line 35) states what one sign-off binds and
  that a verbatim re-presentation is refused as a duplicate nonce; `FormationUsage` row
  (~line 40) records the joining peer + per-redemption nonce.
- `packages/integration-tests/src/harness/test-network.ts:198` — **already passed `peerId`**,
  needs no change. Same for `ControlFormationUsageRecorder.recordUsage` / `provisionAndRecord`.

## Remaining work

### Phase 1 — make it compile

Both spec files call the two methods with no `peerId` (now required) and assert on the old
bare-number return of `recordFormationUsage` (now `{useNumber, usageStampId}`). Any peer id
string is fine where the test does not care (`'peer-' + rand()`).

- `packages/cadre-core/test/control-formation-invite.spec.ts` — `redeemInvitation` at ~152,
  180, 198, 219, 237, 255, 452, 481, 519, 520; `recordFormationUsage` at ~268, 269, 321, 505,
  637, 652, 663, 680, 701, 718, 729, 742, 949 (543/544 already pass `peerId`). The
  `expect(await db.recordFormationUsage({...})).toBe(1)` assertions become
  `expect((await db.recordFormationUsage({...})).useNumber).toBe(1)`.
- `packages/cadre-core/test/control-revocation-replay.spec.ts` — `redeemInvitation` at ~702,
  732, 771, 780, 797, 809, 844; `recordFormationUsage` at ~824, 860.
- `rawInsertFormationUsage` (`control-formation-invite.spec.ts:70–83`) must insert the two new
  columns and drop `PeerId` from its context list. Give it caller-controlled `usageStampId` and
  `peerId` parameters — the new replay cases need to choose both. Existing callers (~300, 309,
  391, 405, 427) pass fresh values.
- The `vouch` helper (`control-formation-invite.spec.ts:602–606`) must sign the five-field
  vector — switch it to `formationVouchMessage({token, usageStampId, strandId, peerId, disclosure})`
  so the spec and the writer share one definition. Every caller in the
  `FormationUsage.Authorized validation-key branch` block then has to mint a `usageStampId`
  (`generateStampId('test')` or any unique string) and pass the same one to both `vouch` and
  `recordFormationUsage`.

### Phase 2 — the cases this ticket exists for

All of these belong in the `FormationUsage.Authorized validation-key branch` block, which
records against a pre-existing owner-signed strand via `recordFormationUsage` precisely so
`Authorized` is the only constraint that can reject (single-rejector technique, documented at
spec:584–596). Keep that shape.

- **Cross-joiner replay on a multi-use bound invite** — the headline case. One host strand, one
  `ValidationUrl` invite with `TotalUses` > 1, an approval issued for joiner A; a second
  redemption presents A's signature with a different `peerId` and its own fresh nonce. Must be
  rejected by `Authorized`.
- **Verbatim replay** — the identical approval re-presented with the *same* `usageStampId`.
  Rejected, but by `UsageStampId`'s `unique` constraint, **not** by a named CHECK.
  `expectConstraintFailure` cannot express this: it matches
  `/CHECK constraint failed: (<names>)\b/` (`test/control-constraint-helpers.ts:24`). Assert it
  with a distinct matcher on the uniqueness error, and keep the two rejectors distinct
  deliberately so a later refactor cannot collapse them into one accidental pass. **Confirm the
  engine's actual unique-violation message text before pinning a regex** — the strand-side
  precedent is `/UNIQUE constraint failed: ConsumedInvite\.InviteKey/i`
  (`strand-membership-invite.spec.ts:405`), but that is a different table backend; verify what
  the optimystic-backed control tables emit.
- **Cross-strand replay** — same token, same joiner, same disclosure, approval filed against a
  different `strandId`. Rejected by `Authorized`.
- **Cross-token replay** — pre-existing behavior (`Token` was already bound); add a case so it
  cannot regress out.
- **Disclosure tamper** — pre-existing behavior; add a case.
- **Happy path still lands** — an enrolled approver signing the full five-field digest is
  admitted, and the stored row carries the nonce and peer that were signed (`select UsageStampId,
  PeerId from CadreControl.FormationUsage ...`).
- **Non-validating invites unaffected** — an invite with no `ValidationUrl` still redeems with no
  approval at all, now carrying the two new columns.
- **Race retry keeps the approval alive** — this is the ergonomic property the nonce design was
  chosen for, so pin it: two redemptions of the same token collide on the `(Token, UseNumber)`
  PK; the loser re-inserts with the *same* `usageStampId` and the same approval under a new use
  number and succeeds. Then confirm the winner's already-committed nonce cannot be inserted a
  second time.
- **Both redemption paths** — `redeemInvitation` (unbound: `Strand` + `FormationUsage` in one
  transaction, mutually-circular deferred CHECKs) and `recordFormationUsage` (record-only). The
  added columns must not disturb the deferral: both CHECKs must still see both rows at commit.
  The existing specs cover this incidentally once they compile; no new case needed if they pass.
- **`Monotonic` unaffected** — sequential use numbers still come out 1, 2, 3 with the new columns
  present (existing case at spec:261 covers it).
- **Approver removal** — the existing "stops approving future redemptions, does not unwind past
  ones" case (spec:722) must still hold under the new digest.

### Phase 3 — validate

Foreground, streamed with `tee` (never silent redirection):

- `yarn lint 2>&1 | tee /tmp/lint.log`
- `yarn build 2>&1 | tee /tmp/build.log`
- the `cadre-core` test suite, at minimum `control-formation-invite`,
  `control-revocation-replay`, and `control-schema-drift`.

## Deliberately out of scope (unchanged from the original ticket)

- **Verifying `context.PeerSignature`.** `PeerId` is writer-asserted, so binding it stops an
  approval from being re-filed under a different joiner's name but does not prove the named
  joiner consented. Filed as `backlog/debt-formation-usage-peer-signature-unverified`.
- **Calling the `ValidationUrl`.** Still `plan/feat-formation-validation-webhook-unwired`; that
  ticket depends on this one, since the hook must be handed the nonce, strand, and joiner to
  sign over, and now has `formationVouchMessage` to build the bytes with.
