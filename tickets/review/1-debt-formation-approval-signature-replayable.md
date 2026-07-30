description: An approval that lets someone join a network is now tied to one specific person and one specific join, instead of being copyable to let a stranger reuse it; this ticket only had validation left to run, and it now passes.
prereq:
files: packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-schema.ts, schemas/control.qsql
difficulty: easy
----

# Formation-approval signed against peer + a per-redemption stamp — validated

## What changed (landed across the plan/implement runs on this slug)

A formation "vouch" (the signed approval an existing member gives a joiner) used to be
verifiable by anyone who obtained the signed bytes — the signature covered the invite token and
use-number but not *who* was redeeming it or *which* redemption. That made the approval
replayable: a captured vouch message could be handed to a different peer, or reused for a
different `FormationUsage` row, and would still pass.

Fix binds the signature to both:

- `schemas/control.qsql` — `FormationUsage` gained `UsageStampId text not null unique` and
  `PeerId text not null` (moved out of the `with context (...)` list, i.e. it's no longer
  side-channel data — it's now part of what's authorized). `Authorized` now verifies
  `digest('CadreControl.FormationUsage', 'vouch', new.Token, new.UsageStampId, new.StrandId, new.PeerId, new.Disclosure)`.
- `packages/cadre-core/src/control-database.ts` — `FormationUsageResult`,
  `formationVouchMessage(...)` (the shared field-list builder both production code and tests now
  call, replacing hand-written field arrays), and `redeemInvitation` / `recordFormationUsage`
  take a required `peerId` plus an optional `usageStampId` and return `Promise<FormationUsageResult>`.
- `control-formation-recorder.ts`, `index.ts`, `packages/integration-tests/src/harness/test-network.ts`,
  `docs/architecture.md` updated to match.

## What this run did

Nothing but validate — the code was already landed and believed correct (editor LSP reported
zero diagnostics), but no build/lint/test command had actually been run since the edit. Ran, in
order:

- `tsc -p tsconfig.typecheck.json --noEmit` in `packages/cadre-core` — **clean, zero errors.**
  (Note: `yarn workspace @serfab/cadre-core typecheck` piped through Git Bash `tee` on this
  Windows box produced garbled/unrelated `lamina-quereus` errors for files that don't exist
  anywhere in this repo — a tooling artifact of that invocation path, not a real failure.
  Running `tsc` directly in the package directory, the way this ticket's own instructions
  suggested as a fallback, is clean and authoritative. If a future ticket sees the same
  `yarn workspace ... | tee` garbling, don't chase it — invoke `tsc`/the underlying binary
  directly instead.)
- `yarn lint` (repo-wide) — **clean, exit 0.**
- `yarn build` (repo-wide) — **succeeds, exit 0.** Only pre-existing vite chunk-size /
  dynamic-import warnings, unrelated to this change.
- `vitest run` on `control-formation-invite.spec.ts`, `control-revocation-replay.spec.ts`,
  `control-schema-drift.spec.ts` in `packages/cadre-core` — **3 files, 74 tests, all passing.**

No pre-existing failures encountered; nothing added to `.pre-existing-known.md`.

## How to exercise it / re-run

From `packages/cadre-core`:

```
tsc -p tsconfig.typecheck.json --noEmit
vitest run test/control-formation-invite.spec.ts test/control-revocation-replay.spec.ts test/control-schema-drift.spec.ts
```

The formation-invite spec's `FormationUsage.Authorized validation-key branch` describe block is
the core coverage: it builds a `Redemption` (token, strandId, usageStampId, peerId, disclosure),
signs it via the shared `formationVouchMessage` helper, and asserts both that correctly-signed
redemptions succeed and that any of the seven cases (wrong key, tampered field, etc.) reject with
the `Authorized` constraint failure. The happy-path case additionally reads back the stored row
and asserts `UsageStampId` and `PeerId` match what was signed — i.e. it proves the new columns
are actually persisted and actually checked, not just accepted as extra unchecked input.

## Known gaps — read before assuming this is airtight

**No test yet proves a replayed `UsageStampId` is refused.** The binding change makes the
column `unique`, which is what should reject a second use of the same stamp, but nothing in this
run's spec asserts that end-to-end. The investigation for that assertion is already done (see
the implement ticket's notes, preserved here): the `optimystic` vtab renders an unqualified table
name in `uniqueConstraintMessage` (`quereus-plugin-optimystic/src/optimystic-module.ts`), so the
observable error is `UNIQUE constraint failed: FormationUsage.UsageStampId`, and the existing
`expectConstraintFailure` helper can't express that (it only matches named CHECK constraints) —
the assertion needs `rejects.toThrow(/UNIQUE constraint failed: FormationUsage\.UsageStampId/i)`
directly. This is carved out as `implement/1.5-debt-formation-approval-replay-cases.md`, already
filed and prereq'd correctly — do not duplicate it.

**Two more gaps are intentionally out of scope, already tracked, not duplicated here:**
- `context.PeerSignature` on `FormationUsage` is stored but never verified —
  `backlog/debt-formation-usage-peer-signature-unverified.md`.
- The invite's `ValidationUrl` webhook is stored but never called —
  `plan/5-feat-formation-validation-webhook-unwired.md`.

**One spot leans on a compiler flag rather than an explicit branch:** the test helper
`validatingInvite(tag, options?)` passes `totalUses: options.totalUses` straight through to
`insertFormationInvite`, i.e. an explicit `undefined` when the caller omits it. Harmless under
this repo's `tsconfig` (`exactOptionalPropertyTypes` is off) and `insertFormationInvite`
null-guards it, and lint raised nothing — but worth knowing it's there if that compiler option
ever gets turned on.

**`validatingInvite`'s `bound` option has no caller yet.** It exists for
`1.5-debt-formation-approval-replay-cases` to use. It's dead code by strict reading, but it's a
documented seam for a ticket that's already filed and sequenced right after this one, not orphaned
work — reviewer should not flag it for removal.

## Review findings

- Tooling artifact noted above (`yarn workspace ... | tee` on Windows Git Bash garbling to
  unrelated `lamina-quereus` errors) — not a code defect, parked as a note in this ticket, no
  action needed unless it recurs and starts masking real failures.
