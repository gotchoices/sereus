---
description: The browser app hand-writes the logic for connecting to a relay server and tracking whether that connection succeeded, and it never notices when the connection is later lost. Move that logic into the shared library and make it report the live truth.
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/store.svelte.ts
difficulty: medium
---

# Move the relay-reservation driver into cadre-core, and make its state live

## What the plan stage found

The plan ticket asked whether `network.relayAddrs` (cadre-core) should absorb the browser
app's hand-rolled relay reservation (`reserveRelay` / `waitForCircuitReservation` in
`packages/reference-app-web/src/lib/cadre-web.ts:414-462`). Answer: **no — not the listen-addr
half. Yes — the driver and the state.** Three findings drove that.

### 1. The two paths use different libp2p mechanisms, not one mechanism twice

`@libp2p/circuit-relay-v2`'s listener branches on the shape of the listen address
(`node_modules/@libp2p/circuit-relay-v2/dist/src/transport/listener.js:51-75`):

| listen addr | libp2p behaviour | on an unreachable relay |
| --- | --- | --- |
| `<dial addr>/p2p/<relayPeerId>/p2p-circuit` — what `relayAddrs` produces | "configured" reservation: dial that exact relay, reserve, or fail | `listen()` throws `ListenError` |
| bare `/p2p-circuit` — what the web app uses | "search" mode: start relay discovery, reserve on any connected peer that speaks the hop protocol | nothing throws; no reservation appears |

libp2p's transport manager then throws `UnsupportedListenAddressesError` when **any**
configured listen address fails to listen and fault tolerance is `FATAL_ALL`
(`node_modules/libp2p/dist/src/transport-manager.js:222-243`). `FATAL_ALL` is the default and
`@optimystic/db-p2p`'s `createLibp2pNodeBase` exposes no `transportManager` option
(`../optimystic/packages/db-p2p/src/libp2p-node-base.ts:461-480`), so it cannot be changed
from this repo.

So `relayAddrs` is **fail-fast by construction**: name a relay that is down and the node does
not start. The browser app's bare `/p2p-circuit` + explicit dial is **fail-soft by
construction**: the discovery-mode listener never fails, and the explicit dial is what puts the
relay in the peer store so discovery can reserve on it. Migrating the app onto `relayAddrs`
would trade its fail-soft posture for a tab that refuses to boot when the relay is down — and
it would cascade, because strand nodes inherit the resolved listen addrs verbatim
(`packages/cadre-core/src/strand-instance-manager.ts:307-319`), so every formed strand would
also hard-fail on an unreachable relay.

**Decision: leave the web app's `listenAddrs: ['/p2p-circuit', '/webrtc']` exactly as it is,
and do NOT set `network.relayAddrs` on the browser config.** Setting it would add the fatal
configured listener alongside the search listener — the exact regression above. This is a trap
worth spelling out in a code comment.

### 2. The plan ticket's stated reasons to consolidate do not hold

Both were checked and are wrong; do not carry them forward:

- *"the hand-rolled path bypasses `circuitRelayTargets()`, so a relay dialled this way is not a
  delegate-announce target."* False. `circuitRelayTargets()` reads two sources — the resolved
  listen addrs **and the control node's live multiaddrs** (`cadre-node.ts:3516-3521`). Once
  the reservation lands, the control node's multiaddrs include
  `<relayAddr>/p2p/<relayPeerId>/p2p-circuit/p2p/<self>`, and `parseCircuitRelayTarget`
  extracts the relay from exactly that shape (`delegate-admission.ts:269-287`). The relay is
  already a delegate-announce target. Only the bare `/p2p-circuit` *listen* entry is skipped,
  which costs nothing.
- *"asserted by the solo e2e diagnostics spec."* False. `data-testid="diag-relay-status"` is
  rendered by `Diagnostics.svelte:142` and asserted by **no** test — `grep -rn "diag-relay"
  packages/reference-app-web/` returns that one line. No e2e configures a relay at all
  (`VITE_RELAY_ADDR` / the `relay-addr` localStorage key are unset everywhere), so the whole
  reserve path is untested today. Migration risk is therefore low, and adding the first real
  coverage is part of this ticket.

