----
description: Phones and other machines behind a home router reach the network through a helper machine that forwards traffic for them. For our private control network this seems to be failing, so other machines are told the phone exists but never told how to reach it, and requests to it fail instantly. The same phone's other connections work fine, so something specific to the control network is at fault.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/integration-tests
repro: static
----

# A control node behind a relay may never advertise its circuit address

## What was observed

Reported against our stack by a downstream consumer (VoteTorrent) in
[gotchoices/Optimystic#12](https://github.com/gotchoices/Optimystic/issues/12), measured on
`db-p2p@0.24.0` / `cadre-core@0.11.0` with two Android emulators behind NAT and two Node
nodes acting as relay providers:

- Dials to the two emulators' **control** peer ids fail with `NoValidAddressesError`
  (41–48 occurrences), meaning the dialing node's address book held nothing for them.
- The same two devices' **strand** peer ids carry real `/p2p-circuit/` addresses in the
  same run.

That asymmetry is the whole ticket. Same devices, same process, same relay — the strand
layer has a working address path and the control layer does not. Both node kinds are
built from the same `NetworkConfig` and both get their circuit listener from the same
`resolveListenAddrs` call, so the difference has to come from something the control node
does that a strand node does not.

Our analysis was posted as
[a comment on that issue](https://github.com/gotchoices/Optimystic/issues/12#issuecomment-5344317692).
This ticket is our half of it.

## Why this is ours, not upstream's

The upstream report frames this as a missing feature in `@optimystic/db-p2p` — that nobody
can ever teach a relay-only peer's first address. Reading the source says otherwise. Two
seeding paths already exist:

1. **`identifyPush` to the relay.** A relay-only node's reservation completes *after* its
   first connection to the relay, so plain `identify` (which runs once, at connection-open)
   cannot carry the resulting `/p2p-circuit` address. `identifyPush` re-sends the address
   list on libp2p's `self:peer:update`, which is exactly why it is registered — see the
   comment block above the `identifyPush({...})` entry in db-p2p's `src/libp2p-node-base.ts`,
   and its regression guard `test/relay-address-propagation.spec.ts`.
2. **The node's own cluster records.** `findCluster` publishes the *self* entry from
   `libp2p.getMultiaddrs()`, not from the peer store — and on a relay-only node that set
   includes its circuit address. Every record such a node coordinates therefore teaches its
   own address to every cohort member that receives it.

For a control peer to stay addressless, **both** of those have to be failing. The most
economical explanation is that the reservation itself never completes on the control node,
so there is no circuit address to push or publish in the first place.

## Leading hypothesis: the control node's membership gate refuses the reservation

The control node is the only one of the two that composes a membership connection gater
onto its libp2p config (`cadre-node.ts`, `buildControlNodeOptions`, around line 1094) plus
a fail-closed per-stream gate. Strand cohort nodes keep the raw configured gater, because
their peers are legitimately cross-party.

This class of failure has bitten us here before, and the code says so. From the module doc
in `membership-connection-gater.ts` (around line 44):

> **Announced delegate peers** (`delegate-admission.ts`). A member's strand node runs as a
> separate libp2p identity whose peerId no sibling can recompute, so a relay-running
> control node would deny its circuit-relay reservation.

Delegate admission exists *specifically* because a control node's gater was denying a
circuit-relay reservation. The carve-out was built for strand delegates. Nothing equivalent
appears to cover a **sibling's control peer** reserving a slot on another member's
relay-running control node.

Counter-evidence to weigh before committing to this: the gater is documented as fail-open
(deny only on a positive "unauthorized outsider while no stranger path is open"
determination), and a sibling control peer of the same party should be an authorized member
and admit cleanly. So either the emulators are not authorized at the moment they reserve —
a startup-ordering question — or the denial is happening somewhere else entirely. Do not
assume the gater is guilty; the point of this ticket is to find out.

## Other candidates to rule out

- **Reservation never requested.** Confirm the emulators' control nodes actually receive
  circuit listen addresses. `resolveListenAddrs` (`relay-addrs.ts:64`) folds
  `network.relayAddrs` into the listen list for both node kinds, so this *should* be
  symmetric — verify rather than assume, especially for a React Native config with an
  explicitly empty `listenAddrs`.
- **Reservation requested but never completes.** The reporter's own follow-up comment
  describes a low-end physical device where the reservation aborts because the JavaScript
  main thread is blocked for 6–15 seconds during boot. That is their bug, not ours, but the
  same shape — anything on our side that blocks the thread during control-node bring-up —
  would produce the same symptom on our own devices. `reference-app-rn` is where this would
  show up.
- **Reservation completes but the push is suppressed.** The identify protocol id is
  network-scoped (`optimystic/control-<partyId>`), so control and strand nodes speak
  different identify protocols. Confirm both sides of a control-network connection agree on
  that string.
- **Address learned but the dial races it.** libp2p's `AddressManager` coalesces listen-address
  changes for ~1000 ms and `@libp2p/identify` debounces the push a further ~1000 ms on top of
  the reservation round trip. If the peer store *does* hold the address shortly after boot,
  this is a race, not a missing mechanism, and the fix is retry-shaped rather than
  seeding-shaped.

## The discriminating measurement

At the moment a `NoValidAddressesError` fires for control peer `C` on a relay-providing
node `A`, ask: **does `A`'s libp2p peer store hold any address for `C`?**

- **Empty** → seeding genuinely never happened. Walk back: did `C` complete a reservation?
  Did `A` deny the connection? Did the push go out?
- **Populated** → the dial is racing the push, and this is a retry/backoff ticket.

## A trap for whoever measures this

The address-book merge logging is split across two unrelated `debug` namespaces, so the
obvious filter under-reports it. This is what led the upstream report to conclude the merge
"genuinely never executes":

- The **inbound** path (`ClusterService`) logs through
  `components.logger.forComponent('db-p2p:peer-address-book')`. libp2p uses `defaultLogger()`
  (`libp2p/dist/src/libp2p.js:52`), whose `forComponent(name)` returns `logger(name)` with
  **no prefix**, so the namespace is literally `db-p2p:peer-address-book`.
- The **outbound** path (`ClusterClient` / `RepoClient` → `Libp2pKeyPeerNetwork.recordPeerAddresses`)
  logs under `optimystic:db-p2p:libp2p-key-network:<peer>`.

Use `DEBUG=optimystic:db-p2p:*,db-p2p:*` — an `optimystic:`-only filter shows a healthy
node and a completely inert address book as identical.

## Reproduction to build

`packages/integration-tests` is the cross-package real-network suite and is the right home.
The topology needed is the reporter's, minimised:

1. Two relay-providing control nodes (`profile: 'storage'`, so `enableRelay` defaults true)
   that can dial each other directly.
2. One or two control nodes with no inbound reachability, each configured with
   `network.relayAddrs` pointing at relay node A, so `resolveListenAddrs` gives them a
   `/p2p-circuit` listener.
3. All of them members of the same party, so the membership gater is live and not trivially
   admitting everything.
4. Drive a control-DB write whose key position selects a relay-only member as a cohort
   member.

Expected on a healthy run: the relay-only node completes its reservation, relay node A's
peer store holds a `/p2p-circuit` address for it, and node B — which never connected to it
directly — learns that address from a cluster record and dials successfully.

Expected on the reported failure: A logs `findCluster:addressless-members` naming the
relay-only peer, and the dial fails with `NoValidAddressesError`.

The negative control that isolates the gater: the same topology with the membership gater
suppressed. If it passes without the gater and fails with it, the hypothesis above is
confirmed and the fix is a carve-out in the same shape as delegate admission.

## Output

One or more `implement/` tickets naming the specific code site to change. If the
measurement shows the peer store is populated and the dial simply lost a race, say so and
file the retry-shaped ticket instead — and post the correction to
[Optimystic#12](https://github.com/gotchoices/Optimystic/issues/12), since the upstream
maintainer is currently weighing a feature request that rests on our diagnosis.

## TODO

- [ ] Stand up the relay-only control topology in `packages/integration-tests`
- [ ] Instrument the peer store at `NoValidAddressesError` time and record which branch it lands in
- [ ] Confirm or eliminate the membership gater with the suppressed-gater negative control
- [ ] Check that a relay-only control node's `getMultiaddrs()` actually contains its circuit address
- [ ] Rule out the identify protocol-id and boot-time thread-blocking candidates
- [ ] File the resulting `implement/` ticket(s) at the confirmed root cause
- [ ] Report the finding back to Optimystic#12
