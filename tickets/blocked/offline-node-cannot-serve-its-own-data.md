----
description: A machine that loses its network connection refuses to answer its own queries for the next 30 seconds, reporting that nobody is available to handle the data. The cause is in the sibling optimystic project, which this repo is not allowed to edit, so a fix has been filed there instead.
prereq:
files: packages/integration-tests/src/scenarios/convergence-stress.integration.ts (Disconnection Resilience, line 395), ../optimystic/packages/db-p2p/src/libp2p-key-network.ts (shouldAllowSelfCoordination ~240-300, throw ~534-541), ../optimystic/tickets/fix/self-coordination-grace-period-denies-a-lone-node-its-own-keys.md
difficulty: medium
repro: verified
----

# A node with zero connections cannot resolve a coordinator for any key

**Why this is in `blocked/`:** the one code site that must change is
`../optimystic/packages/db-p2p/src/libp2p-key-network.ts`, in a repository this one may read but
not edit. Nothing in Sereus can reach it — the knob that would soften it
(`SelfCoordinationConfig.gracePeriodMs`) is never plumbed by any caller, in either repo, so there
is no configuration answer either.

**Unblock condition:** `../optimystic/tickets/fix/self-coordination-grace-period-denies-a-lone-node-its-own-keys.md`
lands and `../optimystic` is rebuilt (Sereus consumes its `dist` through the root `resolutions`
`link:` entries). Then re-run the repro below; if it is green, close this ticket and update the
entry in `tickets/.pre-existing-known.md`.

## Vocabulary

- **Coordinator** — the one peer chosen to drive a read or write for a given piece of data.
- **Self-coordination** — a node choosing *itself* as that peer, rather than a remote one.
- **Grace period** — a 30-second window after a node's last connection drops, during which
  optimystic refuses to let it self-coordinate.

## What was measured (2026-08-03)

```
cd packages/integration-tests
npx vitest run --reporter=verbose convergence-stress -t "Disconnection"
```

**4 of 4 runs red.** The failure is at `convergence-stress.integration.ts:395`:

```
QuereusError: Error during query on table 'Message': Query failed: Self-coordination blocked:
grace-period-not-elapsed. No coordinator available for key.
```

That line is step 3 of the scenario — *"verify data persists on both sides while disconnected"* —
a `select count(*)` issued deliberately while the node has no connections. **It is not the
reconnect step**, despite the test's name; the reconnect at step 4 is never reached.

`DEBUG='optimystic:*'` over the failing query, three consecutive attempts:

```
findCoordinator:connected-peers key=x5NnPHysmXfY count=0 peers=[] attempt=0
self-coord-blocked: grace-period-not-elapsed since=2290ms
findCoordinator:fret-self-dropped … attempt=0
… attempt=1  since=2793ms
… attempt=2  since=3308ms
findCoordinator:self-coord-blocked key=x5NnPHysmXfY reason=grace-period-not-elapsed
```

So the node genuinely holds **zero** connections, and 2.3–3.3 s have passed against optimystic's
30-second default. Both of the two code branches that produce this message require zero
connections, and both log the identical string — so the original ticket's "find out which branch
fires" question is unanswerable from a log *and* immaterial: the precondition is the same either
way.

## Why this is optimystic's defect and not the scenario's

The guard exists to stop a partitioned node from unilaterally acting as coordinator and forking
the data. But after the 30 seconds elapse it permits exactly that, with only a warning
(`extended-isolation`). No new information arrives in those 30 seconds; the node just waits. So
for a **read** — where self-coordination means "answer from my own copy", at worst staleness the
isolated node has already accepted — the delay buys nothing and costs the node every query it
would otherwise have answered. `docs/cadre-consistency.md` line 9 names "mobile devices, sleeping
laptops, NAT'd nodes" as the motivating case, which is precisely the population this hits.

Full argument, with the branch-level detail, is in the optimystic ticket named above.

## Two honest caveats a re-measurer should know

- **The same file run whole is green.** `npx vitest run convergence-stress` (all three tests) was
  3 of 3 green on 2026-08-03. With the earlier two tests running first, the disconnected node was
  observed still holding **one** connection at the moment of the offline read
  (`connected-peers count=1` → `self-coord-allowed: extended-isolation`), so the guard never
  fired. Use the `-t "Disconnection"` form to reproduce.
- **That green run means the scenario is not proving what it claims.** If the node can still hold
  or re-acquire a connection during the "disconnected" window, step 3 is answered by the *peer*,
  not from local storage, so it demonstrates nothing about offline persistence. The scenario hangs
  up only the strand-level connections and does not stop the node from re-dialling. Worth
  tightening once this is unblocked — but do **not** weaken it now, and do not chase it as a
  separate ticket while the underlying guard still fails the honest case.

## Related, deliberately not merged

- `tickets/implement/1-control-write-retry-covers-self-coordination-blocked.md` — the Sereus-side
  half of the *other* symptom of this same guard: a cold-start node dying during control-schema
  DDL. That one is actionable here and is not blocked on this.
- `blocked/control-coordinator-answers-absent-without-asking-cohort` — the other failure
  fingerprint in `provider-seed-accepted.integration.ts`. Different message, different site; do
  not merge.
