description: When a node dials a peer that has several addresses, libp2p tries them one at a time and gives up when the overall time limit runs out, so one or two unreachable addresses early in the list stop it from ever trying the address that works. This is why borrowing a node from a cadre-host always fails at "Connecting to the node…" even though the phone can reach that node by hand.
files:
  - packages/cadre-core/src/cadre-node.ts (`dialControlSibling` ~2968, `dialBootstrapPeer` ~3222, `controlDialTimeoutMs` ~2956, `resolveControlDialAddrs` doc comment ~3013)
  - packages/cadre-core/src/control-cohort.ts (`DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` = 20 s)
  - packages/cadre-core/src/types.ts (~428, `network.controlCohort.dialTimeoutMs`)
  - packages/cadre-core/src/seed-bootstrap.ts (`applySeed` owner dials ~786, invite dial loop ~1363 — same class, see below)
  - packages/cadre-core/src/control-stream.ts (`withDeadline`)
  - packages/cadre-core/test/control-dial-mixed-transports.spec.ts (style to copy for the new real-libp2p test)
  - packages/reference-app-rn/src/host-node-request.ts (`connectToNode` ~377-402)
  - packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts (step 5 — the headless version of the loan's connect step)
  - node_modules/libp2p/dist/src/connection-manager/dial-queue.js, address-sorter.js (libp2p 3.1.3 — read-only reference)
repro: verified
----

# One unreachable address stops a peer dial from reaching the address that works

## What the device run showed

Galaxy Note 9, cadre-host on a Windows PC in donor mode, management and lent-node ports forwarded with `adb reverse`. Settings → Host Node → Request Node reached "Connecting to the node…" at 12 s and failed at 64 s with "could not reach it within 30 seconds". Straight afterwards, Settings → Dial Peer with the lent node's loopback WebSocket address connected in 1.6 s. The PC's Wi-Fi is classed Public by Windows and node.exe's inbound rules block it, so the node's LAN addresses silently drop the phone's connection attempts; only the forwarded loopback address works.

## Cause

`connectToNode` calls `CadreNode.reconcileControlCohort()`, which (correctly) finds the just-added node as a sibling, finds no signed record for it, falls back to the addresses `addDrone` retained, and calls `dialControlSibling`. That hands the WHOLE address list to one `controlNode.dial(addrs, { signal })` under a single 20 s deadline (`DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS`).

libp2p 3.1.3's dial queue (`dial-queue.js` `dialPeer`) drops the TCP addresses the phone has no transport for, sorts the rest with `defaultAddressSorter` — which puts **loopback addresses last** and private (LAN) ones after public — and then dials them **one at a time**, every attempt sharing that one signal. There is no per-address time limit. An address whose connection attempt is silently dropped (firewall, wrong subnet, a virtual adapter the phone cannot route to — a Windows host routinely reports Hyper-V/WSL/Docker/VPN adapter addresses too) holds the dial until something times it out; two such addresses consume the whole 20 s and the working address is never tried.

The timing matches: connect step starts at 12 s, reconcile's dial times out at ~32 s, then `connectToNode` polls its own 30 s, failing at ~64 s. Timed reconcile passes during that poll repeat the same doomed dial.

Concurrent `dial()` calls to the same peer do not help: `DialQueue.dial` finds the in-flight job for that peer id (or any overlapping address) and adds the new addresses to it, so they are still tried serially.

This is not specific to `adb reverse`. Any lent node whose address list contains addresses the phone cannot reach, ordered ahead of one it can, fails the same way — and so does every later reconcile pass and every restart, so the connection never forms.

## Reproduction (verified, plain libp2p on Node)

A WebSocket-only dialer, a target listening on `/ip4/127.0.0.1/tcp/0/ws`, and two `net.createServer(() => {})` servers on loopback that accept TCP and never answer the WebSocket upgrade (a deterministic stand-in for a silently dropped address). `dialer.dial([silent1, silent2, good], { signal: AbortSignal.timeout(20000) })` → `TimeoutError` after 20 005 ms. `dialer.dial([good])` → connects in ~70 ms. All three are loopback, so libp2p's sort keeps the given order. (With `10.255.255.1`/`.2` as the dead addresses on this Windows machine, each took ~10.6 s to fail and the dial also timed out at 20 s; one dead address alone left enough time. On Linux such an address may fail instantly, which is why the silent-server version is the one to test with.)

## Fix

The site is cadre-core's "dial a peer from a list of candidate addresses" step. Make an unreachable address unable to starve the others:

- Add one helper (in `cadre-node.ts` or a small module beside `control-cohort.ts`) that dials a peer's candidate addresses **each as its own `dial()` call with its own per-address deadline**, stopping at the first connection, all inside the existing overall budget. Because each call carries a single address, libp2p's cross-address ordering no longer applies, so the helper must order the addresses itself — keep the useful parts of libp2p's order (non-relay before `/p2p-circuit`), but do NOT push loopback to the very end behind addresses that may hang; with a per-address cap the cost of trying a dead address first is bounded, so the given order (after dropping transports the node cannot dial, which one-address `dial()` would otherwise report as a fast failure — acceptable either way) is fine. Log each per-address failure the way the pass logs whole-peer failures today.
- Per-address budget: new `network.controlCohort.perAddressDialTimeoutMs` (types.ts), default a few seconds (the phone's loopback WebSocket dial measured 1.6 s end to end; a relayed dial needs more — pick a default that covers a relay hop, e.g. 5–8 s, and say why in the constant's doc). The overall `dialTimeoutMs` stays the cap on the whole peer; raise its default if needed so that a typical lent-node list (say 2–4 dialable addresses) fits, and document the arithmetic. Do not remove the overall cap — the pass is sequential across siblings.
- Use the helper in `dialControlSibling` and `dialBootstrapPeer`. Update the `resolveControlDialAddrs` doc comment, which currently says the unfiltered list "needs no filtering" because libp2p drops undialable transports — still true, but the reason the list is no longer handed to one `dial()` belongs there.
- Same class, same helper: `SeedBootstrapService.applySeed` dials only `peer.multiaddrs[0]` of each owner with no deadline, and the invite dial loop (~1363) tries each address with no per-address deadline. Move both onto the helper. (applySeed runs on the lent node, whose owner is usually a phone with no addresses, so this rarely bites today — but a first address that hangs stalls seed application indefinitely.)

`reference-app-rn/src/host-node-request.ts` `connectToNode`:

- Start the 30 s deadline BEFORE `reconcileControlCohort()`, not after it; today the step's real duration is reconcile time + 30 s, and the error message says 30. Keep reconcile as the dialling mechanism (it uses the retained addresses and is what reconnects after a restart); an extra explicit dial from the flow would join the same libp2p dial job and add nothing once the helper exists.
- Re-drive `reconcileControlCohort()` inside the poll loop when a pass completes without a connection (it is single-flight, so this cannot double-dial), instead of relying on the 15 s timed pass. This also retires the NOTE above `connectToNode` about a pass that listed siblings before `addDrone`.
- Check `connectMs` still covers one full helper run over a typical lent-node address list plus a re-drive; adjust the budget or the NOTE with the measured numbers.

## Tests

- New real-libp2p spec in `packages/cadre-core/test/` (copy `control-dial-mixed-transports.spec.ts`'s shape): target on loopback `/ws`, two silent TCP servers as dead `/ws` addresses listed first, dial through the new helper with a small per-address budget (e.g. 500 ms) and an overall budget that would fail under the old single-`dial()` behaviour; assert it connects to the target and finishes within roughly `2 × perAddress + slack`. Add a case asserting the overall cap still bounds a list of only dead addresses.
- A `CadreNode`-level test (in `cadre-node-control-cohort.spec.ts` or an integration scenario, whichever already builds a drone-adding owner cheaply): `addDrone` with retained addresses `[silent, silent, real ws]`, one `reconcileControlCohort()`, assert an open control connection to the drone exists without any other dial. This is the "adds a drone and a connection appears" test the original ticket asked for.
- `host-node-request` unit tests: deadline starts before reconcile; reconcile is re-driven while unconnected.
- Run `yarn workspace @serfab/cadre-core test` and the `cadre-host-donation-phone-requester` integration scenario (step 5 exercises exactly this path headlessly).

## Not the cause (ruled out)

- Reconcile does include a drone added moments earlier: `addDrone` writes the `CadrePeer` row before the reconcile call and `listMembers` sees it; `retainDialTarget` makes the entry visible synchronously.
- A successful dial lands on the control libp2p node, which is what `isConnectedTo` inspects.
- TCP addresses in the list are not the problem: libp2p filters them out before dialling (pinned by `control-dial-mixed-transports.spec.ts`).

## TODO

- Add `perAddressDialTimeoutMs` config + default constant with rationale; revisit `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS`.
- Write the per-address dial helper; use it in `dialControlSibling` and `dialBootstrapPeer`; update the `resolveControlDialAddrs` doc.
- Move `applySeed`'s owner dial and the invite dial loop onto the helper.
- Real-libp2p spec with silent-server dead addresses (starvation case + all-dead cap case).
- `CadreNode` test: add drone with dead-then-live addresses, one reconcile, connection appears.
- `connectToNode`: deadline before reconcile, re-drive reconcile in the loop, revisit `connectMs` and the NOTE; unit tests.
- Update `docs/architecture.md` (Control Network → proactive dial) and `docs/reference-app-rn.md` (Borrowing a Node) if they describe the dial as one call over the list or the connect wait as 30 s after reconcile.
- Run cadre-core tests, lint, typecheck, and the phone-requester integration scenario.
