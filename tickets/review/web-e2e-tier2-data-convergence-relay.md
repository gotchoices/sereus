---
description: Review the relay-default + browser circuit-relay reservation work. Partial outcome — 13/16 e2e specs pass; the 3 data-convergence specs are still failing on a cluster-supermajority issue uncovered after the dial fix, *not* on the dial path itself. Reviewer should weigh whether that warrants new fix tickets vs. accepting + handing off.
files: ../optimystic/packages/reference-peer/src/cli.ts, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/vite.config.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/distributed/_helpers.ts, packages/reference-app-web/README.md
---

## What landed

### Optimystic — `reference-peer` CLI relay default flip

`../optimystic/packages/reference-peer/src/cli.ts` now declares
`--no-relay` instead of `--relay` on the `interactive`, `service`, and
`run` commands; commander auto-defaults the option to `true`. A new
`resolveEffectiveRelay()` helper in `startNetwork()` collapses the
options into a single `effectiveRelay` bool:

- `--no-relay` explicit → off
- no inbound listen (`--no-tcp` + no `--ws-port`) → off
- otherwise → on

That value is passed straight into `createLibp2pNode({ relay, ... })`,
plus a `🔁 Circuit-relay server: on/off` log line for operator
visibility. The optimystic-side change rebuilds cleanly (`yarn
workspace @optimystic/reference-peer build`) and `@optimystic/db-p2p`
+ `@optimystic/reference-peer` test suites are both still green
(437 passing in db-p2p, 4 passing in reference-peer).

### Browser — kick the circuit-relay reservation flow into life

`packages/reference-app-web/src/lib/optimystic.ts`:

- Added `/p2p-circuit` to `listenAddrs` when the node boots in
  distributed mode. Without that, the libp2p AddressManager never
  calls `listener.listen('/p2p-circuit')` on the
  `circuitRelayTransport`, which is the exact line in
  `@libp2p/circuit-relay-v2/dist/src/transport/listener.js:55` that
  invokes `reservationStore.reserveRelay()` and kicks off
  `RelayDiscovery`. With it in place the browser actually requests a
  reservation as soon as it sees a HOP-capable peer.
- Added a small read-only `window.__optimystic` debug hook
  (`getMultiaddrs`, `getPeerId`, `getConnectionCount`) so the
  Playwright helper can poll for the relayed multiaddr without going
  through the DOM. The hook is torn down by `stopNode()`.

### Browser — multiaddr v12/v13 dedupe (the real fix that unstuck reservation)

`packages/reference-app-web/vite.config.ts` now dedupes
`@multiformats/multiaddr` across the bundle. Without this,
`@chainsafe/libp2p-gossipsub@14.x` (which calls `multiaddr.tuples()`)
gets handed a multiaddr instance from
`@multiformats/multiaddr@13.x` (where `tuples()` was deleted in
favour of `getComponents()`). The TypeError was thrown out of the
gossipsub topology's `onConnect` handler inside the registrar's
`_onPeerIdentify`, which short-circuited the entire protocol loop
**before** the circuit-relay HOP topology had a chance to fire.

This was the actual root cause of the original bug: not "the browser
never requested a reservation" but "the topology that would have
dispatched `relay:discover` never fired because an earlier topology
exploded on a version-mismatched API". Pinning to v12 (which keeps
both `tuples()` and `getComponents()` as backward-compat) lets every
consumer agree on a single instance until gossipsub upstream catches
up. Without this single line, the relay-default work in the optimystic
CLI is observable but invisible — the browser sees a HOP-capable peer
connect and silently fails to act on it.

### E2E fixture — network name + flag cleanup

`packages/reference-app-web/e2e/fixtures/reference-peer.ts`:

