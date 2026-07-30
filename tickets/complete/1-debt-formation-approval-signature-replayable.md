description: An approval that lets someone join a network is now tied to one specific person and one specific join, instead of being copyable so a stranger could reuse it. Reviewed, validated, and shipped.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/integration-tests/src/harness/test-network.ts, docs/architecture.md, docs/api.md
difficulty: easy
----

# Formation approval bound to peer + per-redemption nonce — complete

## What shipped

A formation "vouch" (the signed approval an outside approver gives before a joiner may be
admitted) used to be verifiable by anyone holding the signed bytes: the signature covered only
the invitation token and the disclosure text. A captured approval could therefore be handed to a
different joiner, filed against a different network, or spent again on a second redemption of the
same invitation.

The approval is now bound to one redemption and one joiner:

- `schemas/control.qsql` + its TypeScript mirror `control-schema.ts` — `FormationUsage` gained
  `UsageStampId text not null unique` (a single-use nonce the redeeming node mints *before* it
  asks the approver) and `PeerId text not null` (moved out of the write-context list into a real
  column, i.e. it is now part of what is authorized rather than side-channel annotation). The
  `Authorized` CHECK verifies
  `digest('CadreControl.FormationUsage', 'vouch', new.Token, new.UsageStampId, new.StrandId, new.PeerId, new.Disclosure)`.
  Replay is closed by two independent mechanisms: a verbatim re-presentation repeats the nonce and
  is refused by `unique`; any other re-presentation changes a signed field and fails the `verify`.
- `control-database.ts` — new exported `formationVouchMessage(...)` builds those exact bytes in
  TypeScript, so production code and the spec share one definition of what an approver signs.
  `redeemInvitation` / `recordFormationUsage` take a required `peerId` plus an optional
  `usageStampId`, and both return `FormationUsageResult` (`{ useNumber, usageStampId }`) so a
  caller can prove the nonce it had signed is the one that landed.
- Callers updated: `control-formation-recorder.ts` (both paths), `index.ts` exports,
  `packages/integration-tests/src/harness/test-network.ts`, `docs/architecture.md`.

## Review findings

### Checked

Read the implement diff (`git diff c571317 792ada2`) before the handoff summary, then:

- **Digest agreement.** Field order in the SQL `verify` and in `formationVouchMessage` match
  exactly (`Token, UsageStampId, StrandId, PeerId, Disclosure`). The spec signs through the
  shared helper, so a field added on one side cannot silently keep passing on the other.
- **Every call site.** Swept for `redeemInvitation` / `recordFormationUsage` / raw
  `insert into … FormationUsage` across `src`, `test`, integration tests, and the reference apps'
  e2e fixtures. Exactly one production raw insert (`execFormationUsageInsert`) and one test raw
  helper exist; all callers pass the now-required `peerId`. No stale caller.
- **Removed context field.** `context.PeerId` is gone from the context list; no constraint,
  query, or writer anywhere still references it.
- **Schema mirror.** `schemas/control.qsql` and `control-schema.ts` are identical in the changed
  region; `control-schema-drift.spec.ts` passes, so the duplication stays honest.
- **Docs.** Read every doc mentioning `FormationUsage` / `ValidationKey` / `ValidationUrl`.
  `docs/architecture.md` was correctly updated by the implement pass. `docs/STATUS.md` needed
  nothing (its mentions are unrelated to the vouch digest).

### Found and fixed in this pass (minor)

- **`docs/api.md` documented a two-argument approval call** (`validateStrandFormation(token,
  disclosure)`) that can no longer produce an acceptable signature. Added a note stating the
  five-field digest, pointing at `formationVouchMessage`, and naming the wiring ticket.
- **`FormationSigner.signFormation` (`strand-solicitation.ts`) carried no hint** that its
  `(token, disclosure)` shape is now insufficient. Documented on the interface: no production
  implementation exists yet, the approval it returns reaches no database today, and whoever
  builds one must also receive the nonce, strand, and joiner — which forces the redeeming side to
  mint the nonce and resolve the strand id *before* asking for approval.
