----
description: Add connection-path observability — classify each open libp2p connection as relayed (`/p2p-circuit`) vs direct, tag its transport, surface counts + a stuck-on-relay condition through the web debug hook, the phone node, and CadreNode/CLI status. Observation only; no change to connection establishment. This is the measurement baseline for the relay-reduction effort.
prereq:
files: packages/cadre-core/src/diagnostics/connection-path.ts (new), packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-cli/src/server/health.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/src/lib/connection-path.ts (new), packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/optimystic.ts
----

## Goal

Make "is this connection relayed or direct, and on what transport?" a readable signal in every runtime, plus a count surface (relayed vs direct, per-transport) and a **stuck-on-relay** condition so the common silent failure ("WebRTC negotiation fails, connection quietly stays on the relay") becomes visible. No behavioral change — this is observation only. The WebRTC/DCUtR/AutoNAT tickets consume this signal to prove a before/after.

## Design

### Connection-path classifier (pure, the heart of the feature)

A connection's path is derivable from its `remoteAddr` multiaddr string alone — no I/O, no events. libp2p's `Connection` also carries `timeline.open` (ms epoch) and `direction`, which is all the stuck-on-relay logic needs. So the entire signal is a **pure function over `node.getConnections()` + a settle window + `Date.now()`** — no stateful observer required.

Types (defined in cadre-core, mirrored verbatim in the web copy):

```ts
type ConnectionPathKind = 'relayed' | 'direct';
type ConnectionTransport =
  | 'circuit-relay' | 'webrtc' | 'webrtc-direct' | 'websocket' | 'tcp' | 'unknown';

interface ConnectionPath {
  peerId: string;          // remotePeer.toString()
  remoteAddr: string;
  kind: ConnectionPathKind;
  transport: ConnectionTransport;
  direction: 'inbound' | 'outbound';
  openedAtMs: number | null;   // connection.timeline.open ?? null
  ageMs: number | null;        // now - openedAtMs
  stuckOnRelay: boolean;       // relayed && age > settleWindow && no direct conn to same peer
}

interface ConnectionPathSummary {
  total: number;
  relayed: number;
  direct: number;
  stuckOnRelay: number;
  byTransport: Record<ConnectionTransport, number>;
  bytesOverRelay: number | null;  // best-effort; null when libp2p exposes no counter (see below)
  paths: ConnectionPath[];
  settleWindowMs: number;
}
```

Classification, evaluated against the multiaddr string in this order (first match wins):

| multiaddr contains | kind | transport |
|---|---|---|
| `/p2p-circuit` | relayed | circuit-relay |
| `/webrtc-direct` | direct | webrtc-direct |
| `/webrtc` | direct | webrtc |
| `/ws` or `/wss` | direct | websocket |
| `/tcp` (and none of the above) | direct | tcp |
| _none_ | direct | unknown |

Note the ordering: a hole-punched WebRTC connection that used a relay only for signaling ends up with a **direct** `/webrtc` remoteAddr (the `/p2p-circuit` connection is a *separate* connection). So per-connection classification is correct — a peer mid-upgrade shows both a `relayed` circuit connection and a `direct` webrtc connection until the relay one is torn down. That overlap is exactly what `stuckOnRelay` keys off: relayed-and-old with no direct sibling to the same peer.

`stuckOnRelay` per connection: `kind === 'relayed' && ageMs != null && ageMs > settleWindowMs && !directPeerSet.has(peerId)`, where `directPeerSet` is the set of `peerId`s that have at least one `direct` connection. Default `settleWindowMs = 10_000`.

`bytesOverRelay` is **best-effort**. The stock libp2p `Connection` interface carries no byte counter, so unless a metrics implementation is wired into the node it stays `null`. The summary builder reads `connection.metrics`/transport metrics defensively (try/catch, `null` on absence) and never throws. Real per-path byte accounting requires enabling a libp2p metrics component in the optimystic node base — that is cross-repo and tracked separately (see `tickets/backlog/relay-bytes-metrics-libp2p.md`). Do **not** instrument the data path here.

### Where it lives

