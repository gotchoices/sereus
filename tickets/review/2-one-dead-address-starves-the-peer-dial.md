description: Review the fix that stops a node from giving up on a peer because the first few addresses it tries never answer. Each address is now tried on its own short time limit, and the phone's "borrow a node" flow keeps dialing until its whole wait runs out.
files:
  - packages/cadre-core/src/peer-dial.ts (new: `dialPeerAddrs`, `tryAddrsInTurn`, `directBeforeRelayed`, the two default limits, `PeerDialBudget`)
  - packages/cadre-core/src/cadre-node.ts (`controlDialBudget`, `dialControlSibling`, `dialBootstrapPeer`, `resolveControlDialAddrs` doc, `dialBudget` passed to all four `SeedBootstrapService` constructions)
  - packages/cadre-core/src/seed-bootstrap.ts (`SeedBootstrapConfig.dialBudget`, `parseDialAddrs`, `applySeed` owner dials, `dialInvite`)
  - packages/cadre-core/src/strand-wake-protocol.ts (`dialWake` now uses `tryAddrsInTurn`)
  - packages/cadre-core/src/control-cohort.ts (per-peer default moved out to peer-dial.ts)
  - packages/cadre-core/src/types.ts (`network.controlCohort.perAddressDialTimeoutMs`)
  - packages/cadre-core/src/index.ts (exports)
  - packages/cadre-core/test/peer-dial.spec.ts (new, real libp2p), test/silent-server.ts (new helper), test/cadre-node-dial-past-dead-addresses.spec.ts (new, real CadreNode)
  - packages/cadre-core/test/cadre-node-control-cohort.spec.ts (fake dial is now one address per call; `dialFails` option)
  - packages/cadre-core/test/control-dial-mixed-transports.spec.ts (deleted; its case moved into peer-dial.spec.ts)
  - packages/reference-app-rn/src/host-node-request.ts (`connectToNode`, `reconcilePasses`, `connectMs` 30 s → 60 s)
  - packages/reference-app-rn/test/host-node-request.spec.ts
  - packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts (step 5 comment only)
  - docs/architecture.md (Control Network → cohort auto-connect bullet), docs/reference-app-rn.md (If the flow stalls)
----

# One unreachable address no longer stops a peer dial

## The problem

On a device run, borrowing a node from a cadre-host always failed at "Connecting to the node…". The lent node's address list started with LAN addresses the PC's firewall silently dropped; the forwarded loopback address that worked came later. `CadreNode` handed the whole list to one `libp2p.dial(addrs)` under one 20 s deadline. libp2p 3.1.3 tries a multi-address dial's addresses one at a time with no per-address limit and sorts loopback last, so the dropped addresses used up the whole deadline and the working one was never tried, on any pass.

## What changed

**`peer-dial.ts` (new).** `dialPeerAddrs(dialer, addrs, budget, label)` dials each address as its own `dial()` call, limited to `perAddressMs` (or whatever remains of `totalMs`, if less), and returns the first connection. Order: direct addresses first, then `/p2p-circuit` ones, otherwise the order given (`directBeforeRelayed`). Addresses with a transport the node lacks are not filtered out; libp2p rejects them at once. When every address fails it throws one error naming each address and its cause (the first failure is `cause`), and addresses the total left no time for are listed as "not tried". The loop itself is `tryAddrsInTurn`, which `dialWake` now uses too, keeping its own signalling-first order.

**libp2p problem found while doing this (worth checking).** If one address times out and the next address for the same peer is dialed straight away, libp2p's dial queue adds the new dial to the aborted dial job, which is still queued for a few microtasks. The new dial then fails with `AbortError` without touching the network, so that address is never tried. I reproduced this against real libp2p. `tryAddrsInTurn` waits one macrotask (`setTimeout(0)`) after a failed attempt before the next one. `peer-dial.spec.ts` and the new CadreNode spec both fail if that wait is removed; I ran that mutation. `dialWake` had the same problem before this change: after a timed-out first candidate, its second candidate could be rejected without being dialed.

