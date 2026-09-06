----
description: A control write that meets a brief, self-healing network hiccup used to retry and succeed. It now gives up and reports the hiccup to the caller, in four runs out of five.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/harness/degrade.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-core/src/transactor/transactor-source.ts
repro: verified
----

# A transient stream reset is no longer absorbed by the write retry

## What the test asserts

`control-write-degraded-cohort-member` → "absorbs an injected transient stream reset: the write
commits on a retry attempt". It injects exactly `TRANSIENT_RESET_COUNT` resets on A's control
repo protocol (`/optimystic/control-<party>/repo/1.0.0`), then has B refresh its own `CadrePeer`
row and requires the write to commit anyway. The point of the case is that a reset is the
*self-healing* class: retrying is supposed to work.

It fails:

```
AssertionError: self-record refresh across the reset seam did not commit — the retry failed to
absorb the observed transient class: expected Error: Some peers did not complete: 12D3K…
{ errors: [ StreamResetError: … ] } to be null

  message: "Some peers did not complete: 12D3KooW…[block:eb2od87…](in-flight)
            cause=The stream has been reset; root: The stream has been reset"
```

## Why this is filed now

It is a **change in fingerprint, not a newly-noticed failure**, and the change lines up with the
0.28.0 bump:

| date | `@optimystic/db-p2p` | this file's result |
| --- | --- | --- |
| 2026-08-21 | 0.27.x | **7 / 7 green**, twice (recorded in `.pre-existing-known.md`) |
| 2026-09-03 | 0.27.0 | 5 of 7 red — all of them the half-applied-commit wedge |
| 2026-09-05 | **0.28.0** | 5 of 7 red in 4 runs of 5, now led by `StreamResetError`; the 5th run failed at the boot gate instead |

The wedge that explained the 2026-09-03 redness was fixed upstream in this very release
(`torn-commit-must-cancel-the-blocks-it-abandoned` and its chain, all in
`../optimystic/tickets/complete/`). So the wedge going away and a retry-absorption failure
appearing in the same release is the thing to investigate first — the torn-commit work changed
exactly the commit/cancel paths a retry crosses.

## What to establish

1. **Whether the retry runs at all.** The test captures the retry decisions
   (`captureControlRetryLogs` / `printRetryDecisions`) — read that output first; the failing runs
   are in `tickets/.logs/peer-row-control-write-degraded-cohort-member-*.log`. A retry that never
   fires and a retry that fires and re-meets the reset are different bugs.
2. **Whether `StreamResetError` is still classified as transient** after the upstream change.
   The absorbing code is `NetworkTransactor` / `TransactorSource` in `../optimystic`; if the
   classification moved or the error is now wrapped (`Some peers did not complete: …` is an
   aggregate, and the reset is its `cause`), a classifier matching on the outer error would stop
   recognising it.
3. **Whether the abandoned-block cancel introduced by the torn-commit fix consumes the retry
   budget**, so the second attempt starts from a cancelled pend rather than a retryable one.

If (2) or (3) holds, the fix is upstream and this ticket's output is an
`../optimystic/tickets/fix/` filing with the reproduction; if the classification is intact and
the retry simply is not reached, the seam may be in this repo's control-write path.

## Reproduce

Deterministic enough to work with — 4 of 5 runs, from `packages/integration-tests`:

```
npx vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts
```

Note the file has a second, unrelated failure mode: on some runs it dies at the
`bootControlTrio` gate instead, which is
`blocked/control-peer-row-refresh-invisible-to-third-node` and not this ticket. A run that
reports "7 skipped" hit that one and says nothing about this.
