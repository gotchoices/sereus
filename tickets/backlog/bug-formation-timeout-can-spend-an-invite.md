description: When someone joins a network and the host takes too long to finish its part, the joiner is told the join failed — but the host may still finish a moment later and mark the one-time invite as used, so retrying with the same invite is refused and the person is stuck.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts
----

## What happens

Joining works like this: the joiner sends an invitation token; the host validates it and then
does the real work of provisioning — resolving/creating the strand and writing a consent row
that marks the invitation as used. That work runs under a time budget (12s by default). If the
budget runs out, the host stops waiting and replies "provisioning timed out".

But it only stops *waiting* — the provisioning itself is not cancelled. It keeps running, and
its database write can still succeed a moment later. When it does:

- the joiner has already been told the join failed;
- the invitation has nonetheless been consumed (it is single-use);
- retrying with the same invitation is rejected as an invalid token;
- the host may now hold a consent row for a party that never completed the join.

The window is small but the outcome is bad and silent: the person holding the invite has no way
to tell "genuinely invalid" from "spent by a join that reported failure", and the invite issuer
must mint a new one.

This is pre-existing — a joiner-side timeout has always been able to race the host's commit; it
is not caused by the separate provisioning budget added in `debt-formation-provision-step-timeout`
(that change only made the timing explicit and documented the race in a `NOTE:` at
`strand-formation-protocol.ts`, in `FormationListener.provision()`).

## Expected behavior

Either side of this is acceptable as an outcome; picking between them is part of the work:

- **Cancel the work**, so a timed-out provisioning cannot commit. The codebase already has
  `withDeadline()` in `control-stream.ts`, which hands the operation an `AbortSignal` and aborts
  it before rejecting; today provisioning uses `withTimeout()`, which does not. Threading a
  signal through the provisioning hook and into the database write would let the write be
  abandoned rather than landing late.
- **Or make the spend recoverable**, so a joiner that saw a timeout can retry the same invitation
  and have the host recognize its own half-finished redemption instead of refusing it as used.

Whichever way it goes, the user-visible requirement is the same: a join that reports failure must
not leave the invitation unusable.

## Notes for whoever picks this up

- The approval-hook client (`formation-approval.ts`) already documents the mirror-image gap: its
  `FormationApprover` interface has a `NOTE:` saying there is no caller-supplied `AbortSignal`
  because the responder has no way to cancel a formation in flight. That comment and this ticket
  describe the same missing capability from the two ends; resolving this should resolve that.
- Reproducing needs a provisioning hook that commits *after* its budget expires — the existing
  `MockStream`-based unit tests in `packages/cadre-core/test/strand-formation-protocol.spec.ts`
  can already hold a hook open past its timeout, so the observable half ("invite spent although
  the joiner was told it failed") is testable without a real network.
