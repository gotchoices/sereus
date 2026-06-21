----
description: A TURN-relayed WebRTC connection silently reports as "direct" in connectivity metrics. Add the WebRTC ICE relay detection layer so TURN-relayed paths are counted as relayed (transport "webrtc-turn") throughout the classifier, Prometheus gauges, and the stuck-on-relay signal.
files: packages/cadre-core/src/diagnostics/connection-path.ts, packages/reference-app-web/src/lib/connection-path.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/connection-path.spec.ts, packages/reference-app-web/e2e/solo/connection-path-parity.spec.ts
difficulty: medium
----

## Background

`@libp2p/webrtc` keeps the underlying `RTCPeerConnection` as a **private** field of its
internal `RTCPeerConnectionMultiaddrConnection` class and does not surface it on the libp2p
`Connection` object. The `classifyTransport` function therefore cannot detect whether ICE
selected a TURN relay candidate: it sees only a `/webrtc` multiaddr and calls it `direct`.

When TURN is enabled (currently off by default), every TURN-relayed session is silently
mis-reported as `direct`, defeating the relay-usage observability built in ticket 1.

## Design

Three independent layers, applied in order:

### Layer 1 — Classifier changes (both mirrored files)

`ConnectionTransport` union gains `'webrtc-turn'`.

```typescript
export type ConnectionTransport =
  | 'circuit-relay'
  | 'webrtc'
  | 'webrtc-turn'   // ← new: WebRTC session whose ICE selected a TURN relay candidate
  | 'webrtc-direct'
  | 'websocket'
  | 'tcp'
  | 'unknown';
```

`ConnectionLike` gains an optional hint:

```typescript
export interface ConnectionLike {
  remotePeer?: { toString(): string };
  remoteAddr?: { toString(): string };
  direction?: 'inbound' | 'outbound';
  timeline?: { open?: number };
  turnRelayed?: boolean;   // ← set externally when ICE selected TURN; undefined = unknown
}
```

`classifyConnectionPath` applies the TURN override **after** the multiaddr check:

```typescript
export function classifyConnectionPath(conn: ConnectionLike): TransportClass {
  const { kind, transport } = classifyTransport(addrString(conn));
  if (transport === 'webrtc' && conn.turnRelayed === true) {
    return { kind: 'relayed', transport: 'webrtc-turn' };
  }
  return { kind, transport };
}
```

`classifyTransport(remoteAddr: string)` is **unchanged** — it stays a pure string function.

`summarizeConnectionPaths` must call `classifyConnectionPath(conn)` instead of
`classifyTransport(remoteAddr)` so the TURN hint is honoured. The existing stuck-on-relay
semantics are correct as-is: `webrtc-turn` has `kind === 'relayed'`, so a TURN-relayed
connection older than the settle window with no direct sibling will be flagged `stuckOnRelay`.
This is the desired signal — it tells operators TURN relay is being used long-term.

`ALL_TRANSPORTS` gets `'webrtc-turn'`; `zeroByTransport()` picks it up automatically.

Both copies must be updated identically. The parity test guards against drift.

### Layer 2 — `TurnRelayTracker` (new, cadre-core)

New file: `packages/cadre-core/src/diagnostics/webrtc-turn-tracker.ts`

Intercepts `globalThis.RTCPeerConnection` at install time. Wraps the constructor with a
subclass that installs a `connectionstatechange` listener. When state reaches `'connected'`,
it calls `getStats()` and inspects the succeeded candidate-pair to determine whether the local
or remote candidate type is `'relay'`.

The result is pushed onto a FIFO queue: `{ settledAtMs: number; isRelay: boolean }[]`.

```typescript
export class TurnRelayTracker {
  private readonly queue: Array<{ settledAtMs: number; isRelay: boolean }> = [];
  private OriginalRTCPeerConnection: typeof RTCPeerConnection | undefined;

  /** Wraps globalThis.RTCPeerConnection. NOP if it does not exist (Node.js). */
  install(): void { ... }

  /**
   * Pops the most recent settled entry within `windowMs` ms of now.
   * Returns true/false if found, null if the queue has no matching entry.
   * Safe to call from connection:open handlers.
   */
  consume(windowMs: number): boolean | null { ... }

  /** Restores original RTCPeerConnection; clears queue. */
  dispose(): void { ... }
}
```

`getStats()` and the `connectionstatechange` listener must be wrapped in try/catch; any
error returns `isRelay: false` (safe default: unknown → not relayed).

The wrapper checks `globalThis.RTCPeerConnection` at `install()` time. If absent (Node.js /
no polyfill), the method returns immediately and the tracker is inert.

### Layer 3 — Wire-up in `CadreNode`

`CadreNode` (`packages/cadre-core/src/cadre-node.ts`) gains a `TurnRelayTracker` instance
created in its constructor (or `start()`) and installed immediately.

It maintains a `_turnRelayedPeers: Set<string>` (peer ID strings). Two listeners on
`this.controlNode`:

