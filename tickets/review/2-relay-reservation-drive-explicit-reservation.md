description: A browser tab pointed at a relay server never became reachable through it, because the tab waited for the relay to introduce itself in a dialect the relay does not speak. It now asks the relay for a slot directly, and reports a real reason when that fails.
prereq:
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/README.md, docs/architecture.md, docs/STATUS.md
difficulty: medium
----

# Review: reserve on the relay explicitly instead of waiting for libp2p relay discovery

## What changed

`driveRelayReservation` (`packages/cadre-core/src/relay-reservation.ts`) used to
dial the relay and then *wait* for `@libp2p/circuit-relay-v2`'s relay-discovery
machinery to notice it and reserve. Discovery nominates a peer only once the
relay-hop protocol id shows up in that peer's peer-store protocol list, and that
list is written exclusively by the **identify** handshake — which never completes
here, because cadre nodes speak a per-party identify protocol id
(`/optimystic/control-<partyId>/id/1.0.0`, from `@optimystic/db-p2p`) while the
relay `ops/docker/libp2p-infra` deploys speaks stock `/ipfs/id/1.0.0`. The
connection is fine; nobody ever asks for a reservation; the symptom read as a
timeout.

The drive now asks for the slot itself. Shape of the module after the change:

```
driveRelayReservation(node, addrs, {timeoutMs, pollMs})
  └─ dialRelays          → { connected: [{addr, peerId}], error }   (concurrent, deadline-bound)
  └─ requestReservation  → { error, fatal }                          (sequential, list order)
       └─ findCircuitRelayTransport(node)  →  reservationStore | null
       └─ requestOneReservation → store.addRelay(peerId, 'discovered'), deadline-raced
  └─ waitForCircuitReservation                                       (unchanged poll)
```

Key decisions, all load-bearing:

- **`'discovered'`, not `'configured'`.** The circuit listener's
  `relay:created-reservation` handler returns early for `configured`, so the
  `/p2p-circuit` listen address is never published and `getMultiaddrs()` stays
  empty even though the reservation succeeded.
- **Sequential, stop at first success.** A bare `/p2p-circuit` listener registers
  exactly ONE pending reservation; a second concurrent `addRelay` would be
  rejected with `HadEnoughRelaysError`.
- **Deadline-raced `addRelay`.** It takes no abort signal and runs on libp2p's own
  much longer reservation timeout, so without the race a 1.5 s drive would sit on
  a silent relay for libp2p's timeout. The abandoned promise stays handled
  (`Promise.race` attaches its own handlers), so no unhandled rejection.
- **Reaching `node.components.transportManager`** couples the module to libp2p's
  internal layout. There is no public "reserve on THIS relay" API. Every step is
  optional-chained, `findCircuitRelayTransport` returns `null` rather than
  throwing, and a spec pins the seam.

Failure strings now name the cause instead of the clock:

| situation | reported |
| --- | --- |
| node not listening on bare `/p2p-circuit` (libp2p says "we do not need any more relays") | "…holds no pending circuit reservation — it is not listening on the bare /p2p-circuit address" |
| no `circuitRelayTransport()` in the node's transports | "node has no circuit-relay transport — add circuitRelayTransport() to its transports" (returns at once; nothing can ever land) |
| peer at that address is not a relay | "peer at `<addr>` does not speak the circuit-relay hop protocol — it is not a relay" |
| dial failed | unchanged — the dial error |
| nothing landed in time | unchanged — `no circuit reservation within <n>ms` |

## Validation run

- `packages/cadre-core`: `npx vitest run test/relay-reservation.spec.ts` → **23/23 pass**, ~24 s.
- `packages/cadre-core`: `npx tsc -p tsconfig.typecheck.json --noEmit` → clean.
- Root: `yarn build` → all workspaces built.
- Root: `npx eslint .` → clean.
- Root: `packages/cadre-core` full `npx vitest run` → 1436 pass / **5 pre-existing
  failures** in `control-revocation-reissue.spec.ts` + `control-revocation-replay.spec.ts`.
  Already listed in `tickets/.pre-existing-known.md` under blocked ticket
  `10-revocation-reissue-same-pk-update-unique-collision`; quereus DML/constraint
  machinery, nothing this diff touches. Not re-reported, not skipped.

## Acceptance criterion — check this one first

`test/relay-reservation.spec.ts` → **`CadreNode relay reservation against a live
relay` → "reserves through the control node and clears the posture on stop"**.