### 3. There is a real defect in the hand-rolled path: the state goes stale

`relayState` is computed once during `startCadre()` and never updated
(`cadre-web.ts:301-306, 414-448`). When the relay restarts or the connection drops, libp2p's
listener clears its listening addrs and the circuit multiaddr disappears from
`control.getMultiaddrs()` (`listener.js:27-39`) — but `relayState.status` stays `'reserved'`
forever. Consequences, both reachable today with a relay configured:

- `Diagnostics.svelte` keeps reporting `reserved` for a tab that is no longer dialable.
- `createInvitation` gates on `relayState.status !== 'reserved'` (`cadre-web.ts:575`), so it
  passes the guard and then mints an invitation embedding circuit addresses that no longer
  route. The joiner gets an opaque dial failure instead of the intended clear
  "this tab is not dialable" error.

The fix falls out of the move: derive the reservation state from the node's **live** multiaddrs
on every read instead of caching a snapshot.

## What to build

A relay-reservation driver in cadre-core that owns the dial, the wait, and the state — while
leaving listen-address configuration alone.

### New module: `packages/cadre-core/src/relay-reservation.ts`

Header comment must record the table in finding 1 (configured vs search listen addrs, and why
this repo has both), so a future reader does not "clean up" the duplication a second time.

```ts
/**
 * Relay-reservation posture for a node that reserves through the SEARCH listen
 * addr (bare `/p2p-circuit`) rather than a configured `network.relayAddrs` entry.
 *  - `none`     — no relay addrs supplied; the node is undialable by design.
 *  - `dialing`  — a drive is in flight.
 *  - `reserved` — the node currently holds at least one `/p2p-circuit` addr.
 *  - `error`    — the last drive failed, or finished with no reservation, and
 *                 none is held now.
 */
export type RelayReservationStatus = 'none' | 'dialing' | 'reserved' | 'error';

export interface RelayReservationState {
	status: RelayReservationStatus;
	/** The relay multiaddrs this node was asked to reserve through. */
	addrs: string[];
	/** LIVE `/p2p-circuit` multiaddrs, recomputed on every read. */
	circuitAddrs: string[];
	error: string | null;
}

export const DEFAULT_RELAY_RESERVE_TIMEOUT_MS = 10_000;
export const DEFAULT_RELAY_RESERVE_POLL_MS = 250;

export interface RelayReserveOptions {
	timeoutMs?: number;
	pollMs?: number;
}
```

Free functions over a plain `Libp2p`, so they are testable against a bare libp2p node with no
`CadreNode` in the picture:

- `circuitMultiaddrs(node: Libp2p): string[]` — the node's multiaddrs filtered to those
  containing `/p2p-circuit`. Single definition; `cadre-web.ts`'s inline filter goes away.
- `driveRelayReservation(node, addrs, opts?): Promise<{ error: string | null }>` — dial each
  addr, then poll `circuitMultiaddrs` until non-empty or the deadline. Fail-soft: never throws;
  a dial rejection or a timeout is returned as an `error` string. A dial that throws does not
  abort the remaining addrs — record the first error and keep going, so one dead relay in a
  list of two does not cost the reservation on the live one.
- `resolveRelayReservationState(node | null, addrs, lastError, driving): RelayReservationState`
  — the pure status derivation, in this precedence:

  | condition | status |
  | --- | --- |
  | `addrs.length === 0` | `none` |
  | live circuit addrs present | `reserved` (and `error: null` — a live reservation supersedes a stale error) |
  | `driving` | `dialing` |
  | otherwise | `error` (with `lastError`, or a "no circuit reservation within Nms" message) |

  Note the ordering: `reserved` is checked before `error`, so a relay that comes back after a
  failed drive self-heals to `reserved` with no re-drive.

