description: When two people redeem the same one-use invitation at the same moment, the one who loses the race throws away an approval that was already granted, so a human approver gets asked to approve the very same join a second time.
files: packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts, schemas/control.qsql
difficulty: medium
----

# Re-present a granted approval after a lost formation race

## Background

Some invitations carry a `ValidationUrl` — a web hook an outside approver runs, which is asked
whether one specific person may redeem that invitation. The hook may be automated, but it may
equally be a human review queue: someone reads the joiner's disclosure and clicks approve.

The approver signs over five fields, one of which is a **nonce** (a one-off random id) that the
redeeming node mints. That nonce, not the invite's use number, is what the approval is bound to.
This was a deliberate design choice, recorded in `schemas/control.qsql` under
`FormationUsage.Authorized` ("Why a fresh nonce rather than binding UseNumber") and echoed in
`ControlDatabase.redeemInvitation`: because the approval is not tied to a use number, a node
whose write lost a race **can present the same approval again** under a new use number, without
going back to the approver.

## The gap

Nothing uses that affordance.

When two redemptions of the same single-use invitation land concurrently, they collide on the
`(Token, UseNumber)` primary key and one of the two writes throws. `StrandFormationManager`'s
responder path catches every write failure the same way — logs it and answers the joiner
`Formation conflict, retry`. The approval it was holding is simply dropped. The joiner then
starts formation over from the beginning, which mints a **fresh** nonce and asks the hook again.

So the exact scenario the nonce design set out to avoid — a second approval for the same join —
happens every time the race happens. Where the hook is a human queue that is a second review of
a join a person already approved; where it is rate-limited or metered it is a wasted call.

This is not theoretical-only: the same-token race is a real path (it is why the collision is
caught at all), and it is wrong every time it occurs, not conditional on some future change.

## Expected behavior

A redemption that loses a `(Token, UseNumber)` race, and that is holding an approval the
approver already granted, should retry the write **with the same approval** — same nonce, same
signature — under the next available use number, rather than rejecting the joiner and forcing a
fresh approval. The joiner should see a successful formation, not `Formation conflict, retry`.

Things the implementation has to get right, stated as requirements rather than design:

- Only the PK-collision failure is retryable this way. An approval error, a disclosure
  rejection, or an unrelated write failure must keep today's behavior.
- The invitation's own use limit still governs. If the invite is genuinely exhausted (the
  winner consumed its last use), the loser must be rejected — retrying must not manufacture an
  extra seat. "Retry with the same approval" is about not re-asking the human, not about
  bypassing single-use accounting.
- Retries must terminate. Repeated collisions under sustained contention must bound out and
  fall back to today's clean rejection rather than looping.
- The re-presented approval is still the approval for *this* joiner, strand, and disclosure —
  the four non-nonce signed fields do not change on retry. If any of them would change, the
  approval is not reusable and a fresh one is required.

## Notes

`strand-formation-manager.ts` carries a `NOTE:` at the catch-all that points here; update it
when this lands.

## End
