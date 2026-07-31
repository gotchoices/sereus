description: The safeguard that keeps a one-time invitation reusable when the host runs out of time mid-join is tested one piece at a time but never as a whole, so nothing would notice if the pieces stopped being wired together.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts, packages/integration-tests/src
difficulty: medium
----

## Background

An invitation to join a strand is single-use. If the host starts redeeming one, runs out of
time, and abandons the work *after* the redemption has been written, the invitation is spent
but the joiner was told the join failed — a permanently unusable invitation that looks
identical to a forged one. Two shipped tickets closed that:

- the host now **cancels** the abandoned work instead of leaving it running, and the
  database layer checks for that cancellation immediately before writing, so an invitation
  that was not yet redeemed stays unredeemed;
- if the work lands anyway during a short grace period, the host **adopts** it and tells the
  joiner the join succeeded, rather than lying about a timeout over a spent invitation.

## What is missing

Each layer is covered on its own:

- `control-formation-recorder.spec.ts` / `control-formation-invite.spec.ts` prove the
  recorder and database abandon the write when cancelled.
- `strand-formation-protocol.spec.ts` proves the listener cancels on overrun, adopts a late
  success or a late refusal, and keeps the grace inside the overall budget.

But the listener tests drive a hand-written stand-in for the redemption hook over an
in-memory stream, and the recorder tests never involve the listener. **No test exercises the
composed path**: a real listener, over a real `StrandFormationManager`, against a real
control database, where the work overruns and the invitation-redemption row is then shown to
be genuinely absent — followed by a second join attempt with the same token that succeeds.

That composition is exactly the thing the two tickets exist to guarantee, and it is the part
a future refactor is most likely to break silently (drop the cancellation argument anywhere
in the chain and every existing test still passes).

## What to build

An integration- or manager-level test that:

- forces the host's work budget to expire mid-redemption (a slow or stalled approval hook is
  the natural lever),
- asserts the joiner receives the retryable timeout reply,
- asserts **no redemption row exists** in the control database for that token,
- re-presents the same token and asserts the join now completes.

A companion case for the opposite side — work that lands inside the grace *does* write the
row and the joiner is told it succeeded — is worth having in the same file, since the two
behaviours are only correct as a pair.
