----
description: A machine can refuse to answer its own queries for a while, reporting that no one is available to coordinate. Seen both after a machine drops off the network and comes back, and on a brand-new machine that has never been on the network before — the new machine fails to start at all.
prereq:
files: packages/integration-tests/src/scenarios/convergence-stress.integration.ts ("Disconnection Resilience" block), packages/integration-tests/src/scenarios/provider-seed-accepted.integration.ts (step 4, node B), ../optimystic/packages/db-p2p/src/libp2p-key-network.ts (canSelfCoordinate ~line 240-300, the throw at ~line 539)
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

## Second arm: a COLD-START node hits the same block during schema creation

Added 2026-08-03 by the review of `29.5-provider-seed-accepted-by-real-node`. Same message, same
throw site, but the node is not rejoining anything — it has never been on the network before, and
it never finishes starting.

`provider-seed-accepted.integration.ts` step 4 provisions node B as the **third** real `cadre-cli`
child in a party that already has the owner node and node A running. B's own log:

```
✓ Pinned 1 owner key(s) for cold-start seed trust
✓ Health server on port 59711, metrics on port 59712
✓ Seed endpoint authenticated (POST /seed requires bearer token)
Failed to start cadre node: Failed to execute DDL: create table CadreControl.Revocation (…)
Error: Module 'optimystic' create failed for table 'Revocation': Failed to initialize Optimystic
table: Self-coordination blocked: grace-period-not-elapsed. No coordinator available for key.
```

Note what is missing: no `✓ Connected to control network`. The process dies inside control-schema
DDL, so the container never reports healthy and the provider's enrollment poll times out at 90 s.

Three things this arm adds:

- **It is a startup failure, not a query failure.** The first arm's node is up and answering; this
  one never gets there. A user-visible symptom (a hosted node that simply will not provision) that
  no amount of retrying at the query layer can reach.
- **It is not covered by the control-write retry.** `retryControlWrite`
  (`packages/cadre-core/src/control-write-retry.ts`) classifies only transactor aggregates and
  unanswered super-majority shortfalls as transient; `Self-coordination blocked: …` matches neither,
  so the DDL is never re-presented. Whether it *should* be is a real question for this ticket:
  unlike a commit-phase aggregate, a DDL that failed to find a coordinator is a proven non-commit,
  so re-presenting it is safe. Decide that deliberately rather than by omission.
- **Which of the two `grace-period-not-elapsed` branches fires here is NOT established** — inferred
  from the message alone (`repro: static` for this arm specifically). Both documented branches
  require `connections.length === 0`, and a node that has just dialled two bootstrap peers should
  not be at zero, so the same "resolve the contradiction with `DEBUG='optimystic:*'`" instruction
  above applies here, on the cheaper of the two repros.

Frequency: 1 of 3 runs on 2026-08-03 (of the other two, one failed steps 3 and 5 on
`fix/0-bug-control-collection-header-absent-at-committed-revision` with step 4 never reached, and one
was fully green in 43 s). A red run costs ~2 minutes:

```
yarn workspace @serfab/integration-tests test src/scenarios/provider-seed-accepted.integration.ts
```

`convergence-stress` remains the cheaper repro for the first arm; use this one only if a fix needs
to be proven against the cold-start path too.

## Constraints

- **You may read `../optimystic` freely. You may not edit its sources.** It is an active workspace
  belonging to someone else. Rebuilding its `dist` (`yarn build`) is fine and is sometimes required
  for the freshness guard.
- Do not lengthen a timeout or add a bare sleep to make this pass. If the scenario is racing the
  reconnect, wait on the reconnect itself.
- Do not skip, `todo`, or loosen this scenario. It covers landed behaviour.
- Unrelated to `fix/0-bug-control-collection-header-absent-at-committed-revision`, which is the
  other survivor of the same measurement — different fingerprint, do not merge them.
