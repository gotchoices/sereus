----
description: When a second machine joins a strand, roughly one attempt in nine dies while setting up the strand's tables because it asks for a piece of data the other machine has but it cannot get. The problem was previously blamed on a bug that has since been fixed and closed — the failure outlived the fix and now has nobody tracking it.
prereq:
files: packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/harness/block-store-probe.ts, tickets/.pre-existing-known.md
difficulty: hard
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: It is one intermittent test in a suite full of routing races, the previous two attributions for it both turned out to be wrong, and a maintainer may reasonably wait for the strand read path to settle rather than spend another diagnosis pass on a ~1-in-9 draw.
----

# A joining peer's strand setup intermittently fails with `Missing block`

## What happens

`packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts` runs two real libp2p peers over a
strand. The second peer's `composeStrand` runs the strand's schema, and roughly one of its nine
tests per run dies while creating one of the membership tables:

```
Module 'optimystic' create failed for table '<Member|MemberPeer|Manager|Revocation|CancelledInvite>':
  Failed to initialize Optimystic table: Missing block (<id>)
```

Occasionally the sibling shape `Cannot add to non-existent chain` appears instead. Which of the nine
tests draws the failure moves between runs. The block it cannot read is one the founding peer holds.

Measured again on 2026-08-11 during the review of `transactor-key-network-ignores-network-scoping`,
both sibling repos clean and rebuilt: `yarn workspace @serfab/quereus-plugin-sereus test` →
**1 failed, 76 passed, 1 todo**, the failure being this one.

## Why this is filed now — the previous owner is closed and the failure is not

`tickets/.pre-existing-known.md` attributes this entry to
`control-coordinator-answers-absent-without-asking-cohort` and instructs readers not to re-triage
it. That ticket is now in `tickets/complete/`: its fix landed upstream in Optimystic v0.20.0
(a coordinator no longer answers a remote block read as an authoritative absence without consulting
its cohort) and its closing measurement lists what the fix cleared. **This suite is not on that
list**, and it still fails at the same rate. The attribution was made by fingerprint only — the
closing note itself says the neutralized-flag experiment was never repeated against this suite.

So the entry currently points at a ticket that no longer exists in an active stage, for a failure
that is still live. That is the whole reason this ticket exists: to give the failure an owner again,
not to assert a new diagnosis.

This is also the second wrong attribution for it. An earlier one — the strand cluster policy omitting
its corroboration floor — was real and was fixed, taking the suite from 4–6 red per run down to ~1.
The residual survived that too. Treat any new "obvious cause" here with suspicion and measure before
believing it.

## What a diagnosis pass needs to establish

- Whether the block the joining peer cannot read exists on the founding peer at the moment of the
  failure. `packages/integration-tests/src/harness/block-store-probe.ts` reads raw block stores
  without pulling blocks through a database read, which is what this question needs.
- Whether the failure is a read that never reaches the founding peer, or one that reaches it and is
  answered wrongly. These are different repositories' problems: the first is a Sereus/strand wiring
  question, the second is upstream in Optimystic's repo read path.
- Whether it survives with a single peer, or needs the join. A single-peer reproduction would be
  worth far more than the current nine-test draw.

## Definition of done

Either a landed fix with the suite green across several consecutive runs, or a re-attribution to a
named live ticket — with the `.pre-existing-known.md` entry updated to match. Leaving it pointing at
a closed ticket is what this ticket is fixing.
