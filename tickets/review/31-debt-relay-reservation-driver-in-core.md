---
description: The browser app's hand-written relay-connection logic moved into the shared library, and the connection status is now read fresh every time instead of being remembered from startup — so a tab whose relay went away stops claiming it is reachable.
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/e2e/solo/diagnostics.spec.ts, docs/architecture.md, docs/STATUS.md
difficulty: medium
---

# Review: relay-reservation driver in cadre-core, with live state

## What landed

**New `packages/cadre-core/src/relay-reservation.ts`** — the dial, the wait, and the status
derivation for a node that reserves through the **bare `/p2p-circuit` search listener** (what a
browser tab uses) rather than a configured `network.relayAddrs` circuit listener.

- `circuitMultiaddrs(node)` — the node's multiaddrs filtered to `/p2p-circuit`. Single definition;
  the web app's inline filter is gone.
- `driveRelayReservation(node, addrs, opts?)` — dials each addr, then polls until a circuit addr
  appears or the deadline passes. Never throws. A dial that rejects does **not** abort the rest of
  the list (first error kept, loop continues); a reservation that lands wins over any dial error.
- `resolveRelayReservationState(node | null, addrs, lastError, driving)` — precedence
  `none` → `reserved` → `dialing` → `error`, reading circuit addrs **live** off the node.
- Header comment records the configured-vs-search listener table and why configuring both on one
  node re-introduces the fatal listener. `relay-addrs.ts` got a matching `NOTE:` pointing back.

**`CadreNode`** gained `reserveRelays(addrs, opts?)` (fail-soft, opt-in — nothing calls it for the
CLI/host nodes) and `getRelayReservationState()` (recomputed every call, deliberately not
memoised). Three private fields; `stop()` clears the addr list and last error so a restarted node
does not report a dead run's reservation. `relayReserveDriving` is a **count**, not a boolean, so
overlapping calls cannot wedge the status at `dialing`.

**`packages/reference-app-web/src/lib/cadre-web.ts`** — deleted `reserveRelay`,
`waitForCircuitReservation`, `delay`, the two timeout constants, the `relayState` module variable
and its three assignment sites, and the app's own `RelayState`/`RelayStatus` declarations.
`RelayState` is now an alias for cadre-core's `RelayReservationState`. `getRelayState()` delegates
to the node. `createInvitation`'s dialability guard and `exposeDebugHook`'s `getRelayState` both
read live. `listenAddrs` is unchanged and now carries a comment saying why `network.relayAddrs` is
deliberately NOT set on the browser config.

**`store.svelte.ts`** — the 4 s poll was strand-only, so `state.relay` (which Home's dialability
badge renders) was a boot-time snapshot. It now runs `pollTick` = `syncStrand` + `syncRelay`, and
`syncRelay` records an Activity-log entry only on an actual transition. Poll symbols renamed
`STRAND_POLL_MS`/`startStrandPoll`/`stopStrandPoll` → `REFRESH_POLL_MS`/`startRefreshPoll`/
`stopRefreshPoll` to match what they now cover.

**Docs** — `docs/architecture.md`'s `relayAddrs` config block now states the fail-fast/fail-soft
split and names the alternative; `docs/STATUS.md`'s "still uncovered: the browser's listening
posture" line is corrected, since the new spec covers exactly that shape on loopback.

## Use cases to poke at

- **Solo tab, no relay** (the shipped default): `resolveRelayAddrs()` returns `[]` →
  `reserveRelays([])` → `none`, instantly, no dial, no timeout wait. Diagnostics shows `none`,
  Home's formation panel shows the not-dialable guard.
- **Relay configured and up**: status reaches `reserved`, `circuitAddrs` non-empty,
  `createInvitation` passes its guard.
- **Relay configured and down**: `startCadre()` still completes, node still running, status
  `error` with the dial failure message. This is the fail-soft contract — the tab boots solo.
- **Relay dies after a successful reserve** (the defect this ticket exists for): status must flip
  `reserved` → `error` and `circuitAddrs` must empty, within one 4 s UI tick.
  `createInvitation` must then refuse rather than mint an invitation with dead circuit addresses.
