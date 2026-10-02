description: When someone tries to join a private workspace and the owner's approval service turns them down, the workspace used to have already created and stored an unused membership pass for them. The join is now approved (and a free seat re-checked) before the pass is created, so a refused join writes nothing into the workspace.
architecture: docs/strands.md
files: packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/strand-formation-membership-invite.spec.ts, packages/cadre-core/test/control-formation-seat-budget.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, docs/strands.md, docs/api.md, docs/architecture.md
repro: verified
----
# Ask the approver before issuing the joiner's membership pass

## What landed

On a bound private-workspace (host strand) join, `StrandFormationManager.provisionAsResponder` now runs **authorize → issue → record** instead of issue → (approve + record):

- `FormationUsageRecorder` gained an optional `authorizeUsage(params)` returning an `AuthorizedFormationUsage` handle `{ record(): Promise<void> }`; `recordUsage` and `authorizeUsage` share `FormationUsageParams`. Both types are exported.
- `ControlFormationUsageRecorder.authorizeUsage`: abort check → read invite → `obtainApproval` → abort check → seat pre-check (`assertSeatFree`) → handle whose `record()` calls `ControlDatabase.recordFormationUsage` (which still re-checks abort and seat inside its write lock). `recordUsage` is `authorizeUsage` + `record()`.
- Manager: `authorizeBoundUsage` uses `authorizeUsage` when the recorder has it, else defers everything to `recordUsage` (keeps fakes working). Approval/exhaustion/abort errors from authorization go through the existing catch mapping.
- Unbound path (`provisionAndRecord`) unchanged — it never issues a membership pass.

Tests: a manager-level reproduction (approval refused → the `issueMembershipInvite` hook is never called, nothing recorded) and a real-control-DB test that `authorizeUsage` refuses a spent seat.

## Review findings

Read the `ticket(implement): bug-formation-issues-invite-before-approval` diff first, then the surrounding recorder, manager and `ControlDatabase` seat-check code.

- **Correctness / ordering** — checked: the approval hook is consulted before issuance; issuance still precedes the consent write, so an issuance failure leaves the token unspent; error mapping (`FormationApprovalError` → per-category reason, `InvitationExhaustedError` → `'Invalid token'`, `FormationAbortedError` rethrown) covers errors now thrown from the authorize step. The signed and inserted nonce are the same because `record()` closes over the approved fields. No defect found.
- **Abort handling** — checked: the recorder re-checks the abort after the (possibly long) approval call; the only unchecked gap before issuance is one count read. An abort landing there orphans an expiry-bounded pass, which is the same window the bound arm's existing comment already accepts. No change.
- **Behaviour change for approval hooks** — a retryable issuance failure (strand runtime absent) now happens *after* the hook was asked, so the retried join asks the hook again. Not new in kind: an abort or failed write after approval already did this, and the documented contract is "one approval per nonce", not "one call per joiner". No change.
- **Seat race** — the same-node race (two redeemers both pass the pre-check, loser's pass orphaned) is recorded by the implementer as a `NOTE:` on `ControlFormationUsageRecorder.assertSeatFree`, with the reason the control write lock can't span issuance. Agreed; tripwire kept, no ticket.
- **Optional `authorizeUsage`** — a future recorder that implements `resolveStrand` but not `authorizeUsage` would silently get the old issue-before-approval order. Only `ControlFormationUsageRecorder` reaches the bound arm in production, and the interface doc states the fallback's meaning ("nothing to ask up front"). Considered making it required; declined — every other bound/unbound seam on this interface is optional in the same way and the fakes would all need a pass-through. No ticket.
- **DRY** — `assertSeatFree` repeats the `count >= totalUses` comparison also found in `isTokenUsed` and `ControlDatabase.assertSeatRemains`. The database one must run inside the write lock with retries off, and `isTokenUsed` returns a boolean from a fresh invite read; unifying them would add parameters to save three lines. Left as is.
- **Tests** — both new tests meet the bar (one is the bug's reproduction, the other pins the pre-check contract against a real control DB). The implementer's flag on the existing "record-only race" test: both concurrent redeemers read a count of 0 before either writes, so the loser is still normally refused by the in-lock check; either way it asserts only the named error and seat count, which both paths produce. Not changed.
- **Docs** — `docs/strands.md`, the recorder class doc, the `InvitationExhaustedError` doc and the e2e comments were updated by the implementer. Fixed inline: `docs/api.md` (approval-hook section still named `recordUsage` as the bound path), `docs/architecture.md` (strand-membership paragraph described issuance only as "before the token is spent"), and the recorder's class-level bullet for the bound shape.
- **Performance** — one extra `countFormationUsage` read per bound redemption of a use-limited invite; none for unlimited ones. Negligible against the approval HTTP call and strand write on the same path.
- **Type safety / resource cleanup** — no `any`, no new resources held; nothing to report.

## Validation

- `yarn workspace @serfab/cadre-core typecheck`: clean.
- `yarn workspace @serfab/cadre-core test test/strand-formation- test/control-formation- test/strand-solicitation`: 9 files, 178 tests pass.
- `yarn lint`: clean.
- Integration tests not run: only comments changed there, and `formation-mocks.ts` takes the unchanged `recordUsage` fallback.
