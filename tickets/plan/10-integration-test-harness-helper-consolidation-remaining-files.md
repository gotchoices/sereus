<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-31T01:37:22.768Z (agent: claude)
  Log file: C:\projects\sereus\tickets\.logs\10-integration-test-harness-helper-consolidation-remaining-files.plan.2026-07-31T01-37-22-768Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Five more integration-test scenario files still keep their own private copies of the same test setup code that was just moved into the shared test harness, so the cleanup is only half done.
prereq:
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/scenarios/membership-connection-gater.integration.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, packages/integration-tests/src/scenarios/control-stream-authz.integration.ts
difficulty: easy
----

## Background

The ticket `integration-test-harness-helper-consolidation` moved shared scenario setup
helpers into the integration-test harness. Its review pass found the move covered only
10 of the 15 scenario files that carry those helpers. The five listed in `files:` above
still define private copies.

One of them, `strand-addr-seed-convergence.integration.ts`, even carries an explicit
in-file note saying its helpers are copied verbatim and that de-duplicating them is
tracked by that very ticket ("copy, don't refactor, until that lands") — so the note is
now stale and must be removed as part of this work.

The shared versions now live in `packages/integration-tests/src/harness/node-fixtures.ts`
and are re-exported through `packages/integration-tests/src/harness/index.ts`:
`wsTransports`, `createSignedSAppConfig`, `ControlNodeOpts`, `controlNodeConfig`,
`makeOwnOwner`, `randomPeerId`, `connectControlNodes`, `bootPair`.

## What still duplicates what

| File | Local copies it still has |
| --- | --- |
| `membership-connection-gater` | `wsTransports`, `nodeConfig`, `makeOwnOwner`, `waitForConnection` |
| `strand-addr-seed-convergence` | `wsTransports`, `createSignedSAppConfig`, `nodeConfig`, `makeOwnOwner`, `connectControlNodes`, `controlAddrs` |
| `control-cohort-three-node-isolation` | `wsTransports`, `nodeConfig`, `makeOwnOwner`, `connectionsTo`, `hasOutboundTo`, `peerStoreAddrsFor`, and its whole private `bootTrio` (see the arm below) |
| `control-cohort-cold-start-retry` | `wsTransports`, `nodeConfig`, `makeOwnOwner`, `randomPeerId`, `connectionsTo` |
| `control-stream-authz` | `wsTransports`, `nodeConfig`, `makeOwnOwner`, `waitForConnection` |
| `control-write-degraded-cohort-member` | `nodeConfig` only (added after this ticket was filed; its `makeOwnOwner`/`randomPeerId`/`wsTransports` copies were already folded back into the harness during that ticket's review) |

`createSignedSAppConfig`, `makeOwnOwner`, `randomPeerId`, `connectControlNodes` and
`wsTransports` are character-identical to the shared versions (modulo `makeOwnOwner`'s
return type, which is source-compatible: some copies return nothing, the shared one
returns the owner public key and callers may discard it). Those five swap in directly.

## The parts that need a decision, not just a swap

The local `nodeConfig` builders are **not** all identical to the shared
`controlNodeConfig`. Three differences to resolve:

- **`strandFilter`** — `membership-connection-gater` and `control-stream-authz` build
  their nodes with `strandFilter: { mode: 'none' }`; the shared builder hardcodes
  `'all'`. Needs to become an option.
- **`trustedOwners`** — `control-cohort-three-node-isolation` passes
  `trustedOwners: { pinnedKeys: [...] }`; the shared builder has no equivalent option.
- **`hibernation`** — `membership-connection-gater`'s local builder omits the
  `hibernation` key entirely, while the shared builder always emits
  `hibernation: { enabled: false }`. Confirm against `packages/cadre-core/src/cadre-node.ts`
  (it reads `config.hibernation ?? { enabled: false }`) that omitting and explicitly
  disabling are equivalent before treating this as a no-op — this was the one check the
  review pass ran out of budget before finishing.

Three more small helpers are duplicated across pairs of these files and are good
candidates to hoist alongside: `waitForConnection` (gater + stream-authz — and
`node-fixtures.ts` already has a private one, `waitForControlConnection`, that would be
exported instead of re-implemented), `connectionsTo` / `hasOutboundTo`
(three-node-isolation + cold-start-retry), and `controlAddrs` (strand-addr-seed plus
`push-wake-e2e`, which still keeps its own).

## Arm added 2026-07-31 (review of `debt-cohort-edge-carries-data-coverage`)

That ticket added a second scenario built on the same three-node topology,
`control-cohort-edge-carries-data.integration.ts`, and — deliberately, to avoid
destabilising a scenario it was not asked to touch — **ported** rather than moved the
isolation scenario's private `bootTrio` into a new shared harness module,
`packages/integration-tests/src/harness/control-trio.ts` (`bootControlTrio` /
`stopControlTrio`). It also lifted `connectionsTo` / `hasOutboundTo` /
`peerStoreAddrsFor` into `node-fixtures.ts`. So the isolation scenario now has a
full shared twin of its ~150-line boot sequence sitting beside it: two copies of the
same delicate ordering proof, which will drift.

Fold into this ticket's sweep of `control-cohort-three-node-isolation`: delete its
private `bootTrio` and the three connection helpers, and have it call
`bootControlTrio` (whose `gaterB` option is optional, so the isolation scenario simply
omits it). The shared module's header already records that it is a port awaiting this
ticket — remove that note when it lands.

Two of the "needs a decision" items above are now settled by that work:
`controlNodeConfig` gained a `pinnedOwnerKeys` option (emits
`trustedOwners: { pinnedKeys }`) and a `connectionGater` option, so the isolation
scenario's `trustedOwners` difference no longer blocks the swap.

## Expected outcome

No scenario file defines any helper that the harness already provides. The five files
import from `../harness/index.js`. Behavior must be unchanged — every node config these
files produce must be byte-for-byte the same object shape as before.

## Validation

The whole integration suite runs green in about 3.5 minutes and is well inside the
agent-runnable window:

```
cd packages/integration-tests && npx vitest run --reporter=dot
```

Baseline at the time of writing: 32 files / 146 tests passing. Also run
`yarn workspace @serfab/integration-tests typecheck` and `yarn lint`.

Note: the suite's stale-build guard checks the sibling `C:\projects\quereus` workspace.
If it trips, rebuild with `cd C:\projects\quereus\packages\quereus && npx tsc` — the
`yarn workspace @quereus/quereus build` form silently no-ops from some shells.