- **Relay comes back**: status returns to `reserved` with **no** second `reserveRelays()` call.
- **Two relays, one dead**: still `reserved`, `error: null`.

## Validation run

| command | result |
| --- | --- |
| `yarn workspace @serfab/cadre-core test relay-reservation` | 15/15 pass (~17 s) |
| `yarn workspace @serfab/cadre-core test` (full) | 1428 pass, 5 fail, 1 skip — **all 5 pre-existing**, see below |
| `yarn workspace @serfab/cadre-core typecheck` | clean |
| `yarn workspace @serfab/reference-app-web typecheck` / `typecheck:e2e` / `check:svelte` | clean (0 errors, 0 warnings) |
| `yarn workspace @serfab/reference-app-web test` | 15/15 pass |
| `yarn --cwd packages/reference-app-web test:e2e e2e/solo` | 35/35 pass (~1.3 min) |
| `yarn lint` | clean |

The 5 core failures are `control-revocation-reissue.spec.ts` (4) and
`control-revocation-replay.spec.ts` (1). Both are already listed in
`tickets/.pre-existing-known.md` against `10-revocation-reissue-same-pk-update-unique-collision`
(blocked) and `10-control-revocation-reissue-test-fixes` (implement), with the same two
fingerprints (`UNIQUE constraint failed: Revocation.TableName, Revocation.StampId` and
`context.OwnerKey isn't a column`). Not re-reported, not touched.

The test run's stale-build guard demanded a rebuild of the linked `../quereus` workspace before
any cadre-core test could run; that rebuild was done and no source there was edited.

## Known gaps — treat the tests as a floor

- **No `CadreNode`-level test against a live relay.** The loopback half of the new spec drives the
  free functions over a bare `createLibp2p` node. `reserveRelays` itself is only asserted on the
  no-control-node and empty-list paths. Nothing proves the wiring from `CadreNode.controlNode`
  through to a real reservation, and nothing asserts the `stop()` field reset.
- **`dialing` is never observed for real.** The pure test forces the flag; no test catches a drive
  mid-flight. Likewise the concurrent-call safety is a design property of the counter, not a
  proven one — no test issues two overlapping `reserveRelays`.
- **The browser's `reserved`/`error` paths are still untested end-to-end.** No e2e configures a
  relay (`VITE_RELAY_ADDR` and the `relay-addr` localStorage key are unset everywhere), so the new
  `diag-relay-status` assertion covers only the `none` path. That was already true before this
  change; it is not newly introduced, but it is the biggest hole.
- **The dead-relay test dials TCP port 1** and relies on a prompt connection refusal. It passed in
  milliseconds locally; on a host that blackholes that port the 2 s `timeoutMs` still bounds it,
  but the assertion then proves "timed out", not "dial refused".
- **`store.svelte.ts` has no unit test.** The `syncRelay` transition-recording logic (only log on
  change, never log `none`) is asserted by nothing.

## Tripwires parked in code

- `relay-reservation.ts`, at the poll helper — polls instead of subscribing to libp2p's
  `self:peer:update` to stay free of event-name coupling; switch if 250 ms of reservation latency
  ever matters.
- `store.svelte.ts`, at `pollTick` — relay posture refreshes on the 4 s tick, so a lost
  reservation surfaces in the UI up to 4 s late; read `getRelayState()` at the decision point
  (as `createInvitation` does) rather than shortening the tick.
- `cadre-node.ts`, at `reserveRelays` — two overlapping calls with different lists leave the last
  caller's list recorded; union them if a second relay source ever appears.

## Explicitly out of scope (and verified untouched)

`resolveListenAddrs` / `relay-addrs.ts` behaviour, `circuitRelayTargets()`, strand-node listen-addr
inheritance, and every non-browser caller (`cadre-cli`, `cadre-host`, `reference-app-rn`) — the new
surface is opt-in and nothing calls it for them. Only comments changed in `relay-addrs.ts`.