The web reference app does **not** depend on `@serfab/cadre-core` (it builds on `@optimystic/db-p2p` + `@libp2p/interface` only — confirmed in `packages/reference-app-web/package.json`). Pulling cadre-core into the browser bundle for a ~40-line pure function is the wrong trade. So:

- **cadre-core** owns the canonical implementation: `packages/cadre-core/src/diagnostics/connection-path.ts`, exported from `index.ts`. Consumed by `CadreNode`, the CLI health/metrics server, and the RN phone node.
- **reference-app-web** gets a **deliberate, documented duplicate**: `packages/reference-app-web/src/lib/connection-path.ts` — same types, same classification table, no cadre-core import. Add a header comment pointing at the cadre-core original as the source of truth and noting the duplication is intentional (bundle size + dependency direction). Both operate on the `@libp2p/interface` `Connection` type, so the logic is line-for-line identical.

Keep the function signatures identical across both copies so a future shared `@serfab/libp2p-diagnostics` micro-package (if one is ever warranted) is a drop-in.

### Wiring per runtime

**CadreNode** (`cadre-node.ts`): add
```ts
getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary
```
near `getMultiaddrs()`/`getControlNode()`. Returns an empty summary (all zeros, `paths: []`) when `controlNode` is null. Pure wrapper over `this.controlNode.getConnections()`.

**CLI health/metrics** (`cadre-cli/src/server/health.ts`): the `cadre_peers_connected` Prometheus gauge is currently a hardcoded `0` placeholder (line ~146). Replace it with real data and add path gauges, all sourced from `node.getConnectionPaths()`:
- `cadre_connections_total`
- `cadre_connections_relayed`
- `cadre_connections_direct`
- `cadre_connections_stuck_on_relay`
- `cadre_connections_by_transport{transport="..."}` (one labelled series per transport with a non-zero count)
- keep/repurpose `cadre_peers_connected` = `total` for back-compat with existing scrape configs.

Also fold a compact `connectionPaths` summary (counts only, omit the full `paths[]` array to keep the probe cheap) into the `/status` JSON `HealthStatus.node` block.

**Phone** (`reference-app-rn/src/cadre-phone.ts`): add a thin re-export
```ts
export function getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary
```
that delegates to `node.getConnectionPaths(...)` (throws if not started, matching the other helpers). This is what the RN debug screen reads.

**Web** (`reference-app-web/src/lib/diagnostics.svelte.ts` + `optimystic.ts`):
- Extend `ConnectivityInfo`: add `kind`, `transport`, and `stuckOnRelay` to each entry in `connections[]`, and add a `paths: ConnectionPathSummary` (or inline the counts: `relayedCount`, `directCount`, `stuckOnRelayCount`, `byTransport`). Compute via the new `connection-path.ts` copy inside `collectConnectivity()`, which already enumerates `node.getConnections()`.
- The existing `/diag` Svelte page should render the new counts (relayed vs direct badge per connection, a summary line, and a visible warning row when `stuckOnRelayCount > 0`). Find the `/diag` route component that consumes `diagnosticsState()` and add the rows — keep it consistent with the existing connection table styling.
- Extend the `__optimystic` debug hook in `optimystic.ts` (`exposeDebugHook`) with `getConnectionPaths: () => ConnectionPathSummary` so Playwright specs can assert on classification without scraping the DOM.

## Tests