- `connection:open`: if `connection.remoteAddr.toString()` contains `/webrtc`, call
  `this._turnTracker.consume(1000)` and if `true`, add `peerId` to the set.
- `connection:close`: remove `peerId` from the set (cleanup).

`getConnectionPaths()` annotates each connection before passing to `summarizeConnectionPaths`:

```typescript
getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary {
  const conns = this.controlNode?.getConnections() ?? [];
  const annotated = conns.map((c) => ({
    remotePeer: c.remotePeer,
    remoteAddr: c.remoteAddr,
    direction: c.direction,
    timeline: c.timeline,
    turnRelayed: this._turnRelayedPeers.has(c.remotePeer.toString()),
  }));
  return summarizeConnectionPaths(annotated, settleWindowMs);
}
```

`CadreNode.stop()` / cleanup must call `this._turnTracker.dispose()` and add the
`connection:open` / `connection:close` listeners to the existing teardown path.

## Edge cases & interactions

- **Timing correlation**: RTCPeerConnection reaches `'connected'` → @libp2p/webrtc resolves
  → upgrader creates Connection → `connection:open` fires. These happen in tight async sequence.
  A 1000 ms consume window is generous. Document the approximation; it degrades gracefully
  (unknown → treated as not-relayed, a safe default that avoids false positives).

- **Concurrent WebRTC connections**: Two peers connecting near-simultaneously use the same FIFO
  queue. Correlation is best-effort: consume() always pops the head. Under concurrent dials the
  assignment may be wrong; this is acceptable given TURN is currently disabled by default.
  Document the limitation. A `Map<RTCPeerConnection, boolean>` keyed by object identity would
  fix this but requires a deeper hook into @libp2p/webrtc; defer.

- **`getStats()` failure**: Any error (stats API absent, async rejection) must be caught; push
  `isRelay: false` so the connection is counted as direct rather than dropped.

- **Node.js (cadre-cli)**: No `globalThis.RTCPeerConnection`. `TurnRelayTracker.install()` must
  check for its existence and return early. `_turnRelayedPeers` stays empty; all WebRTC transport
  entries (none, in practice) are classified by multiaddr as before.

- **`webrtc-direct`**: Cannot be TURN-relayed by design (ICE not used). If a peer mistakenly has
  `turnRelayed: true` for a `webrtc-direct` multiaddr, `classifyConnectionPath` returns
  `direct/webrtc-direct` (the `transport === 'webrtc'` guard protects it). No action needed.

- **Connection cleanup race**: `connection:close` removes the peer from `_turnRelayedPeers`. If
  a new connection to the same peer opens immediately after, it gets a fresh detection cycle
  rather than inheriting a stale flag.

- **Prometheus**: `cadre_connections_by_transport{transport="webrtc-turn"}` will appear in
  `/metrics` output once TURN is enabled and relayed sessions exist. The health endpoint emits
  one series per active transport in `byTransport`; the new entry is automatic.

- **Parity test**: `connection-path-parity.spec.ts` imports the cadre-core `CLASSIFIER_TABLE`.
  The parity spec must be updated to cover a `webrtc-turn` hint test case (or the parity spec
  imports the classifier table from cadre-core and the table gains a new row).

- **`stuckOnRelay` with TURN**: A connection classified `webrtc-turn` has `kind === 'relayed'`
  and participates in the `directPeerSet` exclusion. A long-lived TURN session with no direct
  sibling correctly becomes `stuckOnRelay: true`. This is intentional: it signals that the ICE
  upgrade to a direct path never materialised.

## TODO

- Add `'webrtc-turn'` to `ConnectionTransport` union in both `connection-path.ts` copies
- Add `turnRelayed?: boolean` to `ConnectionLike` in both copies
- Add the `transport === 'webrtc' && conn.turnRelayed` guard to `classifyConnectionPath` in both copies
- Switch `summarizeConnectionPaths` in both copies to call `classifyConnectionPath(conn)` rather than `classifyTransport(remoteAddr)`
- Add `'webrtc-turn'` to `ALL_TRANSPORTS` in both copies
- Create `packages/cadre-core/src/diagnostics/webrtc-turn-tracker.ts` with `TurnRelayTracker`
- Wire `TurnRelayTracker` into `CadreNode`: install on start, `connection:open`/`connection:close` listeners, annotate in `getConnectionPaths()`
- Add `dispose()` call to `CadreNode` teardown
- Update `CLASSIFIER_TABLE` in `connection-path.spec.ts` with a `webrtc-turn` row (synthetic conn with `turnRelayed: true` and `/webrtc` addr → `relayed/webrtc-turn`)
- Add tests for: TURN detection promotes webrtc→webrtc-turn; stuckOnRelay fires for aged webrtc-turn; classifyTransport unchanged; Node.js (no RTCPeerConnection) remains inert
- Update `connection-path-parity.spec.ts` to include the new transport in its coverage
- Run `yarn tsc --noEmit` and `yarn test` in cadre-core; run `yarn svelte-check` in reference-app-web
