---
description: Make the 3 data-convergence Tier 2 specs (two-tab, cross-tab activity, disconnect mid-session) pass against the spawned reference-peer fixture
files: packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/global-setup.ts, packages/reference-app-web/e2e/global-teardown.ts, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/src/lib/network.svelte.ts, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/README.md, packages/reference-app-web/e2e/distributed/_helpers.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts
---

## Goal

After `tickets/complete/web-e2e-tier2-connectivity` landed, the connectivity layer is healthy (mode flip, bootstrap persistence — all green) but the three **data-convergence** specs still fail because a write from one browser tab never lands on the other:

- `two-tab-convergence.spec.ts` — A sends, B never sees the row (`toBeVisible` 20s timeout).
- `cross-tab-activity.spec.ts` — both sides poll for the union of 6 message IDs; the union is never observed.
- `disconnect-mid-session.spec.ts` — same shape: A's first message never reaches B before A disconnects.

All three share the same primitive failure: `pageA` writes via `MessageApp` → `NetworkTransactor` → `coordinatedRepo`, but `pageB`'s polling `get` against the same logical collection comes up empty.

## Root cause hypothesis

Re-stated from the fix ticket plus deeper inspection of the optimystic side:

- Browser builds a **`NetworkTransactor` over `coordinatedRepo`** in distributed mode (`packages/reference-app-web/src/lib/optimystic.ts:130-242`), with **`clusterSize = 3`** (`optimystic.ts:136`).
- `coordinatorRepo` is constructed from `libp2p-node-base.ts:343-353` with `clusterSize: options.clusterSize ?? 10` and `minAbsoluteClusterSize: 2` (`libp2p-node-base.ts:323`).
- Live peer topology at test time: `pageA` ↔ `bootstrap` and `pageB` ↔ `bootstrap`. The two browsers cannot dial each other (browsers can't listen). So the reachable cluster size from either browser is **2** (self + bootstrap), not 3.
- `ClusterTransactionCoordinator.processPendRequest` (`cluster-coordinator.ts:217-223`) rejects when `peerCount < cfg.clusterSize` and `allowClusterDownsize` is false; with the libp2p-node-base default it's true (`libp2p-node-base.ts:324`), so the pend technically proceeds. But the super-majority for the response (`cluster-coordinator.ts` checks against `superMajorityThreshold = 0.67`) over a configured 3-peer cluster effectively requires promises from peers the browser can't reach. The write either silently stalls until the 30s `timeoutMs` or commits locally on the browser without replicating to bootstrap.

The fixture peer's `--offline` flag is a red herring for this layer — `--offline` only changes the bootstrap's *own REPL* transactor, not the libp2p `repoService` it serves to remote callers (`libp2p-node-base.ts:172-188` — `repoProxy` always routes through `coordinatedRepo ?? storageRepo`). So the bootstrap is willing to participate in cluster consensus as a remote target; there just aren't enough other live peers to form a quorum for `clusterSize = 3`.

### Why "just set clusterSize = 1" is not obviously a fix

The fix-stage ticket recommends `clusterSize = 1`, but the cluster *membership* for a given block is chosen by FRET responsibility-K — i.e., **the single nearest peer by XOR distance to the blockId**, not "always the bootstrap". With three peers in the keyspace (`pageA`, `pageB`, `bootstrap`), block X's cluster might resolve to `[pageA]`, in which case:

- `pageA`'s write to X goes via the self-bypass to its own `storageRepo` (`coordinator-repo-solo-self-bypass.spec.ts`) — never reaches bootstrap.
- `pageB`'s read of X tries to dial `pageA` (impossible from a browser) and falls back / errors.

So `clusterSize = 1` only works if we *also* prevent the browsers from being considered as cluster members — i.e., a "thin-client" mode for browser peers, or force the cluster always to contain the bootstrap. Neither exists today.

### Concrete plan

Go **option 2** (real 3-peer mesh) but minimally: spawn the existing `--offline` bootstrap alongside **two extra `service` peers** that the bootstrap can mesh with. The browser then has three reachable remote peers (the bootstrap + two services), all running real cluster consensus. `clusterSize = 3` against ≥ 3 remote peers + self (4 in keyspace) gives a healthy quorum for any block.

This keeps the README acceptance scenario (one bootstrap on `:9091 --offline`) untouched for humans — only the e2e fixture grows. The bootstrap stays `--offline` because its own REPL transactor doesn't matter and the flag avoids it trying to drive consensus before the service nodes appear.

## Architecture

### Fixture topology

```
                           bootstrap (--offline, --ws-port 9191, --relay)
                              ↑          ↑          ↑
                              |          |          |
       pageA (browser) -------+          |          +-------- service-B (ws-port 9192)
                                         |
                                  service-A (ws-port 9193)
                                         |
                                       pageB
```

Concretely:

- One bootstrap peer (kept as-is): `interactive --ws-port 9191 --no-tcp --relay --offline`.
- Two service peers spawned with `service --ws-port <p> --no-tcp --bootstrap <bootstrap-multiaddr>`. The `service` subcommand already exists (`optimystic/packages/reference-peer/src/cli.ts:691-723`). They run real cluster consensus (no `--offline`).
- Browsers dial the bootstrap (unchanged). The bootstrap, having dialed the service peers during their startup, provides them to the browsers via libp2p peer discovery (or the FRET adapter).

If FRET discovery from the bootstrap is too slow to satisfy the 30s `connectToBootstrap` window, the simplest fallback is to have the browser dial all three multiaddrs (comma-separated) by setting `bootstrap-input` to a multi-line list in `connectToBootstrap` — already supported by `parseMultiaddrs` (`packages/reference-app-web/src/lib/network.svelte.ts:110-115`).

### Fixture lifecycle

`spawnReferencePeer` in `e2e/fixtures/reference-peer.ts` becomes `spawnReferenceMesh`, returning `{ bootstrapMultiaddr, serviceMultiaddrs, stop }`. Internally it:

1. Spawns the bootstrap as before, waits for its `/ws/p2p/...` multiaddr.
2. Spawns two `service` children with `--bootstrap <bootstrapMultiaddr>`. Waits for each to advertise its own `/ws/p2p/...`.
3. Returns all three multiaddrs.

`global-setup.ts` writes the bootstrap multiaddr to `FixtureState` (unchanged), and additionally writes the two service multiaddrs to a new `serviceMultiaddrs: string[]` field so specs can opt into a multi-line bootstrap input. `_helpers.ts:connectToBootstrap` is extended to optionally fill the textarea with all three addresses (newline-separated) — this is the safest path; FRET-only discovery is a follow-up nice-to-have.

`global-teardown.ts` kills all three children (currently only kills one — adjust to drain the full list off `globalThis.__referencePeer`).

### Browser-side: no source changes

`startNode` and the Network panel stay as-is. `clusterSize` keeps its default of 3 in distributed mode. The bug was purely a fixture-topology mismatch, not a client-side defect.

### FixtureState schema

Extend `packages/reference-app-web/e2e/fixtures/state.ts`:

```ts
export type FixtureStateAvailable = {
  available: true;
  multiaddr: string;             // bootstrap (unchanged)
  serviceMultiaddrs?: string[];  // new — empty if env-provided
  source: 'spawned' | 'env';
  pid: number | null;
};
```

Env override path (`OPTIMYSTIC_WS_BOOTSTRAP`) keeps `serviceMultiaddrs: []`; a user-provided bootstrap is assumed to already be part of a real mesh.

### Verification step (phase 1)

Before changing the topology, run the failing spec **once** with browser-side debug enabled to confirm the quorum hypothesis. The cleanest hook is a `localStorage.debug` injected via `page.addInitScript`:

```ts
await page.addInitScript(() => {
  localStorage.debug = '@optimystic/*,libp2p:dial*';
});
```

Then run `yarn workspace @serfab/reference-app-web test:e2e --grep "two-tab convergence" --reporter list` and inspect `test-results/.../trace.zip` console messages. We expect to see either:

- `cluster-tx:reject-downsize` / `cluster-tx:size-variance` warnings from `cluster-coordinator.ts:140-146`, or
- repeated `findCluster` calls returning a cluster including peers the browser can't dial.

If the logs surface a *different* failure (e.g. the pend reaches bootstrap but commit doesn't, or the `RepoClient` request is denied at the protocol layer), reroute the rest of the plan accordingly — the multi-node mesh fix only addresses quorum-stall.

## Acceptance

- All 6 Tier 2 specs pass on a clean checkout (with `../optimystic` rebuilt). Concretely:
  - `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"` → 6 passed.
  - `yarn workspace @serfab/reference-app-web test:e2e` (full sweep) → 16 passed (10 Tier 1 + 6 Tier 2).
- The README's "Two-tab convergence test (acceptance check)" still works verbatim for a human running it locally — only the fixture grew, not the user-facing demo. Add a short paragraph noting that the e2e fixture now spawns a 3-node mesh internally.
- No regression in the now-passing Tier 2 specs (mode flip, bootstrap persistence) or Tier 1.
- The `connectionGater: { denyDialMultiaddr: () => false }` change from the prereq remains untouched (`packages/reference-app-web/src/lib/optimystic.ts:158`).

## Risks / fallbacks

- **Port collisions**: The fixture uses fixed `9191/9192/9193`. If a developer has anything on those, the fixture fails fast — preserve the existing error path. Document the ports in the README.
- **Bootstrap discovery latency**: If FRET doesn't propagate the service peers to the browser fast enough, `connectToBootstrap`'s 60s diag-connection wait may not see 3 connection rows. Easy mitigation: pass all three multiaddrs as bootstrap input in `_helpers.ts:connectToBootstrap` (the existing `parseMultiaddrs` handles whitespace/comma separators).
- **Service peer crash**: If a service peer dies mid-test, the browser's pend will eventually fall below quorum. The fixture's `stop()` already kills the bootstrap; extend it to track and kill all three. Watch for orphaned node processes between runs — `global-teardown.ts` is the single chokepoint.
- **Per-spec timing**: `cross-tab-activity` already uses 30s `expect.poll`; if 3-peer mesh introduces extra commit latency (it shouldn't, but the loopback handshake is real), bump the poll timeout cautiously, **not** the individual `sendOne` 30s timeout (that hides regressions).

## TODO

Phase 1 — verify
- Add a one-shot `page.addInitScript` with `localStorage.debug = '@optimystic/*,libp2p:dial*'` to `two-tab-convergence.spec.ts` (gated behind an env flag — `OPTIMYSTIC_E2E_DEBUG=1` — so it's not noisy by default).
- Run `yarn workspace @serfab/reference-app-web test:e2e --grep "two-tab convergence"` with `OPTIMYSTIC_E2E_DEBUG=1`; capture the trace's console messages.
- Confirm one of: `cluster-tx:reject-downsize`, repeated unreachable-peer dial attempts, or `findCluster` returning an unreachable cluster member. Document the observed log evidence inline in the next-stage `review/` ticket so the reviewer can compare.

Phase 2 — fixture grows to 3-node mesh
- Extend `packages/reference-app-web/e2e/fixtures/reference-peer.ts`:
  - Rename `spawnReferencePeer` → `spawnReferenceMesh` (keep the original signature wrapping the new one if any other caller exists — `Grep` for `spawnReferencePeer` first).
  - Spawn the bootstrap as today.
  - After the bootstrap multiaddr is captured, spawn two `service` children (`<cliPath> service --ws-port <p> --no-tcp --bootstrap <bootstrapMultiaddr>`) on ports 9192 and 9193.
  - Reuse the existing `scan()` / candidate-window logic per child to capture each service's `/ws/p2p/...` multiaddr.
  - Return `{ bootstrapMultiaddr, serviceMultiaddrs, stop }` where `stop()` kills all three children.
- Update `packages/reference-app-web/e2e/fixtures/state.ts` to add optional `serviceMultiaddrs?: string[]` on `FixtureStateAvailable`.
- Update `packages/reference-app-web/e2e/global-setup.ts` to write the new field; treat `OPTIMYSTIC_WS_BOOTSTRAP` env override as `serviceMultiaddrs: []` (caller responsible).
- Update `packages/reference-app-web/e2e/global-teardown.ts` to drain the full handle (will be obvious once `globalThis.__referencePeer` type changes).
- Update `packages/reference-app-web/e2e/distributed/_helpers.ts:connectToBootstrap` to accept the full multiaddr list from `FixtureState` and fill the textarea with `[multiaddr, ...serviceMultiaddrs].join('\n')` when service multiaddrs are present. This guarantees the browser dials all three immediately without waiting for FRET discovery.
- Update each Tier 2 spec's `requireFixture` call sites: pass the full list to `connectToBootstrap` (one-line change per spec, or push it into `requireFixture`'s return shape).

Phase 3 — validate
- `cd packages/reference-app-web && yarn build` — type check passes.
- `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2" 2>&1 | tee /tmp/tier2.log` — all 6 pass. (Stream the output; the full sweep can take 3-4 minutes.)
- `yarn workspace @serfab/reference-app-web test:e2e 2>&1 | tee /tmp/full.log` — 16 pass (10 Tier 1 + 6 Tier 2).
- If the verification phase exposed a different failure mode than the quorum-stall hypothesis, **stop** and update this ticket with the observed evidence instead of forcing the fix through.

Phase 4 — docs
- `packages/reference-app-web/README.md`: under "Tier 2 fixture resolution", add a short bullet that the spawned fixture now brings up a 3-node mesh (bootstrap on 9191 + two `service` peers on 9192/9193) so cluster consensus has a healthy quorum.
- Leave the manual "Two-tab convergence test (acceptance check)" section as-is — the human-facing path still uses a single `--offline` peer for the demo, with the caveat that real two-tab convergence depends on the cluster reaching quorum. If a careful human want to reproduce what the e2e does, they can run the three peers manually; that's a footnote.

Phase 5 — out-of-scope follow-ups (file as backlog only if confirmed needed)
- "Browser thin-client mode": a NetworkTransactor variant for browsers that doesn't enroll them as cluster members, so a single-bootstrap fixture suffices. Likely warrants a `plan/` ticket; do not start it here.
- Auto-discover bootstrap mesh: have the browser learn peers via FRET so the e2e doesn't have to pre-populate three multiaddrs. Same — follow-up, not this ticket.
