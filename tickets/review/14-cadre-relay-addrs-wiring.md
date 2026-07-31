description: A node can now actually use the relay servers it is configured with, so peers can reach it from behind a home router. The setting used to be silently thrown away.
files: packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/relay-addrs.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-cli/example.cadre.yaml, docs/architecture.md
difficulty: medium
----

# Review: `network.relayAddrs` wiring

## What changed

`NetworkConfig.relayAddrs` was settable in `cadre.yaml`, via `CADRE_RELAY_ADDRS`, and through the
Docker entrypoint, and was read by nobody — a node told to use a relay quietly held no reservation
and stayed unreachable behind NAT.

It is now translated into the mechanism the repo already had (a `/p2p-circuit` entry in the node's
listen addrs, which is what makes libp2p dial a relay and hold a reservation):

```
effective listen addrs = listenAddrs ++ relayAddrs.map(a => a + "/p2p-circuit")   (deduped)
```

New module `src/relay-addrs.ts` owns that resolution:

- `relayCircuitAddrs(relayAddrs)` — appends `/p2p-circuit` per entry, passes an entry that already
  has one through unchanged, dedupes by exact string, **throws** on an unparsable entry or one that
  names no relay peerId.
- `resolveListenAddrs(network)` — configured `listenAddrs` ++ those circuits, deduped, configured
  entries first. Returns `undefined` when neither field is set, so callers keep omitting the key
  and inherit db-p2p's default.

Three consumers now read the resolved list instead of raw `network.listenAddrs`:
`CadreNode.buildControlNodeOptions()`, `StrandInstanceManager`'s `createLibp2pNode` call, and
`CadreNode.circuitRelayTargets()` (so a configured relay also becomes a delegate-announce target —
without that, the relay would hold the control node's reservation but deny the strand node's).

`delegate-admission.ts` gained one export, `circuitRelayTargetOrThrow(addr)`; the existing
`circuitRelayTarget` is now a try/catch wrapper over it, so there is one multiaddr walker, not two.
The asymmetry is deliberate and is the point of the split: `extractCircuitRelayTargets` reads
addresses **discovered at runtime from peers**, where one bad entry must not be fatal, so it logs
and skips. `relayCircuitAddrs` reads **operator config**, where a silently dropped entry is exactly
the failure this ticket removes, so it throws at node start.

Docs: `NetworkConfig.relayAddrs` doc comment, `example.cadre.yaml` (example uncommented and
corrected), `docs/architecture.md`.

## Use cases to check

**The headline case.** `cadre.yaml` with

```yaml
network:
  listenAddrs: ["/ip4/0.0.0.0/tcp/4001"]
  relayAddrs: ["/dns4/relay.example.com/tcp/4001/p2p/<relayPeerId>"]
```

→ control node options carry `listenAddrs: ['/ip4/0.0.0.0/tcp/4001', '/dns4/…/p2p/<relay>/p2p-circuit']`,
and `circuitRelayTargets()` returns that relay. Both assertions are in
`test/cadre-node-control-node-options.spec.ts` → `describe('relayAddrs')`; both fail against the
old code, so they are not vacuous.

**`relayAddrs` set, `listenAddrs` absent.** The node keeps a direct listener: `/ip4/0.0.0.0/tcp/0`
is prepended, mirroring db-p2p's own default (`CadreNode` passes `port: 0`). Without it, naming a
relay would silently *replace* the node's direct TCP listener — a config that adds reachability
would cost it instead.

**`listenAddrs: []` + `relayAddrs` set.** Result is a circuit-only listener. Allowed on purpose —
that is what naming a relay means — but note `reference-app-rn`'s `cadre-phone.ts` deliberately
sets `listenAddrs: []` and does **not** set `relayAddrs`, so it acquires no listener. Confirmed by
reading the file; the caveat is spelled out in the `relayAddrs` doc comment.

**Idempotence / dedupe.** An entry already ending in `/p2p-circuit`, a relay repeated, and a relay
whose circuit addr is already hand-written into `listenAddrs` all collapse to one entry, order
stable, so restarts bind the same list.

**Bad config fails loudly.** `not-a-multiaddr`, `/ip4/1.2.3.4/tcp/4001` (no peerId), `/p2p-circuit`
(no relay named), and a garbage peerId each throw at node start, with the *original* config entry
named in the message so an operator can find it in `cadre.yaml`.

**Unchanged behavior worth re-confirming.** `listenAddrs: []` with no relays still forwards `[]`;
an entirely absent `network` block still omits the `listenAddrs` key. Both were already pinned in
`cadre-node-control-node-options.spec.ts` and still pass.

## Validation run

- `yarn build` in `packages/cadre-core` — clean.
- `yarn test` in `packages/cadre-core` — 80 files, 1254 passed, 1 skipped, 0 failed.
- `yarn lint` at repo root — 0 errors. 6 warnings, all "unused eslint-disable directive" in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, pre-existing
  and untouched by this diff.

## Known gaps — treat the tests as a floor

- **Nothing here proves a reservation is actually held.** Every test is unit-level over the
  config→options mapping. The claim "listening on `…/p2p/<relay>/p2p-circuit` makes libp2p dial
  that relay and reserve" is inherited from existing code paths (`circuitRelayTransport()` is
  always pushed by db-p2p; the web reference does the equivalent by hand) — it is **not**
  end-to-end verified by this change. A real-network integration scenario against `ops/`'s relay
  stack would be the honest confirmation.
- **Unreachable relay at start is unverified.** If a configured relay is down when the node starts,
  whether `libp2p.start()` throws, retries, or comes up degraded was not tested. Worth knowing
  before recommending `relayAddrs` in a production config.
- **Strand-node port racing is unchanged and still unverified.** The pre-existing `NOTE:` in
  `strand-instance-manager.ts` (a fixed-port `listenAddrs` has control + strand nodes racing to
  bind one port → EADDRINUSE) predates this ticket and is untouched. `relayAddrs`-derived entries
  are circuits, so they do not add a port collision, but the comment now covers a wider input.
- **`network.announceAddrs` is still read by nobody.** Deliberately out of scope; the stale comment
  in `cadre-node-control-node-options.spec.ts` was narrowed to announceAddrs only rather than
  deleted, and now points at `cadre-announce-addrs-upstream`.
- **`reference-app-web` still reserves relays by hand** (`src/lib/cadre-web.ts` `reserveRelay`)
  instead of going through `relayAddrs`. Already tracked by
  `backlog/debt-web-relay-reservation-duplicates-core`; not touched here.
- `relay-addrs.ts` is **not** exported from the package index — no consumer outside cadre-core needs
  it yet. If the web reference is later converged onto it, that has to change.

## Review findings

- Tripwire: `DEFAULT_DIRECT_LISTEN_ADDR` in `relay-addrs.ts` hardcodes `/ip4/0.0.0.0/tcp/0`, which
  duplicates db-p2p's own default listen addr. Parked as a `NOTE:` at the constant naming
  `../optimystic/packages/db-p2p/src/libp2p-node.ts` as the source of truth, so an upstream change
  to that default is greppable from here.
