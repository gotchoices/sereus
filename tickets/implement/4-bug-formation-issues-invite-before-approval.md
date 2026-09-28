description: When someone tries to join a private workspace and the owner's approval service turns them down, the workspace has already created and permanently stored an unused membership pass for them. Ask for approval (and re-check that a seat is still free) before creating the pass, so a refused join writes nothing into the workspace.
architecture: docs/strands.md
files: packages/cadre-core/src/strand-solicitation.ts (FormationUsageRecorder, new AuthorizedFormationUsage), packages/cadre-core/src/control-formation-recorder.ts (recordUsage, obtainApproval, new authorizeUsage), packages/cadre-core/src/strand-formation-manager.ts (provisionAsResponder bound arm, issueBoundMembershipInvite), packages/cadre-core/src/control-database.ts (InvitationExhaustedError, countFormationUsage — read only), packages/cadre-core/test/strand-formation-membership-invite.spec.ts, docs/strands.md (~line 306)
repro: verified
----
# Ask the approver before issuing the joiner's membership pass

## The defect (reproduced)

On a bound private-workspace join, `StrandFormationManager.provisionAsResponder` (`packages/cadre-core/src/strand-formation-manager.ts`, the `case 'bound'` arm) runs:

1. `issueBoundMembershipInvite` — writes a single-use `Strand.Invite` row into the workspace's (strand's) own database via the `issueMembershipInvite` seam (`CadreNode.issueStrandMembershipInvite` in production).
2. `recorder.recordUsage(...)` — which in `ControlFormationUsageRecorder` (`packages/cadre-core/src/control-formation-recorder.ts`) does **two** things: asks the outside approval hook (`obtainApproval`, only when the invite has a `ValidationUrl`) and then writes the `FormationUsage` consent row (`ControlDatabase.recordFormationUsage`, whose in-lock seat check raises `InvitationExhaustedError`).

So a join the approver refuses (or whose approval is malformed/unenrolled, or that loses the last seat of a multi-use invite) has already written a `Strand.Invite` row that is never handed out, is append-only, and only expires (`MEMBERSHIP_INVITE_TTL_MS`) rather than being removed. Refusal leaves the formation token unspent by design, so a refused joiner can repeat this indefinitely.

Reproduced with a throwaway unit spec (since deleted): a fake `FormationUsageRecorder` resolving `bound` whose `recordUsage` throws `new FormationApprovalError('refused', …)`, plus an `issueMembershipInvite` hook that records its calls. The reply was correctly `{ approved: false, reason: 'Formation approval refused' }`, but the hook had been called once (`['s']`, expected `[]`).

The issue-before-record ordering itself is deliberate and must stay: if consent were recorded first, an issuance failure would spend the joiner's one-time token with no pass to show for it. Only the *approval question* (and the seat check) needs to move ahead of issuance; the *consent write* stays after it.

## The fix: split "authorize" from "record" at the recorder seam

Target ordering for the bound arm: **authorize (approval + abort check + seat pre-check) → issue membership pass → record consent.** Invariant: the responder performs no workspace-side write until the redemption is fully authorized, and an issuance failure still leaves the token unspent.

Recommended shape (`strand-solicitation.ts`):

```ts
/** A redemption the recorder has authorized (approval obtained, a seat still free) but not yet written. */
export interface AuthorizedFormationUsage {
	/** Write the consent row. Abort and seat budget are re-checked inside the write lock. */
	record(): Promise<void>;
}

interface FormationUsageRecorder {
	// … existing members, recordUsage unchanged …
	/**
	 * Optional. Everything `recordUsage` does short of the write: obtain the outside approval
	 * (when the invite demands one) and pre-check the seat budget, returning a handle whose
	 * `record()` performs the write with the exact fields that were approved.
	 * A recorder without it is treated as having nothing to ask up front.
	 */
	authorizeUsage?(params: /* same params type as recordUsage */): Promise<AuthorizedFormationUsage>;
}
```

Why a handle with a closure rather than returning the approval to the manager: the recorder class doc (lines ~43-47) relies on the recorder being the one place where the nonce the approver SIGNED and the nonce that is INSERTED are trivially the same value. `record()` closing over the captured params + approval keeps that true — the manager never re-passes fields between the two steps. Name the params type once (e.g. `FormationUsageParams`) and reuse it for both methods rather than duplicating the object literal type.

`ControlFormationUsageRecorder`:

