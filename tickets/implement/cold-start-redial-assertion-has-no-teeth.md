---
description: A test that is supposed to prove a phone can rejoin a party after its first connection attempt is turned away currently passes even when the rejoin code is switched off; make the test actually depend on that code, and fix three test helpers that silently ignore a setting they are told to turn off.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
repro: verified
---

# Give the cold-start redial scenario teeth

`control-cohort-cold-start-retry.integration.ts` is the acceptance proof for
`cold-start-control-redial`. Its step 5 asserts that node B — whose one seed dial was refused —
gets back in via `reconcileControlCohort`'s cold-start branch (`CadreNode.dialColdStartBootstrap`,
`packages/cadre-core/src/cadre-node.ts:2417`). Measured 2026-08-20: with that branch neutralized
the scenario **still passes**, so the assertion cannot tell the guarded code from its absence.

The competing dialer has been **identified** and a remedy has been **prototyped and measured**.
Everything below is a verified change; this ticket is the write-up, not a re-investigation.

## The competing dialer: FRET's stabilization probes

Instrumenting `DefaultConnectionManager.openConnection` (libp2p 3.1.3, the copy under
`../optimystic/packages/db-p2p/node_modules/libp2p`) with a stack dump, while
`dialColdStartBootstrap` was suppressed, attributed every B→A connection in the run. Trimmed
traces from B (`self=LVKm9Dr5`, target = A):

```
[teeth] openConnection target=/ip4/127.0.0.1/tcp/50910/ws/p2p/12D3KooWSg5U…   ← step 2, refused
    at SeedBootstrapService.applySeed (packages/cadre-core/src/seed-bootstrap.ts:771)

[teeth] openConnection target=12D3KooWSg5U…                                    ← this is step 5
    at Libp2p.dialProtocol (libp2p/dist/src/libp2p.js:245)
    at openRpcStream (Fret/packages/fret/dist/src/rpc/protocols.js:600)
    at sendPing (Fret/packages/fret/dist/src/rpc/ping.js:58)
    at FretService.probeMembership (Fret/packages/fret/dist/src/service/fret-service.js:2201)

[teeth] openConnection target=12D3KooWSg5U…                                    ← and again
    at FretService.probeNeighborLatency → probeAndFetch (fret-service.js:2032 / 2017)
```

So the connection step 5 observes is opened by **`p2p-fret`'s stabilization loop**
(`FretService.stabilizeOnce`, re-armed every 300 ms in active mode / 1500 ms passive), not by
anything in cadre-core. It dials A by **bare peer id**; libp2p resolves that to an address from
B's libp2p **peerStore**, which `SeedBootstrapService.applySeed` populated when it dialed A.

Two facts make this exploitable by the fixture, and both are load-bearing for the remedy:

- FRET's dialability test is `isDialable(id) = hasAddresses(id) || isConnected(id)`
  (`fret-service.js:1210`), and `hasAddresses` reads an `addressKnown` set that
  `seedFromPeerStore` rebuilds **wholesale from `peerStore.all()` at the top of every tick**
  (`fret-service.js:1833-1860`). No peerStore address for A ⇒ FRET will not dial A.
- `dialColdStartBootstrap` does **not** use the libp2p peerStore. It dials multiaddrs held in
  cadre-core's own `bootstrapPeerStore`, retained by `recordSeedBootstrapPeers` at seed-apply
  time (`cadre-node.ts:2375`), and binds each to the peer id itself (`bootstrapDialAddrs`).

The two dialers therefore have **independent address sources**, which is exactly what lets the
fixture keep one and remove the other.

## The remedy (prototyped and measured)

Between step 3 (the refusal has settled) and step 4 (A vouches B), strip A from B's **libp2p
peerStore**. B is then left with precisely the route the scenario's doc claims is its only one:
the seed's retained bootstrap addresses. FRET, optimystic's bare-peer-id dial paths, and libp2p's
own reconnect machinery all lose their address for A; the cold-start branch keeps its.

```ts
import { peerIdFromString } from '@libp2p/peer-id';

// 3b. Strip A from B's libp2p peerStore …
await B.getControlNode()!.peerStore.delete(peerIdFromString(aPeerId));
await waitUntil(
  async () => {
    const store = B!.getControlNode()!.peerStore;
    if (!(await store.has(peerIdFromString(aPeerId)))) return true;
    return (await store.get(peerIdFromString(aPeerId))).addresses.length === 0;
  },
  { timeoutMs: 5_000, intervalMs: 100, description: "B's peerStore holds no address for A" }
);
```

Nothing re-populates that entry before the cold-start dial: identify needs a connection (there is
none), `warmSiblingAddrBook` needs siblings (the table is empty), and `applySeed` has already run.
Once the cold-start dial lands, identify refills the entry normally — the strip is a one-shot, and
step 6 is unaffected.

### Measured, at `370ad30` with the change prototyped

