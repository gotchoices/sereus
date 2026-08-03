----
description: The browser app's hand-written relay-connection logic moved into the shared library, and the connection status is now read fresh every time instead of being remembered from startup — so a tab whose relay went away stops claiming it is reachable. Review also found that this reservation route cannot actually succeed against the relay this project deploys, and filed that separately.
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/README.md, docs/architecture.md, docs/STATUS.md
----

# Relay-reservation driver in cadre-core, with live state

## What shipped

`packages/cadre-core/src/relay-reservation.ts` owns the dial, the wait, and the
status derivation for a node that reserves through the **bare `/p2p-circuit`
search listener** (the browser tab's shape) rather than a configured
`network.relayAddrs` circuit listener:

- `circuitMultiaddrs(node)` — the node's `/p2p-circuit` multiaddrs, one definition.
- `driveRelayReservation(node, addrs, opts?)` — never throws; dials every relay,
  then waits for a circuit addr. One dead relay does not cost the reservation on a
  live one; a landed reservation beats any dial error.
- `resolveRelayReservationState(node|null, addrs, lastError, driving)` —
  precedence `none` → `reserved` → `dialing` → `error`, reading circuit addrs
  **live** off the node.

`CadreNode` gained `reserveRelays(addrs, opts?)` (fail-soft, opt-in — nothing calls
it for CLI/host nodes) and `getRelayReservationState()` (recomputed per call, not
memoised). `stop()` clears the recorded addrs and last error. The in-flight counter
is a count, not a boolean, so overlapping drives cannot wedge `dialing`.

`reference-app-web` deleted its own `reserveRelay` / `waitForCircuitReservation` /
`delay` / timeout constants / `relayState` module variable and its own
`RelayState`/`RelayStatus` types; `RelayState` is now an alias for cadre-core's
`RelayReservationState` and `getRelayState()` delegates to the node.
`createInvitation`'s dialability guard and the e2e debug hook both read live.
`store.svelte.ts`'s 4 s poll now runs `syncStrand` + `syncRelay` (it was
strand-only, so the Home dialability badge was a boot-time snapshot); poll symbols
renamed `STRAND_POLL_MS`/`start|stopStrandPoll` → `REFRESH_POLL_MS`/
`start|stopRefreshPoll`.

## Review findings

### Major — filed

- **The search-listener reservation route cannot succeed against the relay this
  repo deploys.** `tickets/fix/relay-search-listener-cannot-discover-stock-relay.md`
  (repro: verified). libp2p's relay *discovery* only reserves on a connected peer
  whose **identify**-learned protocol list carries the relay-hop codec.
  `@optimystic/db-p2p` namespaces identify per network
  (`/optimystic/control-<partyId>/id/1.0.0`); `ops/docker/libp2p-infra` runs stock
  identify. The two never identify each other, so no reservation is ever attempted —
  the dial succeeds and the connection stays open, which is why it surfaces as a
  generic `no circuit reservation within 10000ms` rather than a rejection.
  Reproduced at the `CadreNode` level: with a stock-identify relay the status sits
  at `error` for the full 15 s wait and `getMultiaddrs()` stays empty; with the
  prefix matched it reserves in ~0.5 s. Nothing in the implementation is wrong —
  the driver drives and reports correctly — but `reserved` is unreachable in
  production, so the shipped ticket's "relay configured and up" use case does not
  hold today. This went unseen because it is exactly the hole the implementer
  flagged: no e2e configures a relay, so only the `none` path was ever exercised.
  Pointer comments left at `relay-reservation.ts`'s header, in
  `docs/architecture.md`'s `relayAddrs` block, and in the web README.

### Minor — fixed in this pass

- **`timeoutMs` did not bound the drive.** Dials ran serially with libp2p's own
  (much longer) per-dial timeout, so `timeoutMs` bounded only the post-dial wait,
  and N unreachable relays cost N dial timeouts on the browser's startup path —
  worse than the pre-move code, which aborted at the first dial error. Dials now
  run concurrently under one shared deadline (explicit `AbortController`, not
  `AbortSignal.timeout`, which is not reliable on React Native/Hermes); first error
  in list order is still what is reported. Two tests added, using an RFC 5737
  TEST-NET-1 address so the dial *hangs* rather than being refused — the existing
  dead-relay test dials TCP port 1, which is refused instantly and so could never
  have caught this.