**Defaults** (`peer-dial.ts`, overridable in `network.controlCohort`):
- `DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS` = 8 s (`perAddressDialTimeoutMs`). Chosen to cover a relayed dial on a mobile link, including opening the relay connection. Not measured.
- `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` = 30 s, up from 20 s (`dialTimeoutMs`, same key). Room for three dropped addresses ahead of a working one (3 × 8 s = 24 s, leaving 6 s; the phone's working dial measured 1.6 s). The constant moved from `control-cohort.ts` to `peer-dial.ts` because `seed-bootstrap.ts` needs it and `control-cohort.ts` already imports `seed-bootstrap.ts`.

**Callers.** `dialControlSibling`, `dialBootstrapPeer`, `SeedBootstrapService.applySeed` (owner dials) and `dialInvite` all use `dialPeerAddrs` with the node's configured limits (`CadreNode.controlDialBudget()`; `SeedBootstrapConfig.dialBudget`, defaulting to `DEFAULT_PEER_DIAL_BUDGET`). Behaviour changes to check:
- `applySeed` used to dial only an owner's FIRST address, with no time limit. It now tries all of them, each with a limit.
- `dialInvite` used to have no time limits and threw the last error. It is now limited and throws the combined error. Malformed addresses in either path are skipped and logged (`parseDialAddrs`) rather than failing the whole owner.
- A reconcile pass now costs up to 30 s per unreachable sibling, not 20 s.

**Phone flow (`host-node-request.ts` `connectToNode`).**
- The `connectMs` deadline now starts before the first reconcile pass. Before, it started after the pass, so the step really took the pass plus 30 s.
- Whenever a pass ends without a connection, the next poll starts another one (`reconcilePasses`: at most one pass started by the flow at a time). The flow no longer waits for the node's own timed pass.
- A pass that throws is reported as "This phone could not dial the lent node." and is not retried.
- `connectMs` went from 30 s to 60 s: two full per-peer dials.
- The old NOTE about a pass that listed siblings before `addDrone` is gone. A new NOTE covers the case where offline cadre members dialed ahead of the lent node use up the wait.

## How to validate

- `yarn workspace @serfab/cadre-core test`: 132 files, 2143 passed, 1 skipped.
- `yarn workspace @serfab/reference-app-rn test`: 19 files, 303 passed.
- Integration, run after building cadre-core, cadre-cli and cadre-host:
  - `cadre-host-donation-phone-requester`: 9/9.
  - Also green, 17 tests in total: `enrollment-e2e` (covers `dialInvite`), `control-cohort-cold-start-retry`, `control-cohort-auto-convergence`, `control-cohort-three-node-isolation`, `push-wake-e2e`.
- `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/reference-app-rn typecheck`, `yarn workspace @serfab/integration-tests typecheck`, eslint on every changed file, and the three repo `check:*` scripts: all clean.

Key tests:
- `peer-dial.spec.ts` (real libp2p; the dead addresses are loopback TCP servers that never answer the WebSocket upgrade):
  - Two silent addresses and then a working one connect in about 2 × 400 ms. The test also checks that both silent servers really received connections. A second dialer shows that one `libp2p.dial(list)` over the same list times out.
  - With four silent addresses, the dial stops at the total limit and reports the fourth as not tried.
  - A TCP-first list on a WebSocket-only dialer connects over `/ws` with no delay.
- `cadre-node-dial-past-dead-addresses.spec.ts`: a real owner `CadreNode` (WebSockets only, no listener) runs `addDrone` with `[silent, silent, working /ws]`. One `reconcileControlCohort()` then opens an outbound connection within about 2 × 500 ms. With `dialPeerAddrs` switched back to one `dial()` over the whole list, this test and both timing cases in peer-dial.spec.ts fail (mutation run).
- `host-node-request.spec.ts` new cases:
  - Re-drives until the third pass connects.
  - Never runs two passes at once.
  - Fails within `connectMs` even when a single pass is slower than that.
  - A throwing pass is reported and not retried.

## Known gaps

- **No device re-run.** The Galaxy Note 9 with cadre-host over `adb reverse` has not been retried. Everything above is headless. That device run is the real acceptance check (docs/reference-app-rn.md → Borrowing a Node).
- **The 8 s per-address default is reasoned, not measured.** A `/p2p-circuit/webrtc` dial that needs longer than 8 s now fails on every pass; before, it could use up to 20 s. There is a NOTE on the constant in `peer-dial.ts`.
- **Starvation still happens past the threshold.** A working address behind four or more dropped ones (more than 30 s at 8 s each) fails every pass the same way, because the order does not change between passes. The constant's doc names the remedy: try the address that last connected first.
- **The macrotask wait depends on libp2p internals** (`DialQueue.dial` joining a queued job, and `PriorityQueue` removing jobs in a `.finally`). It is pinned by the real-libp2p specs, not by any libp2p guarantee.
- **Not changed, noticed:** `applySeed` dials owner addresses as given, without adding `/p2p/<peerId>`, so a bare address accepts whoever answers. This was already true before this change.
- `git rm` staged the deletion of `control-dial-mixed-transports.spec.ts`. Everything else is unstaged.
