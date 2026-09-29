description: When someone tries to join a private workspace and the owner's approval service turns them down, the workspace used to have already created and stored an unused membership pass for them. The join is now approved (and a free seat re-checked) before the pass is created, so a refused join writes nothing into the workspace.
architecture: docs/strands.md
files: packages/cadre-core/src/strand-solicitation.ts (FormationUsageParams, AuthorizedFormationUsage, FormationUsageRecorder.authorizeUsage), packages/cadre-core/src/control-formation-recorder.ts (authorizeUsage, assertSeatFree, recordUsage), packages/cadre-core/src/strand-formation-manager.ts (provisionAsResponder bound arm, authorizeBoundUsage, issueBoundMembershipInvite doc), packages/cadre-core/src/index.ts, packages/cadre-core/src/control-database.ts (InvitationExhaustedError doc only), packages/cadre-core/test/strand-formation-membership-invite.spec.ts, packages/cadre-core/test/control-formation-seat-budget.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts (comments only), docs/strands.md
repro: verified
----
# Ask the approver before issuing the joiner's membership pass

## What changed

On a bound private-workspace (host strand) join, the responder used to (1) write the joiner's single-use `Strand.Invite` membership pass into the strand database, then (2) call `recordUsage`, which asked the outside approval hook and wrote the `FormationUsage` consent row. A refused/malformed/unenrolled approval, or a lost last seat, left an append-only pass in the strand that nobody received, and a refused joiner could repeat this indefinitely (refusal leaves the token unspent).

The bound arm of `StrandFormationManager.provisionAsResponder` now runs **authorize → issue → record**:

- `FormationUsageRecorder` gained an optional `authorizeUsage(params)` returning an `AuthorizedFormationUsage` handle `{ record(): Promise<void> }`. `recordUsage` and `authorizeUsage` share one new params type, `FormationUsageParams` (both new types exported from the package index).
- `ControlFormationUsageRecorder.authorizeUsage`: abort check → read invite → `obtainApproval` (unchanged) → abort check again → seat pre-check (`assertSeatFree`: `countFormationUsage` vs `totalUses`, throws `InvitationExhaustedError`) → returns a handle whose `record()` closes over the captured fields + approval and calls `ControlDatabase.recordFormationUsage` (which still re-checks abort and seat inside its write lock). `recordUsage` is now `(await authorizeUsage(params)).record()`.
- Manager: new private `authorizeBoundUsage(recorder, params)` uses `authorizeUsage` when present, else returns `{ record: () => recorder.recordUsage(params) }` — so every fake recorder in the unit specs and `integration-tests/src/harness/formation-mocks.ts` works unchanged.
- Errors thrown by `authorizeUsage` go through the existing catch: `FormationApprovalError` → per-category reason, `InvitationExhaustedError` → `'Invalid token'`, `FormationAbortedError` → rethrown.
- Unbound path (`provisionAndRecord`) untouched: it never issues a membership pass.

The residual same-node seat race (two redeemers both pass the pre-check within one issuance write; the loser's pass is orphaned, expiry-bounded) is recorded as a `NOTE:` on `assertSeatFree`, with why the control write lock can't be held across issuance. The remaining "pass issued, then `record()` fails" window keeps its expiry-bounded-tradeoff comment in the bound arm.

Docs: `docs/strands.md` membership-invitation sentence; class doc of `ControlFormationUsageRecorder`; `InvitationExhaustedError` doc (it said "raised off nothing else" — now also raised by the pre-check); e2e integration comments that traced the old `recordUsage` call chain.

## Tests added

- `strand-formation-membership-invite.spec.ts` → "approval refused → rejected before the hook is consulted, nothing recorded": the reproduction. Fake recorder resolving `bound` whose `authorizeUsage` throws `FormationApprovalError('refused')`; asserts reply `approved: false` / `'Formation approval refused'`, the `issueMembershipInvite` hook was never called, no usage recorded. Would fail on the old ordering (the hook was called, and the old manager never consulted `authorizeUsage`).
- `control-formation-seat-budget.spec.ts` → "refuses a spent seat at authorization, before the manager could issue anything": real control DB, single-use bound invite, one `recordUsage`, then `authorizeUsage` for a second redeemer throws `InvitationExhaustedError` (usesRecorded 1). Pins that the pre-check exists in the authorize step, not only in the write.

## Validation run

- `yarn workspace @serfab/cadre-core build` and `typecheck`: clean.
- `yarn workspace @serfab/cadre-core test test/strand-formation- test/control-formation- test/strand-solicitation`: 9 files, 178 tests pass.
- `yarn lint`: clean.
- Integration tests (`packages/integration-tests`) were not run — only comments changed there, and `formation-mocks.ts` has no `authorizeUsage`, so it takes the unchanged fallback path.

## Things for the reviewer to look at

- The existing recorder-race case in `control-formation-seat-budget.spec.ts` ("reports the loser of a record-only race as exhausted, on the budget the recorder passed down") was written to prove the recorder threads `totalUses` into the in-lock check. With the pre-check in front, the loser *may* now be refused by the pre-check instead (timing-dependent; both concurrent redeemers usually pass the pre-check since neither has written yet). It still passes either way, but its guard over the threaded budget is weaker than its comment claims when the pre-check wins. Not changed.
- The pre-check adds one `countFormationUsage` read per bound redemption of a use-limited invite (none for unlimited invites).
- Merge overlap expected with `bug-formation-refuses-join-while-host-strand-hibernates`, which also edits comments in the bound arm.
