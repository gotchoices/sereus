description: An automated end-to-end test now covers the case node lending exists for — a phone, which can only make outgoing connections, asking a self-hosted machine for a node and then staying connected to it across both a node restart and a phone restart.
files: packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts (new), packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/test/control-node-config.spec.ts, docs/testing.md, docs/cadre-host.md, tickets/.pre-existing-error.md (new, unrelated)
----
# End-to-end: a phone-shaped requester borrows a cadre-host node

Implemented from the plan in `implement/donation-scenario-phone-shaped-requester`. Both prereqs (`donated-node-reachable-by-phone`, `owner-keeps-dialing-node-it-added`) had already landed and are archived in `complete/`.

## What landed

**The scenario** — `packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts`, nine ordered `it` steps so a failure names the step it broke on. In-process `GrantService` + `DonationService` + `HostProcessOrchestrator` spawning a real `cadre-cli` child, exactly like the sibling `cadre-host-node-donation.integration.ts`. The difference is the requester: an in-process `CadreNode` with `listenAddrs: []`, WebSocket + circuit-relay transports only, no TCP, `profile: 'transaction'`, a persistent identity key, and owner genesis run on itself — the shape `packages/reference-app-rn/src/phone-node-config.ts` builds, minus WebRTC.

The nine steps are as the plan specified: requester up and undialable; `provision` with `bootstrapNodes: []`; a `/ws` address on the child; vouch + seed; the requester dials in; rows cross both ways; the node respawns onto the same WebSocket port and the requester reconnects; the requester restarts on its retained identity, storage and dial targets and reconnects with no second donation request; `terminate`. Port band **20340–20499**, which no other scenario uses.

**One harness seam added** — `ControlNodeOpts.bootstrapPeerStore` in `src/harness/node-fixtures.ts`, forwarded to `bootstrapPeers.store`. Step 8 needs the restarted requester to hold the dial targets the first incarnation retained; there was no way to inject that store, and `controlNodeConfig` is the one builder every scenario's node config comes from. Two tests were added to `test/control-node-config.spec.ts` alongside the existing `storageProvider` and `pinnedOwnerKeys` cases — one that the store is forwarded verbatim, one that `bootstrapPeers` is left **off** entirely when no store is supplied (a builder that emitted an empty object would silently drop a restarting node's retained targets while the scenario still went green off another dial source).

**Docs** — `docs/testing.md` gained a bullet in the scenario inventory. `docs/cadre-host.md` → "Status of the donation surface" no longer says the dial-in direction is unit-tested only, and no longer says a real respawned child rejoining the borrower's cadre is uncovered; it still says the `DonationSupervisor` itself is exercised only against a fake orchestrator, which remains true (see gaps).

## Use cases this pins

- A phone that can accept no inbound connection can still borrow a node and reach it. The requester's `getMultiaddrs()` is asserted empty **before and after** the connection exists, so a regression that silently added a listener cannot make the file pass for the wrong reason.
- `POST /grants` with no bootstrap addresses works, and the empty list round-trips through `donations.json` as `[]` rather than `undefined` (a record with the field missing is refused by `respawn` as "predates persisted spawn inputs", so step 7 would fail rather than step 2).
- A lent node's addresses are a **mixed** list — TCP and `/ws`, loopback and LAN — and are handed to `dial()` unfiltered. The requester has no TCP transport and the dial still lands.
- A respawned lent node comes back on the same WebSocket port, and the requester reconnects off its own reconcile pass with no further donation call.
- A restarted requester reconnects from what it carried across the restart alone.

## How to run it

```
yarn workspace @serfab/cadre-core build
yarn workspace @serfab/cadre-cli build
yarn workspace @serfab/cadre-host build
cd packages/integration-tests
yarn test src/scenarios/cadre-host-donation-phone-requester.integration.ts
```

## Validation

