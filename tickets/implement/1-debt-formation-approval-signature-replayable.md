description: An approval that lets someone join a network is now tied to one specific person and one specific join. The code and its tests are all updated; what remains is running the lint, build, and test commands to confirm nothing broke.
prereq:
files: packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/src/control-database.ts
difficulty: easy
----

# Validate the formation-approval binding change

## STATE OF THE TREE

**All code changes for this ticket have landed.** A prior run hit its token budget after
finishing the edits but before running any validation command. Nothing below asks for new
code — the task is to run the checks, and fix only what they surface.

The editor's TypeScript language server reported **zero remaining diagnostics** in both spec
files after the last edit, so the tree is believed to compile. That is the language server's
word, not `tsc`'s: `yarn typecheck` has not been run.

### Landed in earlier runs (schema + writer half — do NOT re-verify)

- `schemas/control.qsql` + `packages/cadre-core/src/control-schema.ts`: `FormationUsage` gained
  `UsageStampId text not null unique` and `PeerId text not null`; `PeerId` left the
  `with context (...)` list; `Authorized` verifies
  `digest('CadreControl.FormationUsage', 'vouch', new.Token, new.UsageStampId, new.StrandId, new.PeerId, new.Disclosure)`.
- `packages/cadre-core/src/control-database.ts`: `FormationUsageResult`,
  `formationVouchMessage(...)`, and `redeemInvitation` / `recordFormationUsage` taking a required
  `peerId` + optional `usageStampId` and returning `Promise<FormationUsageResult>`.
- `packages/cadre-core/src/index.ts`, `control-formation-recorder.ts`,
  `packages/integration-tests/src/harness/test-network.ts`, `docs/architecture.md`.

### Landed in this run (the spec half)

`packages/cadre-core/test/control-formation-invite.spec.ts`:

- Import is now `{ MissingHostStrandError, formationVouchMessage, generateStampId }` —
  `buildAuthorizationMessage` is no longer imported (the local `vouch` helper stopped
  hand-writing the field list, so the import would have been unused).
- `rawInsertFormationUsage` takes an options object
  (`token, useNumber, strandId, strandStampId, usageStampId?, peerId?, disclosure?, validationKey?, validationSignature?`)
  and inserts `(Token, UseNumber, UsageStampId, PeerId, Disclosure, StrandId, StrandStampId)` with
  `with context PeerSignature = ?, Now = ?, ValidationKey = ?, ValidationSignature = ?`. All five
  call sites converted. `usageStampId` / `peerId` default to fresh unique values.
- Every `redeemInvitation` / `recordFormationUsage` call passes `peerId`; every use-number
  assertion reads `.useNumber`.
- The `FormationUsage.Authorized validation-key branch` block now has a local `Redemption`
  interface (`token, strandId, usageStampId, peerId, disclosure` — named to match
  `recordFormationUsage`'s params so it spreads straight in), `vouch(privateKey, fields)` built
  through `formationVouchMessage`, and
  `validatingInvite(tag, options?: { totalUses?: number; bound?: boolean })` returning a
  `Redemption`. All seven cases in the block use them.
- The happy-path case additionally asserts the stored row's `UsageStampId` and `PeerId` match
  what was signed.

`packages/cadre-core/test/control-revocation-replay.spec.ts`: `peerId` added to all seven
`redeemInvitation` calls and both `recordFormationUsage` calls; the two use-number assertions
read `.useNumber`.

## Work

Run, in this order, foreground and streamed with `tee` (never silent redirection — the runner's
idle timer kills a silent command):

- `yarn workspace @serfab/cadre-core typecheck 2>&1 | tee /tmp/typecheck.log` — the fastest
  check that the two specs really compile (`tsconfig.typecheck.json` includes `test/`, the build
  config does not).
- `yarn lint 2>&1 | tee /tmp/lint.log`
- `yarn build 2>&1 | tee /tmp/build.log`
- the `cadre-core` suite — at minimum `control-formation-invite`, `control-revocation-replay`,
  `control-schema-drift`. These boot a real `CadreNode` per describe block and are slow; run the
  three files by name rather than the whole package if wall-clock is a concern.

Fix what these surface. Two things worth knowing before you start:

- `validatingInvite` passes `totalUses: options.totalUses` straight through to
  `insertFormationInvite`, i.e. an explicit `undefined` when the caller omits it. That is fine
  under this repo's `tsconfig` (`exactOptionalPropertyTypes` is off) and
  `insertFormationInvite` null-guards it — but it is the one spot where the new helper leans on
  a compiler setting rather than on an explicit branch.
- The `bound` option on `validatingInvite` has **no caller yet**. It exists for
  `debt-formation-approval-replay-cases` (sequence 1.5). If a lint rule objects to it, the honest
  fix is to leave it and let 1.5 add the case, not to delete a documented seam.

Then write the `review/` handoff: what the change is, how to exercise it, and — honestly — that
no test yet proves a replayed `UsageStampId` is refused (see below).

## Out of scope

- New adversarial replay cases — `debt-formation-approval-replay-cases` (sequence 1.5). In
  particular, nothing yet asserts that a repeated `UsageStampId` is refused. The investigation
  for that assertion is already done: the optimystic vtab renders an unqualified table name
  (`quereus-plugin-optimystic/src/optimystic-module.ts` → `uniqueConstraintMessage`), so it
  surfaces as `UNIQUE constraint failed: FormationUsage.UsageStampId` and must be asserted with
  `rejects.toThrow(/UNIQUE constraint failed: FormationUsage\.UsageStampId/i)` —
  `expectConstraintFailure` only matches named CHECK constraints and cannot express it.
- Verifying `context.PeerSignature` — `backlog/debt-formation-usage-peer-signature-unverified`.
- Calling the `ValidationUrl` — `plan/feat-formation-validation-webhook-unwired`.