- **`tickets/plan/5-feat-formation-validation-webhook-unwired.md`** already specified the
  five fields the hook must be handed; added the concrete helper name (`formationVouchMessage`)
  and the fact that `signFormation`'s signature has to widen, so the implementer does not
  re-derive the digest by hand.

### Found, not fixed here (already tracked — deliberately not duplicated)

- **No test yet proves the new binding actually rejects a tampered or replayed approval.** All
  seven cases in the `FormationUsage.Authorized validation-key branch` describe block vary the
  approver *key*, not a signed field; the happy-path case only asserts the two new columns
  persist. So the binding is verified by construction (shared digest builder) but not
  adversarially. The handoff ticket's phrase "the seven cases (wrong key, tampered field, etc.)"
  overstated this — there is no tampered-field case. Every missing case is specified in
  `implement/1.5-debt-formation-approval-replay-cases` (cross-joiner, verbatim, cross-strand,
  cross-token, disclosure tamper, race-retry), which is already filed, prereq'd, and sequenced
  immediately after this ticket. Not re-filed.
- `context.PeerSignature` is stored but never verified, so `PeerId` records who an approval
  *names*, not proof the named peer consented —
  `backlog/debt-formation-usage-peer-signature-unverified`.
- The invite's `ValidationUrl` is never contacted —
  `plan/5-feat-formation-validation-webhook-unwired`.

### Tripwires (recorded, not ticketed)

- **Cross-node nonce uniqueness.** `unique` is evaluated against locally visible rows, so two
  unconverged nodes could each admit the same nonce and both rows survive the merge. Already
  parked by the implement pass as a `NOTE:` comment on the `UsageStampId` column in
  `schemas/control.qsql` / `control-schema.ts`, with the reasoning that the digest binding still
  holds on both nodes, so the outcome is a duplicated audit row, never an unapproved join. Same
  class as the existing `NotRevoked` convergence notes. No action.
- **`PeerId` holds an initiator *key* in production, a peer id in the specs.**
  `ControlFormationUsageRecorder` writes `initiatorKey` into the column. Harmless — the approver
  signs whatever value is written, so the binding holds either way — and the recorder's docstring
  already says so explicitly. Worth knowing before anyone treats the column as a libp2p peer id.
- **`validatingInvite`'s `bound` option has no caller yet.** It is a deliberate seam for
  `1.5-debt-formation-approval-replay-cases`. Left in place, not flagged for removal.

### Not found

No correctness, resource-cleanup, error-handling, or type-safety defects. No `any`, no swallowed
exceptions, no new file-size or function-length problems (the change adds one small exported
function and widens two parameter objects). The schema comment blocks are long but match the
density of every other constraint in that file and carry real reasoning (why a nonce rather than
`UseNumber`; why `StrandStampId` is deliberately unbound), so they were left as written.

## Validation run

- `tsc -p tsconfig.typecheck.json --noEmit` in `packages/cadre-core` — clean (exit 0), before and
  after this pass's edits.
- `npx eslint .` repo-wide — clean (exit 0).
- `npx vitest run` in `packages/cadre-core` — **67 files, 1029 passed, 1 skipped**. The skip is
  `key-store.spec.ts` → "keeps best-effort 0o600 on the final slot", which is `it.skipIf(win32)`
  and unrelated to this change. The implement pass had only run three spec files; the full suite
  is green, so nothing collateral broke.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.

Note carried forward from the implement pass: invoking `yarn workspace @serfab/cadre-core
typecheck` through Git Bash `tee` on Windows garbles output into unrelated `lamina-quereus`
errors for files that do not exist in this repo. Invoking `tsc` / `eslint` / `vitest` directly is
clean and authoritative. Don't chase that output if it reappears.
