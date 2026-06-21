----
description: Review the new detection layer that counts TURN-relayed WebRTC connections as "relayed" (transport "webrtc-turn") in connectivity metrics, instead of silently reporting them as "direct".
files: packages/cadre-core/src/diagnostics/connection-path.ts, packages/reference-app-web/src/lib/connection-path.ts, packages/cadre-core/src/diagnostics/webrtc-turn-tracker.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/connection-path.spec.ts, packages/cadre-core/test/webrtc-turn-tracker.spec.ts, packages/reference-app-web/e2e/solo/connection-path-parity.spec.ts
difficulty: medium
----

## What was built

Three layers were added so a TURN-relayed `/webrtc` session is classified
`relayed`/`webrtc-turn` instead of `direct`/`webrtc`. TURN is off by default, so
in current production the only observable change is the new (always-zero)
`webrtc-turn` series; the detection path only lights up once TURN is enabled.

### Layer 1 — classifier (both mirrored copies)
`packages/cadre-core/src/diagnostics/connection-path.ts` and its deliberate
duplicate `packages/reference-app-web/src/lib/connection-path.ts`:

- `ConnectionTransport` union gains `'webrtc-turn'`.
- `ConnectionLike` gains `turnRelayed?: boolean` (set externally; `undefined` =
  unknown).
- `classifyConnectionPath(conn)` now applies a TURN override **after** the
  multiaddr classification: `transport === 'webrtc' && conn.turnRelayed === true`
  → `{ kind: 'relayed', transport: 'webrtc-turn' }`. The `=== 'webrtc'` guard means
  `webrtc-direct` is never promoted (no ICE), and `undefined`/`false` degrade to
  the multiaddr result.
- `classifyTransport(addr)` is **unchanged** — still a pure string function; it
  cannot and does not produce `webrtc-turn`.
- `summarizeConnectionPaths` now classifies via `classifyConnectionPath(conn)`
  (not `classifyTransport(remoteAddr)`) so the hint is honoured. `stuckOnRelay`
  semantics are unchanged: `webrtc-turn` has `kind === 'relayed'`, so an aged
  TURN session with no direct sibling correctly flags stuck.
- `'webrtc-turn'` added to `ALL_TRANSPORTS` (so `zeroByTransport()` and the
  Prometheus `byTransport` series pick it up automatically).

### Layer 2 — `TurnRelayTracker` (new)
`packages/cadre-core/src/diagnostics/webrtc-turn-tracker.ts`. Wraps
`globalThis.RTCPeerConnection` with a subclass that, on
`connectionstatechange → 'connected'`, calls `getStats()`, finds the selected ICE
candidate pair (transport `selectedCandidatePairId` → else nominated/succeeded
pair), and pushes `{ settledAtMs, isRelay }` (relay iff either candidate's
`candidateType === 'relay'`) onto a FIFO queue.
- `install()` — NOP if no `RTCPeerConnection` (Node.js); idempotent.
- `consume(windowMs)` — pops the most recent in-window entry (`true`/`false`),
  `null` if none; also prunes stale entries.
- `dispose()` — restores the original constructor, clears the queue.
- All `getStats`/listener work is try/caught → defaults to `isRelay: false`
  (unknown ⇒ not relayed, never a false positive).

### Layer 3 — `CadreNode` wiring
`packages/cadre-core/src/cadre-node.ts`:
- `turnTracker` installed at the very top of `start()` (before `createControlNode`,
  so it wraps `RTCPeerConnection` before libp2p can create one); `dispose()`d in
  `cleanup()`.
- `_turnRelayedPeers: Set<string>` maintained by two listeners added inside
  `wireControlConnectionListeners()`: `connection:open` for a `/webrtc` addr calls
  `consume(1000)` and adds the peerId on `true`; `connection:close` deletes it.
  Listeners torn down in `stopRecordRefresh()` alongside the existing ones.
- `getConnectionPaths()` annotates each connection with
  `turnRelayed: this._turnRelayedPeers.has(peerId)` before `summarizeConnectionPaths`.

## How to validate

- **Unit (cadre-core):** `cd packages/cadre-core && yarn vitest run
  test/connection-path.spec.ts test/webrtc-turn-tracker.spec.ts` — 44 tests.
  Covers: hint promotes webrtc→webrtc-turn; `webrtc-direct` never promoted;
  `turnRelayed:false`/`undefined` stay direct; `classifyTransport` unchanged;
  aged webrtc-turn → `stuckOnRelay`; webrtc-turn excluded from stuck when the peer
  also has a direct conn; tracker relay/non-relay/rejection-default detection;
  tracker inert with no `RTCPeerConnection`; `dispose()` restores the global.
- **Full suite:** `yarn vitest run` in cadre-core → 641 passed, 1 skipped (47
  files). No regressions.
- **Web:** in `packages/reference-app-web`: `yarn typecheck`, `yarn typecheck:e2e`
  (covers the parity spec — it lives under `e2e/`, NOT `check:svelte`), and
  `yarn check:svelte` (850 files, 0 errors). The parity table mirrors the
  cadre-core `CLASSIFIER_TABLE` and now drift-guards both `classifyTransport`
  (pure rows) and `classifyConnectionPath` (incl. the `webrtc-turn` hint row).
- **Lint:** `npx eslint` on all touched files is clean.

## Known gaps / things to scrutinise (this is a starting point, not a finish line)

- **Settlement↔open correlation is best-effort timing.** `consume(1000)` pops the
  *most recent* in-window entry. Under near-simultaneous concurrent WebRTC dials
  the settlement may be assigned to the wrong peer. Documented; acceptable because
  TURN is off by default. A `Map<RTCPeerConnection, boolean>` keyed by object
  identity would fix it but needs a deeper hook into `@libp2p/webrtc` (deferred —
  candidate follow-up if TURN ships enabled).
- **Startup race window.** The tracker is installed before `createControlNode`,
  but the `connection:open` *listener* is wired later (in
  `wireControlConnectionListeners`, after `_running = true`). A WebRTC connection
  that opens during control-node bootstrap, before the listener attaches, won't
  consume — its settlement just ages out of the queue. Bootstrap control conns are
  normally circuit-relay/ws, not TURN-webrtc, so low-risk, but worth a look.
- **`connection:close` clears the peer flag unconditionally.** If a peer holds two
  connections and one closes, the flag is dropped even if the TURN one persists.
  This matches the ticket spec ("fresh detection cycle on reconnect") but a
  reviewer may want multi-connection-per-peer reference counting.
- **`getStats()` candidate-pair selection is heuristic.** Real browser reports vary
  (Firefox uses `selected`, not always `nominated`; some omit a `transport`
  entry). The fake-`RTCPeerConnection` tests exercise the transport-id and
  nominated-pair paths but **not** a real browser stats report. No live
  TURN-relayed e2e exists — detection has not been verified end-to-end against an
  actual coturn/relay. This is the biggest unverified surface.
- **`TurnRelayTracker` is not exported from `cadre-core/src/index.ts`** (internal
  to `CadreNode`; tests import it by path). Export it if a host app needs it.
- **`flush()` in the tracker spec uses two `setTimeout(0)` ticks** to drain the
  async settlement deterministically (one isolated run flaked on a single tick
  before this hardening; stable 3× after). If the spec ever flakes again,
  suspect microtask ordering here first.