| configuration | result |
|---|---|
| `dialColdStartBootstrap` intact, 3 consecutive runs | green, 3.9 s / 3.9 s / 4.1 s |
| `dialColdStartBootstrap` early-returning, 3 consecutive runs | **red 3/3**, `Timeout waiting for B re-dials A from its retained seed addresses after 45000ms` |

The red is emphatic rather than marginal: with the peerStore address gone, **no** dialer
reconnected B to A in the full 45 s window. Before the change the same suppressed configuration
went green in ~3.5 s.

Suppression was applied by an early `return` at the top of `dialColdStartBootstrap` in
`packages/cadre-core/src/cadre-node.ts`, followed by `yarn workspace @serfab/cadre-core build`;
the file and the build were restored afterwards. The working tree carries none of the
instrumentation — reapplying it is how the acceptance check below is run.

## Design constraints this satisfies

- **Step 5 is not weakened.** The assertion still requires a live, `direction === 'outbound'`
  connection from B to A. Only the competing producer of that connection was removed.
- **No product code is neutralized.** FRET keeps probing; the change is one fixture line acting on
  B's own peerStore.
- **B still listens on nothing**, so `outbound` stays meaningful.
- **`enableRelay: false` on A stays.**

## Finding about the feature (record it, do not file it)

The cold-start branch is **not** the only thing that can recover a stranded joiner in a live
deployment. As long as B's libp2p peerStore still holds the owner's address — which
`applySeed` puts there — FRET's stabilization probes reconnect B on their own, typically within a
few seconds. The branch is still the load-bearing path for the cases FRET cannot serve: a peerStore
whose address entries have aged out, and a process restart (the peerStore is in-memory here, while
`bootstrapPeerStore` persists). This is overlap, not redundancy, so it is a doc fact rather than a
ticket — put it in the scenario's module doc alongside the explanation of the strip.

## Second arm: three test helpers silently drop `enableRelay: false`

Same defect class as the one already fixed in `controlNodeConfig` (`node-fixtures.ts:116`, now
`opts.enableRelay !== undefined`), and the reason the scenario was red for an unrelated reason
before this ticket's investigation: a truthiness-gated spread that writes a **literal `true`**
cannot express `false`, so an explicit `false` is dropped and the storage-profile default (relay
server ON) silently stands.

```ts
...(opts.enableRelay ? { enableRelay: true } : {}),   // ← drops an explicit false
```

Three local `createTestNodeConfig` helpers still carry it. `grep` over `packages/*/src` confirms
these are the only remaining boolean-valued instances of the pattern; the other truthy spreads in
the repo gate non-boolean options, where falsy and absent mean the same thing.

- `packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts:54`
- `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts:131`
- `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts:185`

No current caller passes `false`, so this is latent — but it costs a long debugging session the
first time someone does, exactly as it did here.

## Tripwire to park in code (not a ticket)

While measuring the earlier failure it was observed that **B held an aborted connection in
`status: 'open'` for ~9 s** after A killed the underlying `MultiaddrConnection` — B only learns of
the abort at its next connection-monitor ping. `dialColdStartBootstrap` skips peers present in
`getConnections()`, so a phantom-open connection suppresses the cold-start retry for that window.
Bounded and self-healing today. Record it as a `NOTE:` at the `connected.has(peerId)` skip inside
`dialColdStartBootstrap` (`cadre-node.ts`), stating the window and the condition that would make it
matter (a longer connection-monitor interval, or a recovery deadline tighter than one ping).

## TODO

- [ ] Add the peerStore strip as step 3b of `control-cohort-cold-start-retry.integration.ts`
      (code above), importing `peerIdFromString` from `@libp2p/peer-id`. Comment it as
      load-bearing — name FRET as the dialer it removes and `bootstrapPeerStore` as the source it
      deliberately leaves intact — so it is not mistaken for tidy-up and deleted.
- [ ] Rewrite the module doc's `KNOWN GAP` paragraph. It must now say what the assertion proves and
      why: FRET's stabilization loop dials A by bare peer id off the peerStore `applySeed`
      populated; the strip removes that route; `dialColdStartBootstrap` dials from
      `bootstrapPeerStore` and is therefore the only remaining producer of B's outbound connection.
      Include the finding above (FRET also recovers a stranded joiner in a live deployment while
      the peerStore entry survives) and the re-verification recipe from the acceptance step below.
- [ ] Acceptance: early-return at the top of `CadreNode.dialColdStartBootstrap`,
      `yarn workspace @serfab/cadre-core build`, run the scenario, require **red** at step 5.
      Restore the file, rebuild, require green.
- [ ] Run the scenario at least 3× green after the change (expect ~4 s; a regression to a 45 s
      timeout is unmistakable).
- [ ] Change the three `...(opts.enableRelay ? { enableRelay: true } : {})` spreads listed above to
      `...(opts.enableRelay !== undefined ? { enableRelay: opts.enableRelay } : {})`, and run each
      of those three suites once to confirm nothing shifted (no caller passes `false` today, so
      they should be unchanged).
- [ ] Add the phantom-open-connection `NOTE:` at the `connected.has(peerId)` skip in
      `dialColdStartBootstrap`.
