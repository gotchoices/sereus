----
description: A control write that meets a brief, self-healing network hiccup used to retry and succeed. It now fails permanently, because the interrupted attempt leaves a marker behind that its own retry is then rejected by. The code that would clear the marker is in a separate repository and cannot be reached from here.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-database.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts
repro: verified
----

# Blocked (b): a retried control write collides with its own abandoned pend

**Category (b) — dependency outside this repo.** The pending record is created and cleared inside
`@optimystic/db-core`; nothing on this side can cancel it.

**Upstream ticket:** `../optimystic/tickets/fix/1-a-reset-attempt-leaves-a-pend-the-retry-collides-with.md`.

**Unblock condition:** an upstream change that stops a transport-failed commit attempt from
leaving a pend its own retry collides with, landed and rebuilt. Then run
`control-write-degraded-cohort-member` five times and remove its entry from
`tickets/.pre-existing-known.md`.

## What was measured, 2026-09-05

The scenario injects exactly two transient stream resets on A's control repo protocol, then has B
refresh its own `CadrePeer` row, and requires the write to commit anyway. The retry runs and
classifies correctly — this is **not** a classifier bug:

| attempt | cause reported by `sereus:cadre:control-db` |
| --- | --- |
| 1 | `The stream has been reset` — injected reset #1 |
| 2 | `Transaction rejected by validators (1/3 rejected): …: pending conflict: block … held by unresolved action(s)` |
| 3 | same pending conflict → `failed after 3/3 attempt(s)` |

The injector resets only the first two inbound streams and passes everything through afterwards,
so attempt 3 meets a clean handler and fails regardless. Attempt 1's abort left a pending record;
attempts 2 and 3 are rejected by it. The write is colliding with itself, and no number of retries
can clear a pend — only a client cancel, a divergence-shaped refusal, or a forward write of the
same action id removes one.

Retrying under a fresh action id would not help: the collision is on the block, not the action.
And the control-write retry loop in `control-database.ts` has no handle on the action whose pend
needs cancelling — `NetworkTransactor.cancel` is not reachable through the Quereus plugin path.

## Why it is filed now rather than long ago

The fingerprint is new, and it tracks the release:

| date | `@optimystic/db-p2p` | this file |
| --- | --- | --- |
| 2026-08-21 | 0.27.x | **7 / 7 green**, twice |
| 2026-09-03 | 0.27.0 | 5 of 7 red — all the half-applied-commit wedge |
| 2026-09-05 | **0.28.0** | 5 of 7 red in 4 runs of 5, led by this; 1 run died at the boot gate instead |

0.28.0 is the release that fixed the wedge (`torn-commit-must-cancel-the-blocks-it-abandoned` and
chain). That ticket recorded, as a deliberate exclusion, that "the tail's own failure path still
leaves the cancel to its caller" — this is that exclusion meeting a caller that cannot perform it.

## Reproduce

From `packages/integration-tests`, 4 runs in 5:

```
npx vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts
```

The scenario prints its own retry decisions (`printRetryDecisions`), which is where the table
above comes from. A run reporting "7 skipped" died at `bootControlTrio` instead and belongs to
`control-peer-row-refresh-invisible-to-third-node`, not here.