Poll rather than subscribing to libp2p's `self:peer:update`: polling keeps this free of
libp2p event-name coupling and matches the code being replaced. `NOTE:` at the poll site — if
250 ms of reservation latency ever matters, switch to the event with the poll as a fallback.

### `packages/cadre-core/src/cadre-node.ts`

- Private fields for the supplied relay addrs, the last error, and an in-flight flag.
- `async reserveRelays(addrs: string[], opts?: RelayReserveOptions): Promise<RelayReservationState>`
  — public, fail-soft, idempotent-safe. No control node → returns `status: 'error'` with
  `'control node unavailable'` (mirrors `cadre-web.ts:421`). Empty `addrs` → resets to `none`.
  Delegates to `driveRelayReservation` and returns `getRelayReservationState()`.
- `getRelayReservationState(): RelayReservationState` — recomputes from the live control node
  on every call. This is the finding-3 fix; do not memoise it.
- Reset the three fields in `stop()` (`cadre-node.ts:751`) so a restarted node does not report
  a dead node's reservation.

Do **not** touch `relay-addrs.ts`'s behaviour. Add one `NOTE:` to its header comment pointing
at `relay-reservation.ts` and stating that `relayAddrs` is the fail-fast route and the search
route is the fail-soft one — the two are alternatives, not layers, and configuring both on one
node re-introduces the fatal listener.

### `packages/cadre-core/src/index.ts`

Export `RelayReservationStatus`, `RelayReservationState`, `RelayReserveOptions`,
`circuitMultiaddrs`, and the two default constants, in the style of the connection-path block
at `index.ts:355-367`.

### `packages/reference-app-web/src/lib/cadre-web.ts`

- Delete `reserveRelay`, `waitForCircuitReservation`, `delay`, `RELAY_RESERVE_TIMEOUT_MS`,
  `RELAY_RESERVE_POLL_MS`, the `relayState` module variable, and its three assignment sites
  (start, reserve, `stopCadre`).
- Keep `listenAddrs: relayAddrs.length > 0 ? ['/p2p-circuit', '/webrtc'] : []` unchanged, and
  add a comment saying why `network.relayAddrs` is deliberately NOT set here (finding 1).
- Replace the `reserveRelay(node, relayAddrs)` call at `cadre-web.ts:366` with
  `await node.reserveRelays(relayAddrs)`.
- `getRelayState()` becomes `node?.getRelayReservationState() ?? { status: 'none', addrs: [],
  circuitAddrs: [], error: null }`. Re-export cadre-core's `RelayReservationState` as the local
  `RelayState` alias so `diagnostics.svelte.ts:140` and `store.svelte.ts:45` keep compiling
  unchanged; drop the app's own `RelayState` / `RelayStatus` declarations
  (`cadre-web.ts:85-101`).
- `store.svelte.ts:165` (`state.relay = getRelayState()`) now picks up live status on every
  refresh tick — that is the intended behaviour change, not an accident. Confirm the refresh
  path actually re-runs periodically; if it only runs once at boot, the diagnostics panel still
  shows a stale value even though the source is live. Fix it there if so.
- `exposeDebugHook`'s `getRelayState: () => relayState` must become
  `getRelayState: () => getRelayState()` — a captured module variable would defeat the whole
  change.

## Edge cases & interactions

- **Reservation lost after start.** Drop the relay connection after a successful reserve;
  `getRelayReservationState().status` must go `reserved` → `error` and `circuitAddrs` must
  empty. This is the finding-3 regression test — the one that must exist.
- **Relay returns.** After the above, a re-established reservation must flip status back to
  `reserved` with no second `reserveRelays()` call, because `circuitAddrs` is read live.
- **Empty `addrs`.** `status: 'none'`, `error: null`, no dial attempted, no timeout waited. The
  solo web tab takes this path on every boot, so it must be instant.
- **Unreachable relay.** `reserveRelays` resolves (never rejects) with `status: 'error'` inside
  the timeout, and `startCadre()` completes normally. Assert the node is running afterwards —
  the fail-soft contract is the point.
