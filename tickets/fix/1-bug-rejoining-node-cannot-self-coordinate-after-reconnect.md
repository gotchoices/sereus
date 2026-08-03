----
description: After a machine drops off the network and comes back, it can refuse to answer its own queries for a while, reporting that no one is available to coordinate — even though it has reconnected.
prereq:
files: packages/integration-tests/src/scenarios/convergence-stress.integration.ts ("Disconnection Resilience" block), ../optimystic/packages/db-p2p/src/libp2p-key-network.ts (canSelfCoordinate ~line 240-300, the throw at ~line 539)
difficulty: medium
----

# A node that reconnects still reports `grace-period-not-elapsed` and refuses to coordinate

```
cd packages/integration-tests
npx vitest run --reporter=verbose convergence-stress
```

```
QuereusError: Error during query on table 'Message': Query failed: Self-coordination blocked:
grace-period-not-elapsed. No coordinator available for key.
```

Only the third test in the file fails ("Disconnection Resilience → should retain converged data
after disconnect and reconnect", ~4.2 s); the two burst/interleaved tests in the same file pass.

## Why this is newly visible

It is not a regression. Before `42cd12c` this whole file died earlier in the quorum path (the
corroboration floor could never be met by a two-node party — see
`blocked/control-db-cross-node-convergence-halted`), so this test never reached the disconnect step.
Two of the three tests in the file now pass, and this one gets far enough to hit a different wall.

## What the mechanism is

`canSelfCoordinate` in `libp2p-key-network.ts` blocks a node from acting as its own coordinator
while it looks partitioned, which is correct in general — a lone node that unilaterally self-selects
is how split-brain starts. Two branches return `grace-period-not-elapsed`, and both require
`connections.length === 0`:

- the FRET-unavailable fallback (~line 276): high-water mark above 1, no connections now, and
  `Date.now() - lastConnectedTime < gracePeriodMs`
- case 4 (~line 287): the same condition without the FRET failure

So the block only fires when the node currently has **no** connections. The test's name says it
reconnects. That is the contradiction to resolve, and it splits the outcome cleanly:

- **If the node genuinely has no connections at the moment of the query**, the scenario is racing
  its own reconnect — the test asserts on data before the dial has re-landed, and the fix is in the
  scenario (wait for a connection, not for a timer). Say so and fix it here.
- **If the node does have connections and is still blocked**, something upstream is stale —
  `lastConnectedTime` not being refreshed on reconnect, or a coordinator decision cached from the
  disconnected window. That is an upstream defect and this ticket moves to `blocked/` with the
  evidence.

Do not guess between those. `canSelfCoordinate` has a `this.log` on every branch it takes; run with
`DEBUG='optimystic:*'` (the package exposes `test:debug` for exactly this) and read which branch
fires, then log `libp2p.getConnections().length` and `lastConnectedTime` at the moment of the throw.

## Constraints

- **You may read `../optimystic` freely. You may not edit its sources.** It is an active workspace
  belonging to someone else. Rebuilding its `dist` (`yarn build`) is fine and is sometimes required
  for the freshness guard.
- Do not lengthen a timeout or add a bare sleep to make this pass. If the scenario is racing the
  reconnect, wait on the reconnect itself.
- Do not skip, `todo`, or loosen this scenario. It covers landed behaviour.
- Unrelated to `fix/0-bug-control-collection-header-absent-at-committed-revision`, which is the
  other survivor of the same measurement — different fingerprint, do not merge them.
