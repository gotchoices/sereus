---
description: A machine that could only reach the network through a relay failed to finish starting up when it booted before the relay had learned it was a member. Every node now builds its own copy of the shared database while it is still alone, and only reaches out afterwards.
prereq:
files: packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/relay-addrs.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/membership-connection-gater.spec.ts, packages/integration-tests/src/harness/slow-raw-storage.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts, packages/integration-tests/src/scenarios/control-bring-up-quiet-period.integration.ts, docs/architecture.md, packages/cadre-cli/README.md, packages/reference-app-web/README.md, packages/reference-app-web/src/lib/cadre-web.ts
difficulty: medium
---

# Review: control-database bring-up now runs before the first connection

## What the defect was

A node builds its control database (the party's shared membership tables) right
after its network layer comes up. Building it is not local — it is a long chain of
block probes that consult the node's Optimystic cohort, and every connected
same-party peer is in that cohort. A sibling that has not yet replicated the
booting node's `CadrePeer` row correctly refuses those probes, so bring-up died
with `BlockUnavailableError` and `start()` rejected.

A node configured with `network.relayAddrs` hit this on **every** boot: that
setting resolved to a `<relay>/p2p/<id>/p2p-circuit` listen address, and libp2p
dials a configured circuit listener from inside `libp2p.start()` — before bring-up
begins. A node configured with `controlNetwork.bootstrapNodes` hit it only when
bring-up outlasted `@libp2p/bootstrap`'s 1 s discovery fuse.

Retrying could never converge: the condition that clears the refusal is the
booting node's own row reaching the sibling, and writing that row needs the
database the retry is building. The fix is ordering, not retrying.

## What was built

**Phase 1 — `relayAddrs` reserves after bring-up.** `resolveListenAddrs` now takes
a route (`relay-addrs.ts`). The control node passes `'search'`, so `relayAddrs`
contributes ONE bare `/p2p-circuit` search listener, which opens no connection.
`CadreNode.start()` drives the reservation explicitly at the very end
(`driveControlRelayReservation`), after `ControlDatabase.initialize()` and ahead of
`scheduleSelfRegistration` so the first published row already carries the circuit
address. A first attempt that does not settle as `reserved` throws
`RelayReservationFailedError` (new, exported), which preserves the fail-fast
contract with an error that names the relay and the reservation's own reason —
strictly better than the old `UnsupportedListenAddressesError`. Boot budget is the
module default, 10 s, stated at the site.

Strand nodes keep the `'configured'` route (the default), because nothing drives an
explicit reservation for them and a search entry would leave them undialable; the
ordering hazard does not exist there, since a strand node's protocol ids are
namespaced `/optimystic/strand-<id>/…` and the relay is never in its cohort.

`circuitRelayTargets()` now reads `network.relayAddrs` and `network.listenAddrs`
directly instead of going through `resolveListenAddrs`, since the search entry
names no relay and the delegate announce must land before a strand node dials.

**Phase 2 — a bring-up quiet period on the connection gate.** `CadreNode` sets
`controlBringUpInFlight` before creating the libp2p node and clears it when
`ControlDatabase.initialize()` settles (and in `cleanup()`, so teardown and failed
starts are never gated). `createMembershipConnectionGater` reads it through a new
optional `InboundAdmissionPolicy.bringUpInFlight()` and, while it is true, denies
`denyDialPeer` AND `denyInboundEncryptedConnection` before consulting the per-peer
policy at all. Inbound is not safe by omission: during bring-up the node's
authorized set is empty, so the cold-start carve-out would admit everyone.

## How to exercise it

```
yarn lint
yarn workspace @serfab/cadre-core build && yarn workspace @serfab/cadre-cli build && yarn workspace @serfab/integration-tests build
yarn workspace @serfab/cadre-core test
```
then from `packages/integration-tests`:
```
yarn vitest run src/scenarios/relay-only-control-addr.integration.ts src/scenarios/control-stream-authz.integration.ts src/scenarios/membership-connection-gater.integration.ts src/scenarios/control-bring-up-quiet-period.integration.ts
```

All green as handed off: lint clean, three builds clean, cadre-core 1638 passed /
1 skipped across 103 files, the four integration files 11 passed. The relay file
was run 3 consecutive times green after the changes below.

### The two cases that matter most

- **`relay-only-control-addr.integration.ts` case 2** now boots a SAME-PARTY
  unauthorized node through `relayAddrs`. That is the exact configuration that
  failed in ~540 ms before this work; the case previously used a different-party
  node specifically to dodge it. Its comment carried a forward reference to
  `bug-fail-fast-relay-boot-blocked-by-stream-gate`, now removed.
- **`control-bring-up-quiet-period.integration.ts`** is the bootstrap arm, and it
  is deliberately not a race. A per-operation-sleeping storage wrapper
  (`harness/slow-raw-storage.ts`, opt in via `controlNodeConfig({storageOpDelayMs})`)
  pushes bring-up to ~2.6-3.2 s, past the 1 s discovery fuse, and the case asserts
  the elapsed time so it cannot go vacuous. The owner also holds an open enrollment
  window — without it the owner simply denies the connection and there is nothing
  to order around.

**Anti-vacuity, measured.** With `bringUpInFlight` forced false and nothing else
changed, that scenario fails inside C's schema creation:
`Module 'optimystic' create failed for table 'CadrePeer': Optimystic table
'CadrePeer' already exists in schema 'cadrecontrol'`. Note that is a DIFFERENT
symptom from the `BlockUnavailableError` the relay arm produced — a sharper
statement of the same cause. The gate was restored and the suite re-run green.

## Known gaps — please probe these

1. **The convergence case the source ticket asked for does not exist.** A case
   walking the four-link address chain for a node authorized AFTER it booted was
   written and withdrawn. Once the unauthorized node holds its reservation it is a
   connected same-party peer, so it joins the owner's cohort while holding none of
   the party's blocks — and the owner's own `authorizePeer` then fails its
   `OwnerKey` read with `Block default/OwnerKey is unavailable (claimed-elsewhere)`.
   Measured across two rounds: 3/4 then 2/4 runs, and in the failing runs it did
   **not** recover — a 60 s retry loop got the identical error every second to the
   end. Recorded as a measured arm on
   `tickets/backlog/bug-control-reads-not-retried-on-transient-failure`, whose
   "transient" framing that contradicts. The withdrawal and its reason are stated
   in the scenario file's header. What survived is case 2's link-2 assertion (the
   relay's peerStore learns the unauthorized node's circuit address), which rides
   the reservation rather than the membership row.
   *If a reviewer can get that chain deterministic, it is the one thing missing.*

2. **The quiet period's scope is a judgement call.** It covers from before
   `createControlNode()` to the moment `ControlDatabase.initialize()` resolves.
   Everything after that — the strand watcher's first poll, `refreshMembershipGate`,
   the reservation drive — runs with the gate open. That is deliberate (the
   database exists locally by then), but nobody has probed whether an early read on
   a just-formed cohort has its own ordering hazard.

3. **`denyDialPeer` is now composed by the membership gater**, where before it was
   only spread through from the base gater. Deny-from-either semantics are
   preserved and unit-tested, but this is the first time the built-in gate touches
   outbound dials at all — `docs/architecture.md` previously said "outbound dials
   are never gated" and now says "never gated on membership". Worth a look at
   whether any caller relied on the hook being absent.

4. **Order inside `start()`.** The reservation runs after `_running = true` and
   after `emit('control:connected')`, so a node can emit that event and then have
   `start()` reject. The alternative (reserve before `_running`) would have the relay
   connection form before `wireControlConnectionListeners()` and risk missing the
   0→≥1 edge the write-while-alone drain needs. The current order was chosen for
   that reason; the emit-then-fail sequence is the cost.

5. **Not measured: a strand node inheriting a search entry.** Strand nodes were
   kept on the configured route by reasoning (nothing drives `reserveRelays` for
   them), not by a test. No scenario in this repo runs a strand node with
   `relayAddrs` set.

## Tripwires parked in code (index only — analysis lives at each site)

- `cadre-node.ts`, at the quiet-period arming in `start()` — the bootstrap arm's
  safety margin is raw-storage latency versus the 1 s discovery fuse; if the gate is
  removed or bypassed, that arm reopens for exactly the nodes most likely to hit it.
- `cadre-node.ts`, `startRecordRefresh` — a node authorized AFTER it booted can wait
  a full 7.5 min heartbeat to publish its address, because `registerSelf` no-ops
  while unauthorized and the only other trigger needs an ADDRESS CHANGE. Names the
  membership-change seam to use if late enrollment becomes the normal path.

## Board changes made

- `tickets/backlog/bug-relay-drive-not-cancellable` — appended a second instance:
  a reservation drive now runs inside `start()`, so the uncancellable window covers
  startup and failed starts too, not only shutdown. Same root cause and fix.
- `tickets/backlog/bug-control-reads-not-retried-on-transient-failure` — appended
  the measured non-transient instance described in gap 1.
- `tickets/.pre-existing-error.md` — written for
  `control-cohort-cold-start-retry.integration.ts`, which fails reproducibly at
  HEAD for reasons predating this work (its step-3 premise — that a relay-enabled
  owner denies an unvouched peer's connection outright — stopped holding when the
  relay-reservation seam landed). Confirmed unrelated by re-running it with this
  ticket's quiet period neutralized: identical failure.

## Docs rewritten (the "two routes are alternatives" warning is gone everywhere)

`relay-addrs.ts` and `relay-reservation.ts` module docs, `NetworkConfig.relayAddrs`
in `types.ts`, `docs/architecture.md` (the route table under "Reservations are
requested explicitly, not discovered", the connection-gate bullet, and the
`NetworkConfig` listing), `packages/cadre-cli/README.md`'s `CADRE_RELAY_ADDRS` row,
`example.cadre.yaml`, and both reference-app-web sites. Setting `relayAddrs`
alongside `reserveRelays()` is now redundant rather than fatal; the two differ only
in failure posture.