- **Mixed list, one relay up and one down.** One dial rejects, the other reserves →
  `status: 'reserved'`, `error: null`. Guards against an early `return`/`throw` in the dial loop.
- **Called before `start()` / after `stop()`.** No control node → `status: 'error'`,
  `'control node unavailable'`, no throw. After `stop()`, `getRelayReservationState()` returns
  `none` — not a stale `reserved` from the previous run.
- **Called twice concurrently.** Two overlapping `reserveRelays` calls must not corrupt the
  in-flight flag such that `status` sticks at `dialing` forever. Simplest correct shape: the
  flag is set on entry and cleared in a `finally`; if that leaves a window, hold a count instead
  of a boolean.
- **`circuitRelayTargets()` unchanged.** Its two sources still work: the bare `/p2p-circuit`
  listen entry is skipped by design and the live reservation addr is picked up. Re-check that
  nothing in this change removes a live circuit multiaddr from the control node.
- **Strand nodes untouched.** No listen-addr semantics change, so strand nodes inherit exactly
  what they inherit today. If the diff touches `resolveListenAddrs` behaviour, it has gone out
  of scope.
- **Non-browser callers.** `cadre-cli` / `cadre-host` use `relayAddrs` and must be entirely
  unaffected — `reserveRelays` is opt-in and nothing calls it for them. `reference-app-rn`
  (`listenAddrs: []`, no relay) is likewise untouched; it is the obvious future consumer.

## TODO

### Phase 1 — cadre-core

- Add `packages/cadre-core/src/relay-reservation.ts` with the types, `circuitMultiaddrs`,
  `driveRelayReservation`, `resolveRelayReservationState`, and the header comment recording the
  configured-vs-search table from finding 1.
- Add `reserveRelays` / `getRelayReservationState` to `CadreNode`, plus the field resets in
  `stop()`.
- Add the `NOTE:` cross-reference to `relay-addrs.ts`'s header comment.
- Export the new surface from `index.ts`.

### Phase 2 — tests

- `packages/cadre-core/test/relay-reservation.spec.ts`, pure-function half: table-drive
  `resolveRelayReservationState` over every row of the precedence table, including
  live-circuit-addrs-beats-stale-error and empty-addrs-beats-everything.
- Same file, loopback half — follow the `circuitRelayServer` + `createLibp2p` harness in
  `packages/cadre-core/test/strand-transport-relay.spec.ts:44+`:
  - bare `/p2p-circuit` listener + `driveRelayReservation` against a live loopback relay →
    resolves with `error: null` and `circuitMultiaddrs(node)` non-empty;
  - stop the relay → `circuitMultiaddrs(node)` drains and the derived status becomes `error`;
  - drive against an addr with nothing listening → resolves inside the timeout with a non-null
    error, and the node is still running.
  Keep the timeouts short (pass `timeoutMs` explicitly) so the file does not sit near the
  10-minute idle window.
- Extend `packages/cadre-core/test/cadre-node-control-node-options.spec.ts` only if the
  no-control-node path is cheaper to assert there; otherwise assert it in the new spec.

### Phase 3 — web app

- Strip the hand-rolled path from `cadre-web.ts`; wire `reserveRelays` + the delegating
  `getRelayState`; alias the type; fix the `exposeDebugHook` closure.
- Add the "why `network.relayAddrs` is not set here" comment next to `listenAddrs`.
- Check `store.svelte.ts`'s refresh cadence actually re-reads relay state; fix if it does not.

### Phase 4 — validate

- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/core-test.log`
- `yarn workspace @serfab/cadre-core typecheck` and the reference-app-web typecheck/`svelte-check`
  equivalent (whatever its `package.json` names).
- `yarn lint`
- Solo web e2e (`packages/reference-app-web/e2e/solo`) — no relay is configured there, so it
  exercises the `addrs.length === 0` → `none` path end to end and must stay green.