- **`pollMs: 0` spun the poll loop hot** until the deadline. Clamped to ≥ 1 ms.
- **`NO_RELAY_STATE` was a shared mutable module const** handed to the Svelte store,
  which assigns it into a `$state` object and proxies it — a write through that
  proxy would have mutated the singleton every later caller receives. Now a factory.
- **`packages/reference-app-web/README.md`'s "Dialability" section was stale** — it
  still described the app dialing and waiting, and said nothing about the live
  status or why `network.relayAddrs` is deliberately not set on the browser config.
  Rewritten. (The implementer updated `docs/architecture.md` and `docs/STATUS.md`
  but not this file.)

### Tests

Added three, closing two of the implementer's named gaps:

- `driveRelayReservation` gives up at its own deadline against a blackholed relay.
- Per-relay dial timeouts do not stack across a list.
- **`CadreNode`-level reservation against a live relay** — the wiring from
  `controlNode` through to a real reservation, plus the `stop()` posture reset,
  neither of which had any coverage. This is the test that surfaced the identify
  defect above; it has to use a prefix-matched relay to reserve at all, and says so
  at the site with a pointer to the fix ticket.

Not closed, and why:

- **`dialing` is still never observed for real, and overlapping `reserveRelays`
  calls are still untested.** Both need a drive caught mid-flight against a real
  relay; the counter remains a design property, not a proven one.
- **`store.svelte.ts`'s `syncRelay` transition logic is still untested.** That
  workspace's vitest config is a plain `node` environment with no Svelte plugin, so
  testing a `.svelte.ts` rune module is a test-harness change, not a test. Left as
  known debt rather than filed — it is one small function, and the behaviour it
  guards (log only on change, never log `none`) is visible in the e2e Activity log.
- **The browser's `reserved`/`error` paths remain untested end-to-end.** Now
  understood to be blocked by the identify defect, not merely unwritten: an e2e that
  configured a relay could not reach `reserved` today. It belongs with that ticket.

### Checked and clean

- **Resource cleanup** — the new deadline timer is cleared in a `finally`; the
  in-flight counter decrements in a `finally`; `stop()` clears the posture and a
  restarted node reports `none` (now pinned by test).
- **Duplication** — no other copy of the reservation logic survives. The React
  Native and NativeScript apps never had one (checked: they configure circuit
  transports but drive no reservation). `CadreNode.getRelayAddress()` still
  hand-rolls a circuit filter, but on `/p2p-circuit/` **with** the trailing slash —
  different semantics (a fully-formed relayed dial addr, not a bare listener), so it
  was deliberately left alone rather than folded into `circuitMultiaddrs`.
- **Unused imports after the deletion** — `multiaddr` and `Libp2p` in `cadre-web.ts`
  both still have other callers; lint confirms.
- **Out-of-scope surfaces verified untouched** — `resolveListenAddrs`,
  `circuitRelayTargets()`, strand listen-addr inheritance, and every non-browser
  caller. Only comments changed in `relay-addrs.ts`.
- **Tripwires** — the implementer parked three (poll-vs-event in
  `relay-reservation.ts`, the 4 s UI lag in `store.svelte.ts`, overlapping-call list
  union in `cadre-node.ts`). All re-read, all still accurate, none promoted. No new
  ones: the concerns this pass found were either defects (fixed or filed) or
  documentation, none of the "fine now, only matters if X" shape.

## Validation

| command | result |
| --- | --- |
| `yarn workspace @serfab/cadre-core test relay-reservation` | 18/18 pass |
| `yarn workspace @serfab/cadre-core test` (full) | 1431 pass, 5 fail, 1 skip — all 5 pre-existing |
| `yarn workspace @serfab/cadre-core typecheck` | clean |
| `yarn workspace @serfab/reference-app-web typecheck` / `typecheck:e2e` / `check:svelte` | clean (0 errors, 0 warnings) |
| `yarn workspace @serfab/reference-app-web test` | 15/15 pass |
| `yarn --cwd packages/reference-app-web test:e2e e2e/solo` | 35/35 pass (~1.3 min) |
| `yarn lint` | clean |

The 5 core failures are `control-revocation-reissue.spec.ts` (4) and
`control-revocation-replay.spec.ts` (1), both already listed in
`tickets/.pre-existing-known.md` against
`10-revocation-reissue-same-pk-update-unique-collision` (blocked) and
`10-control-revocation-reissue-test-fixes` (implement), with the same two
fingerprints. Not re-reported, not touched.

The stale-build guard required rebuilding the linked `../quereus` workspace and
`@serfab/cadre-core`'s own dist before the suites would run; no source in either was
edited beyond this ticket's own files.
