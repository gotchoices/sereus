---
description: A machine that reaches the network only through a relay can fail to finish starting up when it boots before the relay has learned it is a member. Make every node build its own copy of the shared database while it is still alone, and only then reach out to the relay, so the machine always comes up and joins the group once its membership record arrives.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, docs/architecture.md, packages/cadre-cli/README.md
difficulty: medium
repro: verified
---

# Bring the control database up before the node holds any control connection

## The defect, plainly

A sereus node keeps its party's shared "control database" — who the members are,
what their addresses are — and it builds that database as the very first thing it
does after its network layer comes up.

Building it is not a local operation. Every step asks the rest of the party
"do you already have this?" — and a sibling that has not yet heard this node is a
member correctly refuses to answer. The node cannot tell "the party refuses me
right now" apart from "the party is gone", so it treats the first refusal as fatal
and `start()` rejects.

Which nodes hit this depends only on WHEN the first connection to a sibling forms:

- A node configured with `network.relayAddrs` **always** hits it. That setting
  becomes a `<relay>/p2p/<relayPeerId>/p2p-circuit` listen address, and libp2p
  dials the relay from inside `libp2p.start()` — so the connection exists before
  the database bring-up even begins. Deterministic, every boot.
- A node configured with `controlNetwork.bootstrapNodes` hits it only if bring-up
  is slow (see "The bootstrap arm" below). Timing-dependent, not observed.

## Reproduction (verified 2026-08-20)

Scratch scenario, same as case 2 of `relay-only-control-addr.integration.ts` but
with C in the SAME party as the relay A, unauthorized at boot:

```
A: owner, storage profile, enableRelay, one member row (so its gate is armed)
C: same partyId, listenAddrs: [], relayAddrs: [<A's direct addr>]
await C.start()
```

fails in ~540 ms with

```
BlockUnavailableError: Block optimystic/schema is unavailable (cohort-unreachable):
  the repo could not determine whether it exists
    at TransactorSource.tryGet (db-core/src/transactor/transactor-source.ts:52)
    at Collection.probeHeader (db-core/src/collection/collection.ts:158)
    at Tree.open (db-core/src/collections/tree/tree.ts:55)
    at SchemaManager.listTables (quereus-plugin-optimystic/src/schema/schema-manager.ts:384)
    at OptimysticModule.hydrateCatalog (quereus-plugin-optimystic/src/optimystic-module.ts:2805)
    at ControlDatabase.initialize (packages/cadre-core/src/control-database.ts:459)
```

### The failure is NOT localized to catalog hydration

A throwaway patch that swallowed the `hydrate` rejection and continued was applied,
built, and re-run (then reverted — the tree is unmodified). Start then died one step
later, on the first table of the schema:

```
QuereusError: Failed to execute DDL: create table CadreControl.OwnerKey (...)
  Module 'optimystic' create failed for table 'OwnerKey': Failed to initialize
  Optimystic table: Block default/OwnerKey is unavailable (cohort-unreachable)
```