- Spawned peers now receive `--network sereus-web-reference` (matches
  the browser's default). Previously they defaulted to `optimystic`,
  and the identify protocol-prefix mismatch
  (`/optimystic/sereus-web-reference/id/1.0.0` vs.
  `/optimystic/optimystic/id/1.0.0`) blocked identify from completing
  entirely — which in turn meant no `peer:identify` events for the
  registrar to fan out, and no HOP topology fires. This is fundamental
  for the whole identify-based protocol stack, not just relay.
- Dropped the now-removed `--relay` flag from the spawn args (the
  CLI rejects unknown options now that `--no-relay` is the only relay
  flag).

`packages/reference-app-web/e2e/distributed/_helpers.ts`:

- New `expect.poll` in `connectToBootstrap` that gates each browser
  page on a `/p2p-circuit/p2p/<self>` multiaddr being advertised by
  the running node, via the `window.__optimystic.getMultiaddrs()` hook
  above. Verifies the reservation actually landed before letting the
  spec exercise NetworkTransactor.
- Widened `localStorage.debug` to include `libp2p:identify*` and
  `libp2p:registrar*`, and broadened the console filter to surface any
  `libp2p:` namespace. Both are still gated on
  `OPTIMYSTIC_E2E_DEBUG=1` so they're zero-cost when not debugging.

### Docs

`packages/reference-app-web/README.md` now reflects the relay-on-default
mesh recipe, the explicit `--network sereus-web-reference` requirement
in the manual cluster shell-out, and removes the dropped `--relay`
flag from all command examples.

## Outcomes

- Browser `node.getMultiaddrs()` reliably advertises
  `/ip4/.../tcp/9191/ws/p2p/<relay>/p2p-circuit/p2p/<browser>` after
  `connectToBootstrap`. Verified via the new helper poll and direct
  console traces (`libp2p:circuit-relay:transport:reservation-store
  created reservation on relay peer <id>`, expiry 7200s).
- `yarn workspace @serfab/reference-app-web test:e2e` runs
  **13 / 16 passing** (up from 10 / 16 before this work). All 10 Tier 1
  specs still pass. All 3 Tier 2 specs that don't depend on multi-tab
  data convergence now pass (mode-flip × 2, bootstrap-persistence).
- `yarn workspace @optimystic/db-p2p test` → 437 passing.
- `yarn workspace @optimystic/reference-peer test` → 4 passing.
- `yarn workspace @serfab/reference-app-web build` succeeds. typecheck
  clean.

## Known gaps — DO NOT mark this complete without addressing

The three Tier 2 data-convergence specs still fail, but **not on the
dial path**:

- `e2e/distributed/two-tab-convergence.spec.ts`
- `e2e/distributed/cross-tab-activity.spec.ts`
- `e2e/distributed/disconnect-mid-session.spec.ts`

Failure mode after the relay fix: writes from tab A reach the cluster,
3 cluster members respond to the promise-vote, but
`cluster-tx:supermajority-failed` fires inside
`@optimystic/db-p2p/dist/src/repo/cluster-coordinator.js:206`. The
relevant trace pattern (from the browser console under
`OPTIMYSTIC_E2E_DEBUG=1`):

```
cluster-tx:promise-response (×3)
cluster-tx:promise-summary
cluster-tx:promise-merge-input
cluster-tx:promise-merge-result
...
cluster-tx:supermajority-failed
coordinator-repo:pend-error
```

The relay reservation is *working* — the reviewer can verify
independently by inspecting the browser's `__optimystic.getMultiaddrs()`
after a manual two-tab connect. The remaining issue is two layers up:

1. **Cluster-size mismatch.** Browser builds with `clusterSize: 3`
   (see `packages/reference-app-web/src/lib/optimystic.ts:136`),
   service peers default to `clusterSize: 10` in
   `@optimystic/db-p2p/dist/src/libp2p-node-base.js`. The
   reference-peer CLI exposes no `--cluster-size` option to override.
2. **Strict super-majority threshold.** With `superMajorityThreshold:
   0.67` (default) and a 3-peer cluster, `ceil(3 * 0.67) = 3` — every
   single picked peer must approve, leaving zero slack. With the
   browser tab itself sometimes picked into the cluster by `findCluster`
   (FRET deterministic cohort), any cross-browser-tab dial that even
   slightly underperforms fails the whole vote.

Neither of these is a *dial* problem and neither was in scope for the
relay-reservation ticket. They want their own fix tickets:

- Option A: add `--cluster-size` to `reference-peer` CLI and pass
  `--cluster-size 3` from the e2e fixture. (Smallest delta — gets the
  service peers and browser onto the same cluster-size assumption.)
- Option B: lower the e2e fixture's effective super-majority to
  `0.51`, so 2-of-3 approvals is enough. (Would need a CLI/env hook
  on the reference-peer and the browser side.)
- Option C: look at why the 3-of-3 approvals are arriving but the
  merge reports < supermajority — there may be an *approval-counting*
  bug inside `cluster-coordinator.js` rather than a dial-availability
  one. (Most likely the correct fix but the deepest dive.)

The existing `tickets/backlog/network-transactor-dial-timeout.md` is
not the same issue — the dial timeout was the symptom of un-dialable
peers, which is fixed.

## How to verify

- `yarn workspace @optimystic/reference-peer build` then
  `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"` —
  expect **3 pass / 3 fail**, identical to what this ticket landed.
- Manual: bring up the bootstrap + two browser tabs per the README,
  open the browser devtools console with
  `localStorage.debug='libp2p:circuit*,libp2p:registrar*'`, and watch
  for `created reservation on relay peer`. After the reservation
  message fires, `window.__optimystic.getMultiaddrs()` returns a list
  containing a `/p2p-circuit/p2p/` entry. (The two-tab data-convergence
  symptom is reproducible from this point — A's writes don't appear in
  B's poll-driven view — but the dial path is healthy.)
- Sanity: `yarn workspace @optimystic/db-p2p test` should still hit
  437 passing.

## Reviewer checklist

- The relay-default change in `cli.ts` is **a behaviour change for
  downstream consumers**. Confirm the `--no-relay` opt-out is acceptable
  and the optimystic-side commit message will note the change clearly.
  The threshold check (`hasInboundListen`) is intentionally permissive —
  any peer with an outward-facing listen address gets a relay server.
- The vite multiaddr dedupe is a workaround for upstream
  gossipsub-vs-multiaddr version drift. Worth a note in
  `docs/architecture.md` if not already there; this is the kind of
  change that quietly disappears in a future libp2p upgrade.
- The `--network sereus-web-reference` requirement is now load-bearing
  for *anything* that wants to talk to the browser reference — manual
  ops as well as CI. README documents it; flagged here in case
  Sereus-Health or other downstreams spin up their own service peers.
- The window `__optimystic` debug hook is exposed unconditionally
  (not gated on `import.meta.env.DEV`). It is read-only and exposes
  nothing sensitive; the alternative — gating it on env — would mean
  it's missing from production bundles where users sometimes need it
  for support debugging. If the reviewer feels strongly the surface
  should shrink, gate it.

## Follow-ups (out of scope, but raise these as fix/ tickets)

- **`web-e2e-tier2-cluster-supermajority.md`** (priority — without this
  the original ticket's acceptance criterion isn't met) — pick one of
  the three options above for the 3-of-3 supermajority failure.
- **`reference-peer-cluster-size-cli.md`** — add a `--cluster-size`
  flag to the reference-peer CLI so the e2e fixture and the browser
  agree on a configurable cluster size end-to-end.
- The existing
  `tickets/backlog/network-transactor-dial-timeout.md` — still
  worthwhile (30s is generous and slows test feedback), but no longer
  the blocker it appeared to be.
- The vite multiaddr dedupe should ideally be removable once
  gossipsub upstream migrates to `getComponents()`.

## End