The relay in that spec now runs **stock `identify()`** (it previously had to fake
a namespaced identify prefix to reserve at all). A `CadreNode` control node's
identify IS namespaced, so libp2p's relay discovery provably cannot nominate that
relay — the spec passing is the proof that the reservation is requested
explicitly. If it regresses to a timeout, the driver went back to waiting on
discovery. Confirm the namespacing still holds at
`../optimystic/packages/db-p2p/src/libp2p-node-base.ts:502` (`identify({
protocolPrefix: \`optimystic/${networkName}\` })`) — if that ever un-namespaces,
this spec silently stops being a discriminator and passes for the wrong reason.

## Other specs worth exercising by hand

- `findCircuitRelayTransport (libp2p seam)` — the tripwire for a libp2p upgrade
  moving `node.components.transportManager` or renaming `reservationStore`. Break
  either by hand and confirm this fails, not the whole file silently degrading.
- `driveRelayReservation legible failures` (3 specs) — no `/p2p-circuit` listen
  addr, no circuit-relay transport, peer that is not a relay. The first also
  asserts the reported reason does NOT contain libp2p's misleading "do not need
  any more relays", which doubles as the pin on the `HadEnoughRelaysError` name.
- The four pre-existing loopback/deadline specs are unchanged and still pass.

## Known gaps — treat these as the starting line

- **No end-to-end run against the deployed relay.** Everything here is loopback
  libp2p inside vitest. Per the source ticket, a real end-to-end check through
  `ops/docker/libp2p-infra` will still fail until
  `implement/1-relay-server-limits-cap-relayed-traffic` lands (the relayed
  connection is treated as "limited" and the db-p2p services drop its streams).
  That is not a regression from this work, but it means "reservation lands" is
  proven and "traffic flows" is not.
- **The `requestOneReservation` deadline race is untested.** No spec drives
  `addRelay` to still be pending at the deadline — the blackhole specs fail at the
  dial, so they never reach the reservation step. A relay that accepts a TCP
  connection and then goes silent on the hop stream would exercise it; nothing
  stands one up today.
- **Two-relay ordering is untested past the dead-dial case.** "First relay is a
  live non-relay, second is a real relay" (loop continues, first error discarded)
  has no spec; only "dead dial + live relay" does.
- **`findCircuitRelayTransport` duck-types** on `{ addRelay, hasReservation }`. Any
  other transport exposing both would match first. Only circuit-relay does today,
  and the seam spec would not catch a future collision.
- **`HadEnoughRelaysError` after a success is unreachable by construction**, since
  the loop returns on first success — so the source ticket's "that is success, not
  failure" rule is satisfied by control flow, not by a test.
- **Strand nodes still have no driver.** They take the same bare `/p2p-circuit`
  posture and nothing calls `reserveRelays` for them. Out of scope here, tracked by
  `backlog/strand-network-nat-relay-reachability`. The function stayed
  node-agnostic (bare `Libp2p`) so that ticket can reuse it.
- **Reference-app-web was not run.** Only its comment and README changed; no
  browser check was made that the Home "Relay" row now reaches `reserved`.

## Tripwire parked

- `packages/cadre-core/src/relay-reservation.ts` — `NOTE:` in
  `driveRelayReservation`: a *rejected* reservation still spends the rest of the
  deadline polling (only the no-transport case short-circuits), because discovery
  could still land one independently. So a misconfigured node reports its now-legible
  reason a full `timeoutMs` late. Fine now; if startup latency on that path ever
  matters, shorten the wait once every connected relay has rejected.

## Docs updated

- `relay-reservation.ts` header: the old ⚠️ block claimed search mode cannot work
  against the deployed relay. Replaced with why the module reserves explicitly —
  the namespaced-identify mismatch, and the fact that reservation, CONNECT and STOP
  all use stock un-namespaced protocol ids so none of them needs identify.
- `docs/architecture.md` → "Relay Integration" gained a
  **"Reservations are requested explicitly, not discovered"** subsection; the stale
  ⚠️ in the `network.relayAddrs` config comment is gone.
- `docs/STATUS.md`: the relay-reservation spec entry now describes the spec as the
  acceptance gate rather than as the place a defect was found.
- `packages/reference-app-web/README.md`: the "`reserved` is currently unreachable"
  warning replaced with the explicit-request explanation.
- `packages/reference-app-web/src/lib/cadre-web.ts`: `listenAddrs` comment no longer
  implies the tab depends on libp2p discovery.
- `packages/cadre-core/src/cadre-node.ts`: `reserveRelays` docstring mentions the
  explicit request.