So this rules out the fix shape the source ticket listed first ("treat a refused
stream during FIRST schema hydration as retryable"). Control-database bring-up is a
long chain of cohort-consulting block probes — hydration, then one per table, then
the indexes — and **every** link of it dies against a sibling that refuses. Making
any one link fail-soft only moves the error one step down the chain.

It also rules out a start-level retry that keeps the connection: the condition that
would clear the refusal is this node's own `CadrePeer` row replicating to the
sibling, and writing that row needs the very database the retry is trying to build.
Retrying against a live refusing cohort cannot converge.

## The invariant to establish

> `CadreNode.start()` completes the control-database bring-up
> (`ControlDatabase.initialize`) while the control libp2p node holds **zero**
> control-network connections.

That is not a new behavior — it is what the fail-soft route already does, and why
case 3 of `relay-only-control-addr.integration.ts` is green today. The node builds
its catalog solo (a cohort of one, entirely local), and the relay connection forms
afterwards. This ticket makes the invariant hold on every route rather than on one
of them by accident of ordering.

## Phase 1 — `relayAddrs` reserves AFTER bring-up, not inside `libp2p.start()`

`network.relayAddrs` currently resolves to a *configured* circuit listen address
(`relay-addrs.ts` → `resolveListenAddrs`), which is fail-fast by construction:
libp2p's transport manager dials the relay during `listen()` and throws
`UnsupportedListenAddressesError` if it cannot. That fail-fast property is
deliberate and must be preserved — but it does not have to come from the listener.

Re-point the route:

```
network.relayAddrs = [<relay dial addr>, ...]

  before:  listenAddrs = [...configured, '<relay>/p2p/<id>/p2p-circuit', ...]
           -> libp2p.start() dials the relay
           -> ControlDatabase.initialize() runs against a cohort that refuses it

  after:   listenAddrs = [...configured, '/p2p-circuit']    // SEARCH listener: no dial
           -> libp2p.start() opens no connection
           -> ControlDatabase.initialize() runs solo, exactly as the soft route does
           -> CadreNode.reserveRelays(network.relayAddrs)   // explicit dial + reserve
           -> a first attempt that does not settle as 'reserved' THROWS,
              so start() still fails fast on a dead relay
```

The bare `/p2p-circuit` search listener cannot open a connection on its own:
libp2p's relay *discovery* nominates a peer only once the relay-hop protocol id is
in that peer's peer-store protocol list, and `@optimystic/db-p2p` namespaces
identify per network so a cadre node and a stock relay never identify each other.
That is already established in `relay-reservation.ts`'s module doc and
`docs/architecture.md` ("Reservations are requested explicitly, not discovered") —
this phase leans on it rather than introducing it.

### Measured: this costs the authorized case nothing

Two scratch scenarios ran the *soft* route (`listenAddrs: ['/p2p-circuit']` +
`reserveRelays` after `start()`) through the full four-link address chain that case 1
of `relay-only-control-addr.integration.ts` asserts — C holds a circuit address; the
relay's peerStore has it; C's own `CadrePeer` row carries it; a third member B that
never dialed C learns it:

| scenario | result |
| --- | --- |
| C authorized before boot | reserve `reserved`, all four links green, **2.7 s** |
| C unauthorized at boot, authorized afterwards | reserve `reserved` while unplaced, all four links green after the row lands, **2.8 s** |

The second row is the behavior the source ticket asked for and could not get: the
node comes up, holds its relay slot from the bounded unauthorized-reservation
budget, and converges once its membership row replicates.

### Consequences to handle in this phase

- **`CadreNode.circuitRelayTargets()`** (`cadre-node.ts` ~3968) reads
  `resolveListenAddrs(this.config.network)` union the node's live multiaddrs to pick
  delegate-announce targets. Dropping the configured circuit entries removes the
  first source until a reservation lands. Decide deliberately: either keep
  `network.relayAddrs` itself as a target source there, or accept the live-multiaddr
  source alone and say so at the site.
- **Strand nodes inherit the control listen addrs.** `relay-addrs.ts`'s module doc
  says so; check `strand-instance-manager.ts` for what a `/p2p-circuit` search entry
  means for a strand node versus a configured one, and preserve whatever today's
  configured entry produces.
- **The "do NOT configure both routes" footgun disappears.** `relay-reservation.ts`'s
  module doc, `relay-addrs.ts`'s module doc and `docs/architecture.md`'s two-row
  route table all warn that setting `relayAddrs` on a node that also calls
  `reserveRelays` re-introduces a fatal listener. After this phase they are the same
  route. Rewrite those three places rather than leaving a stale warning behind.
- **`reserveRelays` first-attempt duration bounds `start()`.** It awaits
  `supervisor.firstAttempt` (10 s default). Pick and state the budget for the boot
  path. Related, not a blocker: `tickets/backlog/bug-relay-drive-not-cancellable`
  (an in-flight drive is not cancelled by `stop()`) gets a wider blast radius once a
  drive runs inside `start()` — append it there as a new instance, do not fix it here.
- **The error an operator sees changes** from `UnsupportedListenAddressesError` to
  whatever this phase throws. Make it name the relay address and the reservation
  failure; that is a strict improvement worth wording carefully.

## Phase 2 — a bring-up quiet period on the control connection gate

Phase 1 removes the only *deterministic* way a connection exists during bring-up.
It does not make the class unrepresentable: any connection formed in that window has
the same effect, whatever opened it.

Add a quiet period to the gate `buildControlNodeOptions` already composes
(`membership-connection-gater.ts`): while control-database bring-up is in flight,
deny both outbound dials (`denyDialPeer`) and inbound encrypted connections, then
open the gate. Peers retry — libp2p's connection manager re-dials, and the relay
reservation supervisor already re-drives — so a denial in this window costs a retry,
not a partition.

Both directions are needed. Inbound is not safe by omission: during bring-up this
node's authorized set is still empty, so `admitInboundControlConnection`'s cold-start
carve-out admits everyone, and an inbound sibling enlists in the cohort exactly like
an outbound one would.

Phase 1 is a precondition, not a preference: a quiet period cannot coexist with a
configured circuit listener, because denying that listener's own dial is what makes
`libp2p.start()` throw.

### The bootstrap arm — what phase 2 is actually for (static, not observed)

`controlNetwork.bootstrapNodes` reaches libp2p as
`peerDiscovery: [bootstrap({ list })]` (`../optimystic/packages/db-p2p/src/libp2p-node-base.ts:682`),
with no `timeout` override. `@libp2p/bootstrap` 12.0.11 defaults
`DEFAULT_BOOTSTRAP_DISCOVERY_TIMEOUT = 1000` ms — it emits its discovery events one
second after `libp2p.start()`, and the connection manager auto-dials from there.

Measured on this machine, with the integration harness's in-memory storage: five
consecutive unauthorized same-party nodes booting against a bootstrap sibling all
started in **65–122 ms**, each with **0** control connections at completion. So the
margin today is roughly 10x, and nothing was observed failing.

The margin is a function of storage latency, not of code. The `NOTE:` at
`control-database.ts`'s `loadSchema` call site records the measurement that matters:
a cold control start issues **172** raw-storage operations, at ~1 ms/op on an idle
machine but **50–90 ms/op on a loaded disk or a phone's flash under launch
contention** — i.e. 9–15 s of bring-up, far past the 1 s bootstrap fuse. A phone
joining a party is precisely a node whose row has not replicated yet, so every
ingredient is present; only the ordering has not been caught in the act.

Make the phase-2 test force it rather than race it — a storage provider that sleeps
per operation (wrapping the harness's `MemoryRawStorage`) puts bring-up deliberately
past the 1 s fuse and makes the assertion deterministic.

## What must NOT change

- **The relay's per-stream gate stays fail-closed.** `authorizeInboundControlStream`
  refusing an unplaced peer's control-DB streams is correct, and is pinned by case 4
  of `relay-only-control-addr.integration.ts`. Nothing here loosens it; the fix is
  entirely on the booting node's side.
- **`network.relayAddrs` stays fail-fast for the operator.** A typo still throws at
  config resolution (`relay-addrs.ts` validates the relay peerId), and a relay that
  is down still means the node does not start — just from an explicit reservation
  failure rather than from a listener that could not listen.

## Related, deliberately separate

- `tickets/backlog/bug-control-reads-not-retried-on-transient-failure` — retrying
  reads that fail on transient network hiccups. Different converging condition
  (network recovery, not row replication). Do not merge.
- `tickets/blocked/control-peer-row-refresh-invisible-to-third-node` — the
  replication fork that makes this window unbounded rather than seconds long. This
  ticket removes the boot failure; it does not close that fork.
- `tickets/backlog/debt-cadre-node-single-file-size` — `cadre-node.ts` is already
  over 5300 lines and this work adds to it. Evidence for that ticket, not a new one.

## TODO

### Phase 1 — reserve after bring-up

- Change `resolveListenAddrs` (`relay-addrs.ts`) so `network.relayAddrs` contributes
  the bare `/p2p-circuit` search listener instead of a per-relay configured circuit
  listener; keep the direct-listener default and the peerId validation (a malformed
  entry must still throw at config resolution).
- In `CadreNode.start()`, after `controlDatabase.initialize()` and the rest of
  bring-up, drive `reserveRelays(network.relayAddrs)` when that list is non-empty,
  and throw a named error when the first attempt does not settle as `reserved` —
  preserving the fail-fast contract with an error that names the relay.
- Decide and document the boot-path budget for that first attempt.
- Settle `circuitRelayTargets()`'s source set now that configured circuit entries no
  longer appear in `resolveListenAddrs`; leave a comment at the site saying which
  source is authoritative and why.
- Check what a search-listener entry means for strand nodes inheriting the control
  listen addrs (`strand-instance-manager.ts`) and preserve today's behavior.
- Update `cadre-node-control-node-options.spec.ts` for the new listen-addr mapping.
- Rewrite the now-false "the two routes are alternatives / do not configure both"
  passages: `relay-addrs.ts` module doc, `relay-reservation.ts` module doc,
  `docs/architecture.md` (the two-row route table under "Reservations are requested
  explicitly, not discovered", and the connection-gate paragraph's boot-ordering
  sentence), and the `CADRE_RELAY_ADDRS` row of `packages/cadre-cli/README.md`.
- Flip case 2 of `relay-only-control-addr.integration.ts` back to a SAME-PARTY
  unauthorized reserver — the isolation comment there says to do this when this
  lands — and drop that comment's forward reference to the old bug slug.
- Add the convergence case the source ticket asked for: a same-party node boots
  unauthorized through `relayAddrs`, comes up, is authorized afterwards, and the
  four-link address chain completes. Both scratch runs above did this in under 3 s
  over the soft route, so budget the waits accordingly.

### Phase 2 — quiet period

- Add a bring-up quiet period to `createMembershipConnectionGater`: deny
  `denyDialPeer` and inbound encrypted connections while control-database bring-up is
  in flight, open on completion — and on failure too, so `cleanup()` is not gated.
  Keep the existing fail-open contract for every other state.
- Wire it in `CadreNode.start()` around `controlDatabase.initialize()`, and state at
  the site that the invariant being protected is "zero control connections during
  bring-up".
- Add the deterministic test: a per-operation-sleeping wrapper over the harness's
  `MemoryRawStorage` pushes bring-up past `@libp2p/bootstrap`'s 1 s discovery fuse;
  assert an unauthorized same-party node with `bootstrapNodes` still starts, and then
  converges once authorized.
- Record as a `NOTE:` tripwire at the quiet-period site: the window's safety margin is
  a function of raw-storage latency, and the 172-operation cold-start count lives in
  `control-database.ts`'s `loadSchema` note — if that count grows or the gate is
  removed, the bootstrap arm reopens.

### Validation

- `yarn lint`
- `yarn workspace @serfab/cadre-core build && yarn workspace @serfab/cadre-cli build && yarn workspace @serfab/integration-tests build`
- `yarn workspace @serfab/cadre-core test`
- from `packages/integration-tests`:
  `yarn vitest run src/scenarios/relay-only-control-addr.integration.ts src/scenarios/control-stream-authz.integration.ts src/scenarios/membership-connection-gater.integration.ts`
