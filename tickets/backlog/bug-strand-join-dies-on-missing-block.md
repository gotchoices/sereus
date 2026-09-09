----
description: When a second machine joined a shared workspace, about one attempt in nine used to die while setting up its tables because it asked for a piece of data the other machine had but it could not get. It has now gone six runs in a row without happening, and nobody knows what changed.
prereq:
files: packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/harness/block-store-probe.ts, tickets/.pre-existing-known.md
difficulty: hard
repro: verified (last seen 2026-08-11; six clean runs on 0.29.0, see below)
severity: wrong-result
likelihood: unusual
tradeoffs: It has not reproduced in six consecutive runs on 0.29.0, its previous two attributions both turned out to be wrong, and a maintainer may reasonably close it as gone rather than spend a diagnosis pass chasing a failure that no longer appears.
----

> **Update 2026-09-08 — it stopped reproducing, and nobody knows why.**
>
> Six consecutive runs of `yarn workspace @serfab/quereus-plugin-sereus test` on `@optimystic/*`
> 0.29.0 (five scripted, one by hand): every run `9 files / 108 passed / 1 todo`, zero `Missing block`,
> zero `Cannot add to non-existent chain`. At the previously recorded rate — roughly one failure per
> run — six clean runs is a real signal.
>
> **This is not a fix, and it should not be written up as one.** No mechanism was identified and no
> change was made here. Two things moved underneath it: the 0.29.0 window carries upstream read-path
> work (`a-reader-cannot-tell-its-view-stopped-advancing`,
> `2-sync-fail-fast-on-a-stalled-revision-view`), and the suite itself grew from 76 tests to 108. The
> body below already warns that this failure has been attributed wrongly twice; attributing it to
> 0.29.0 on timing alone would be the third time. It is a coincidence with a plausible shape, not a
> diagnosis.
>
> **What this changes:** `likelihood` drops to `unusual` and the ticket becomes a watch item rather
> than a diagnosis job. If several more full-suite runs stay clean, retire it and note in
> `.pre-existing-known.md` that the mechanism was never found. If it recurs, the three discriminating
> measurements below are still the right brief, and the topology and strand-join harness landed on
> 2026-09-08 makes a deterministic two-machine reproduction far cheaper to build than it was in August.
> Measurement log: `tickets/.logs/strand-join-remeasure-0.29.0.log`.

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