- **6 green runs of the scenario, 0 red.** Three before the step-7 hardening described below, three after (the last two on the exact final bytes).
- **Falsification, measured — this file has teeth.** `childListenAddrs` in `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts` was edited to return the TCP entry alone, `@serfab/cadre-host` rebuilt, and the scenario re-run: **RED at steps 3, 5, 6, 7 and 8** (steps 1, 2, 4 and 9 do not touch the address and correctly stayed green — step 4's seed is accepted by a node nobody can reach). The line was restored, cadre-host rebuilt, and the file returns 9/9. The recipe is written into the file header so it can be re-verified after a change to either side.
- **Step 7 was hardened mid-pass.** Its "wait for a connection whose id is new" check is only a proof of reconnection while the pre-respawn id set is non-empty; an empty set would have made it true of the connection that was already there. `expect(staleConnectionIds.size).toBeGreaterThan(0)` now pins that, and it is one of the assertions the falsification run trips.
- **No regression from the harness change:** `cadre-host-node-donation.integration.ts` 6/6, `control-cohort-cold-start-retry.integration.ts` 1/1, and the package's own unit specs 13/13 in `control-node-config.spec.ts` (44/44 across `test/` before the two new cases).
- `yarn lint` exits 0.
- **Runtime:** 7.2 s–39.4 s of test time across the six green runs (plus ~10–30 s of vitest transform/import), so well inside the runner's 10-minute idle window. The red falsification run took 287 s because five steps ran out their timeouts; even that streams per-test output.

## Pre-existing failure, recorded not fixed

`yarn typecheck` fails in `@serfab/integration-tests` — three `findCluster(...)` call sites in `src/harness/control-cohort.ts` (139, 277) and `src/harness/forced-cluster.ts` (244) pass a bare `Uint8Array` where the linked `../optimystic` workspace now demands a branded `RoutingKey`. Upstream landed `routing-key-single-encoding` (`1e3bfd96`) on 2026-09-15; every other workspace's typecheck exits 0, none of the three files is in this ticket's diff, and `tsconfig.typecheck.json` already included them, so nothing here surfaced them. It is type-only, which is why every suite run above was green. Written up in `tickets/.pre-existing-error.md` for the triage pass. **Do not fold it into this review.**

## Known gaps — the reviewer should treat these as starting points

- **Step 8 does not pin which dial source produced the reconnection.** Both survive the restart by construction: the lent node's signed `CadrePeer` record is in the preserved control storage and is fresh, and its retained entry is in the preserved dial-target store. So the steady-state branch and the cold-start branch are both live and either could be doing the work. The step asserts the connection returns, and separately that `resolvePeerAddrs` resolves a `/ws` address — which pins that the record path is *available*, not that it was *used*. Distinguishing them would mean disabling one, the way `control-cohort-cold-start-retry.integration.ts` strips a peerStore entry. A `NOTE:` at the site says this. The plan's claim that "step 8 exercises the signed-record path" is therefore **not** proven by this file.
- **Dial direction is asserted on the requester's side only.** Steps 5, 7 and 8 require `direction === 'outbound'` on the requester. The lent node's side is checked only as `connectionPaths.total >= 1` in its `/status`, not as "holds no outbound connection to the requester". A lent node has no address to dial a phone with, so this is belt-and-braces, but the plan asked for it explicitly and it is not there.
- **`peersAdded` is deliberately not asserted at step 4**, unlike the sibling scenario. `applySeed` counts only seed peers carrying multiaddrs, and a phone-shaped owner contributes none, so the count measures nothing here. A comment says so. If a reviewer wants a stronger step-4 gate, the honest one is on the node's own trusted-owner anchor, not on this count.
- **Strand replication onto a lent node is untested and out of scope** — nothing registers an sApp config on a lent node, so it launches no strand. The open question is `blocked/always-on-nodes-host-strands-of-apps-they-do-not-run`.
- **The `DonationSupervisor` is still only exercised against a fake orchestrator.** This scenario calls `DonationService.respawn` directly. What a real supervisor adds — backoff, give-up, non-overlapping passes — is not covered here.
- **Loopback only.** A green run says nothing about a phone reaching the host across a home NAT (`backlog/feat-cadre-host-wan-grant-reachability`).
- **Timing variance is unexplained.** Test time ranged 7.2 s to 39.4 s across six green runs with no failures. Most likely a reconcile pass landing on a later tick, or a slower child spawn, but it was not investigated. Budgets are generous enough (90 s per step) that it has headroom, but a reviewer looking for flake risk should start there.
- **A single machine's interface set.** `wsPortsOf` expects exactly one `/ws` port, which holds because a child binds one port on `0.0.0.0` and libp2p reports it once per interface. This was only ever run on one Windows host.