- `authorizeUsage(params)`: abort check → `queryFormationInvite` → `obtainApproval` (unchanged) → abort check again (the approval call may have been long) → **seat pre-check**: when `invite.totalUses !== null`, `countFormationUsage(token)` and throw `InvitationExhaustedError(token, used, totalUses)` if `used >= totalUses` → return `{ record: () => this.controlDatabase.recordFormationUsage({ …captured, totalUses, ...approval }) }` (keep the existing log line inside `record`).
- `recordUsage(params)` becomes `(await this.authorizeUsage(params)).record()` — one implementation, DRY. Keep the existing `NOTE:` about a missing invite row reading as "no approval required" with the code that reads the invite.
- `provisionAndRecord` (unbound path) is untouched — that path never issues a membership pass.

`StrandFormationManager.provisionAsResponder`, bound arm:

- Build the params once; obtain `authorized` via a small private helper that uses `recorder.authorizeUsage` when present and otherwise returns `{ record: () => recorder.recordUsage(params) }` (the in-memory test fakes and `formation-mocks.ts` keep working unchanged with no approver to ask).
- Then `issueBoundMembershipInvite` → on `!ok` return the rejection (token still unspent — nothing was written) → `await authorized.record()` → `approve(...)`.
- Errors thrown by `authorizeUsage` (`FormationApprovalError`, `InvitationExhaustedError`, `FormationAbortedError`) already flow into the existing `catch` and map to the same protocol reasons; no new mapping needed.
- Rewrite the inline comment above the issuance (currently lines ~438-443) and the `provisionAsResponder` / `issueBoundMembershipInvite` doc comments to describe the three-step order.

### The multi-use seat race

Two concurrent redeemers of the last seat both pass `runSession`'s up-front `isTokenUsed` check; today both issue a pass and the loser's consent write fails in-lock with `InvitationExhaustedError`, orphaning its pass. The seat pre-check in `authorizeUsage` runs after the approval call, so a winner that committed while the loser was waiting on the approval hook is now caught before the loser issues anything. A residual window remains: two redeemers that both pass the pre-check within the duration of one issuance write still orphan one pass. It cannot be closed by holding the control-database write lock across issuance — `lockedWithRetry` re-runs a locked body on transient cluster failures (bodies must be atomic and re-runnable), which would double-issue, and it would stall every other control write behind a strand-database write. Record that as a `NOTE:` at the pre-check (conditional: if orphaned passes from same-node races ever matter, reserve the seat before issuance). Cross-node races are unaffected: both consent rows land (the accepted over-admission already documented on `provisionAndRecord`), so neither pass is orphaned.

The remaining "inverse window" — pass issued, then `record()` fails for a reason other than the above (transient write failure after retries, abort between issue and write) — stays as the existing expiry-bounded tradeoff; keep its note, trimmed to that case.

## Test

One test — the reproduction — in `packages/cadre-core/test/strand-formation-membership-invite.spec.ts` (bound closed path describe block): a fake recorder resolving `BOUND` whose `authorizeUsage` throws `new FormationApprovalError('refused', …)`, driven through `respondOnce`, with a recording `issueMembershipInvite` hook. Assert the reply is `approved: false` with reason `'Formation approval refused'` (the manager's `APPROVAL_REJECTION_REASONS.refused`), the hook was never called, and no usage was recorded. The spec's existing `fakeRecorder` has no `authorizeUsage`, so the other cases exercise the fallback path unchanged. Update the file's header bullet list with the new case.

No integration test: the manager seam is the lowest layer that reproduces it. Only add a unit test for the recorder's seat pre-check if it is cheap in `control-formation-seat-budget.spec.ts`; the in-lock check it mirrors is already covered there.

## Related

`fix/bug-formation-refuses-join-while-host-strand-hibernates` also touches `provisionAsResponder`'s bound arm (issuance failing while the strand hibernates). Independent — its fix lives in `CadreNode.issueStrandMembershipInvite` — but expect a small merge overlap in the bound arm's comments.

## TODO

- Add `AuthorizedFormationUsage` and optional `authorizeUsage` to `FormationUsageRecorder` in `strand-solicitation.ts`; share one params type with `recordUsage`.
- Implement `authorizeUsage` in `ControlFormationUsageRecorder` (approval, post-approval abort check, seat pre-check with the residual-race `NOTE:`); reimplement `recordUsage` on top of it.
- Reorder the bound arm of `provisionAsResponder` to authorize → issue → record via a small helper with the `recordUsage` fallback; update its comments and the `issueBoundMembershipInvite` doc.
- Update the class doc of `ControlFormationUsageRecorder` (the "both write paths first obtain an outside approval" paragraph) to describe the split.
- Add the reproduction test to `strand-formation-membership-invite.spec.ts`.
- Update `docs/strands.md` (~line 306, the membership-invitation sentence) to say the pass is issued only after the approval and seat check pass, and before the token is spent.
- `yarn workspace @serfab/cadre-core build`, run the formation specs (`strand-formation-*`, `control-formation-*`) and `yarn lint`.
