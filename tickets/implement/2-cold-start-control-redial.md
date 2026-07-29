---
description: A brand-new machine joining a group gets exactly one attempt to call the machine that invited it. If that single attempt fails — the other side is briefly down, the network hiccups — it never tries again and stays cut off forever.
prereq: scenario-vouch-reader-before-seed
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts, docs/architecture.md
difficulty: medium
---

# Cold-start bootstrap has exactly one chance to connect

## The defect

A node joining an existing party learns where to reach the owner from a seed. `applySeed`
(`packages/cadre-core/src/seed-bootstrap.ts:616`) does two things with that seed:

1. merges each seed peer's addresses into the libp2p peer store (line 669), and
2. dials the owner-flagged peers **once**, best-effort (line 682-694).

If that single dial throws, the error is logged and swallowed, `applySeed` still returns
`{ success: true }`, and **nothing ever dials again**.

The recurring routine that is supposed to keep a node connected to its siblings,
`reconcileControlCohort` (`packages/cadre-core/src/cadre-node.ts:1399`), cannot recover,
because it enumerates siblings from the *replicated* `CadrePeer` table:

```ts
const members = await this.listMembers();
const siblings = members.filter((m) => m.peerId !== selfPeerId);
if (siblings.length === 0) {
  return;                      // cadre-node.ts:1437 — cold start dead-ends here
}
```

At true cold start a joining node's control database is empty. Filling it requires reading
over the control-DB protocols, which requires a connection, which is the thing that failed.
So `siblings.length === 0` on every pass, forever.

The cold-start fallback that was written for exactly this case is unreachable.
`resolveControlDialAddrs` (line 1524) does consult the peer store when the `CadrePeer`
record yields no address — but it is only ever called from `dialControlSibling`, which is only
called for siblings already enumerated from the database. The peer-store entries `applySeed`
just wrote are never read by the reconcile pass while the table is empty.

Observed directly: in the failing `control-cohort-auto-convergence` run, once B's seed dial was
refused, B's reconcile fired every 2 s for 45 s and logged only
`refreshAuthorizedControlPeers(reconcile): 0 authorized peer(s)` — never a "pass complete" line,
never a dial, because it returned at the sibling check every time.

This is reachable in production today. The seed dial fails whenever the owner is momentarily
down, the relay reservation is not yet up, or a NAT traversal loses the race. The joining node
is then permanently stranded with no retry, no error surfaced to its caller, and no operator
signal beyond a debug log line.

## Why the sibling ticket does not cover it

`scenario-vouch-reader-before-seed` makes both convergence scenarios green by correcting how
they onboard the reader. That is the right fix for those tests, and it leaves this defect
untouched — those scenarios pass because the very first seed dial happens to succeed. Nothing
exercises the failure path.

## What to build

Give `reconcileControlCohort` a cold-start branch so a joining node keeps retrying its known
bootstrap addresses until the control database has real siblings.

Sketch of the shape (the implementer should confirm the details against the surrounding code):

- When `siblings.length === 0`, do not return immediately. Instead fall back to the addresses
  the seed left behind — the libp2p peer store entries `applySeed` merged, and/or a small
  in-memory record of the seed's owner-flagged peers kept by `SeedBootstrapService` — and dial
  those, best-effort, with the same per-peer error swallowing the normal path already uses.
- Skip peers already connected, exactly as step 3 of the existing pass does.
- Log the cold-start branch distinctly from the steady-state pass so an operator can tell which
  one is running. The current pass logs
  `reconcileControlCohort: pass complete (siblings=…, selected=…, dialed=…)`; a cold-start pass
  should say so explicitly rather than being silent.

Decisions the implementer needs to make and record:

- **Where the bootstrap addresses live.** The peer store is the path of least resistance and is
  already populated. It is also shared with everything else libp2p discovers, so at cold start it
  is small but not guaranteed to be *only* seed peers. If that is unacceptable, have
  `SeedBootstrapService` retain the owner-flagged `SeedPeer` list from the last applied seed and
  expose it to the node. State which you chose and why.
- **Whether to bound the retries.** A node that was seeded with a stale address will dial a dead
  peer on every pass indefinitely. Decide whether that is acceptable at the reconcile cadence
  (15 s default, `DEFAULT_CONTROL_COHORT_RECONCILE_MS`) or whether it needs backoff.
- **Whether `applySeed` should report dial failure.** It currently returns `success: true` even
  when every owner dial threw, so a caller cannot distinguish "seeded and connected" from
  "seeded and stranded". Consider adding a field to `ApplySeedResult` rather than changing the
  meaning of `success`, since callers treat `success: false` as "seed rejected".

## Regression test

Add a scenario that proves recovery from a failed first dial. The cleanest way to force the
failure without mocking transports is to reuse the gate that caused the original bug: have the
owner deny B's first dial (vouch B only *after* the seed has been applied and its dial refused),
then assert that B connects and converges anyway on a later reconcile pass. That exercises the
real code path — a refused dial followed by recovery — with no test doubles.

Put it in a new file rather than growing `control-cohort-auto-convergence.integration.ts`,
whose subject is the happy cold-start path.

## TODO

- [ ] Confirm the dead-end by reading `runReconcileControlCohort`
      (`cadre-node.ts:1413-1484`) — the early return at the sibling check is the whole bug.
- [ ] Decide where cold-start bootstrap addresses come from (peer store vs. retained seed peers)
      and record the choice in the code comment.
- [ ] Implement the cold-start dial branch in `runReconcileControlCohort`, with its own log line.
- [ ] Decide and implement the retry-bound question (unbounded at reconcile cadence, or backoff).
- [ ] Decide whether `ApplySeedResult` should surface "seeded but no connection established".
- [ ] Add the regression scenario described above; confirm it fails without the fix.
- [ ] Update `docs/architecture.md` (Control Network / Control Network Seed sections) to state
      that cold-start bootstrap retries, and what it retries against.
- [ ] Run the full integration suite from `packages/integration-tests` and confirm no regression
      against the post-`scenario-vouch-reader-before-seed` baseline.