**cadre-core unit** — `packages/cadre-core/src/diagnostics/__tests__/connection-path.spec.ts` (match the package's existing test runner/layout under `packages/cadre-core/test/`):
- Table-driven classifier: feed representative multiaddrs and assert `(kind, transport)`:
  - `/ip4/1.2.3.4/tcp/443/wss/p2p/Qm.../p2p-circuit/p2p/Qm...` → `relayed`, `circuit-relay`
  - `/ip4/1.2.3.4/udp/9/webrtc-direct/certhash/.../p2p/Qm...` → `direct`, `webrtc-direct`
  - `/ip4/1.2.3.4/.../webrtc/p2p/Qm...` (no `/p2p-circuit`) → `direct`, `webrtc`
  - `/ip4/127.0.0.1/tcp/4001/ws/p2p/Qm...` → `direct`, `websocket`
  - `/ip4/127.0.0.1/tcp/4001/p2p/Qm...` → `direct`, `tcp`
  - empty/garbage addr → `direct`, `unknown` (and never throws)
- Summary + stuck-on-relay: build synthetic `Connection`-shaped objects (peerId, remoteAddr, direction, `timeline.open`) and assert:
  - one relayed conn aged past `settleWindowMs` with **no** direct sibling → `stuckOnRelay: true`, `summary.stuckOnRelay === 1`.
  - same peer also has a `direct` webrtc conn → `stuckOnRelay: false` for the relayed one (upgrade succeeded), `summary.stuckOnRelay === 0`.
  - relayed conn younger than `settleWindowMs` → not stuck (still settling).
  - `byTransport` counts and `relayed`/`direct`/`total` add up.
  - `bytesOverRelay` is `null` when connections expose no counter; builder does not throw.

**web parity** — add a small vitest/unit (if the web package runs unit tests; otherwise a Playwright-evaluated assertion) that the web `connection-path.ts` classifier returns the same `(kind, transport)` for the same multiaddr table, guarding against drift between the two copies.

**Regression guard (structured for the WebRTC ticket to flip)** — in the existing distributed e2e (`packages/reference-app-web/e2e/distributed/`, see `_helpers.ts`): after a two-browser NAT-to-NAT pair connects through the Tier-2 relay, call `window.__optimystic.getConnectionPaths()` and assert the summary is well-formed and that the known circuit connection is classified `relayed`. **Today** (relay-only world) `relayed >= 1` is expected. Document inline that the WebRTC transport ticket will add the complementary assertion — after a settle window the pair is `direct`/`webrtc` and `stuckOnRelay === 0`. Do not assert direct-upgrade here; that capability doesn't exist yet and the assertion belongs to the consumer ticket.

## Build / validate

- `yarn workspace @serfab/cadre-core build` and the cadre-core test command (stream with `2>&1 | tee`).
- `yarn workspace @serfab/cadre-cli build` (health.ts type-checks against the new CadreNode method).
- `yarn workspace reference-app-web check` (svelte-check) for the diagnostics + hook changes.
- RN: type-check only (no device run under tess).
- Run the cadre-core unit spec in foreground with tee'd output.

## TODO

- [ ] Add `packages/cadre-core/src/diagnostics/connection-path.ts`: `ConnectionPathKind`/`ConnectionTransport`/`ConnectionPath`/`ConnectionPathSummary` types, `classifyConnectionPath(conn)` pure classifier, and `summarizeConnectionPaths(conns, settleWindowMs)` builder. Defensive `bytesOverRelay` (try/catch → `null`).
- [ ] Export the new module + types from `packages/cadre-core/src/index.ts`.
- [ ] Add `CadreNode.getConnectionPaths(settleWindowMs?)` in `cadre-node.ts` (empty summary when not started).
- [ ] Wire CLI `health.ts`: replace the `cadre_peers_connected` placeholder, add `cadre_connections_*` gauges + `by_transport` labelled series, fold a counts-only summary into `/status` JSON.
- [ ] Add `getConnectionPaths()` re-export to `reference-app-rn/src/cadre-phone.ts`.
- [ ] Add web duplicate `reference-app-web/src/lib/connection-path.ts` (documented, no cadre-core dep).
- [ ] Extend `ConnectivityInfo` + `collectConnectivity()` in `diagnostics.svelte.ts` with per-connection `kind`/`transport`/`stuckOnRelay` and summary counts; render them on the `/diag` page (incl. a visible stuck-on-relay warning row).
- [ ] Extend `exposeDebugHook` in `optimystic.ts` with `getConnectionPaths()`.
- [ ] cadre-core unit spec (classifier table + stuck-on-relay summary cases).
- [ ] Web classifier parity check.
- [ ] e2e regression-guard assertion (`relayed >= 1` today; comment marks the WebRTC-ticket flip point).
- [ ] Build + type-check all four touched packages; stream test output with tee.
