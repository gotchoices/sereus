description: Connection-path observability — classify each open libp2p connection relayed vs direct, tag transport, surface counts + stuck-on-relay across cadre-core/CLI/RN/web. Observation only. Implemented + all build/type/test gates green; e2e specs authored but not runnable under tess. Needs adversarial review.
files: packages/cadre-core/src/diagnostics/connection-path.ts (new), packages/cadre-core/src/index.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/connection-path.spec.ts (new), packages/cadre-cli/src/server/health.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/src/lib/connection-path.ts (new), packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/src/Diagnostics.svelte, packages/reference-app-web/e2e/solo/connection-path-parity.spec.ts (new), packages/reference-app-web/e2e/distributed/connection-path.spec.ts (new)
----

## What this is

Measurement baseline for the relay-reduction effort. Makes "is this connection relayed or direct, and on what transport?" a readable signal in every runtime (cadre-core/CLI/RN/web), plus relayed-vs-direct + per-transport counts and a **stuck-on-relay** condition (relayed connection past a settle window with no direct sibling to the same peer — the common silent WebRTC-negotiation-failed case). **No behavioral change** — pure read-only observation over `node.getConnections()`. Downstream WebRTC/DCUtR/AutoNAT tickets consume this signal to prove a before/after.

## What landed

### cadre-core (canonical implementation)
- **`src/diagnostics/connection-path.ts` (new)** — the heart of the feature, a pure function over connections + settle window + `Date.now()`:
  - Types: `ConnectionPathKind`, `ConnectionTransport`, `ConnectionPath`, `ConnectionPathSummary`, plus a minimal `ConnectionLike` structural shape (the stock libp2p `Connection` satisfies it; tests build synthetic objects against it).
  - `classifyTransport(remoteAddr: string)` — the ordered classification table (first match wins: `/p2p-circuit`→relayed/circuit-relay, `/webrtc-direct`, `/webrtc`, `/ws|/wss`, `/tcp`, else direct/unknown). Never throws.
  - `classifyConnectionPath(conn)` — delegates to `classifyTransport` over `conn.remoteAddr`.
  - `summarizeConnectionPaths(conns, settleWindowMs = 10_000)` — builds the full summary; computes `stuckOnRelay` per connection against the set of peers that have ≥1 direct connection; defensive best-effort `bytesOverRelay` (reads a `conn.metrics` shape in try/catch, `null` when absent — stock libp2p exposes no counter).
  - `emptyConnectionPathSummary()` / `DEFAULT_SETTLE_WINDOW_MS` exports.
- **`src/index.ts`** — exports the module + all types.
- **`src/cadre-node.ts`** — `getConnectionPaths(settleWindowMs?)` near `isRunning`; empty summary when `controlNode` is null.

### CLI (`cadre-cli/src/server/health.ts`)
- Replaced the hardcoded `cadre_peers_connected: 0` placeholder. New Prometheus gauges from `node.getConnectionPaths()`: `cadre_connections_total`, `_relayed`, `_direct`, `_stuck_on_relay`, and `cadre_connections_by_transport{transport="..."}` (one labelled series per **non-zero** transport). `cadre_peers_connected` kept = `total` for scrape-config back-compat.
- Folded a counts-only `connectionPaths` (`Omit<ConnectionPathSummary,'paths'>`) into `HealthStatus.node` — the full `paths[]` is dropped to keep `/status` cheap.

### RN (`reference-app-rn/src/cadre-phone.ts`)
- `getConnectionPaths(settleWindowMs?)` thin re-export delegating to `node.getConnectionPaths(...)`; throws if not started (matches sibling helpers).

### Web (`reference-app-web/`)
- **`src/lib/connection-path.ts` (new)** — deliberate, documented duplicate of the cadre-core module (web does NOT depend on `@serfab/cadre-core`; header comment states this and points at the source of truth). Signatures identical to cadre-core.
- **`src/lib/diagnostics.svelte.ts`** — `ConnectivityInfo` gains per-connection `kind`/`transport`/`stuckOnRelay` and a `paths: ConnectionPathSummary`; `collectConnectivity()` classifies in one pass and zips `paths.paths[i]` onto the table rows.
- **`src/Diagnostics.svelte`** — Connectivity card now shows a path-summary badge row (relayed/direct/stuck + per-transport), a per-connection path badge column, and a visible `data-testid="diag-stuck-warning"` row when `stuckOnRelay > 0`.
- **`src/lib/optimystic.ts`** — `__optimystic` debug hook gains `getConnectionPaths(settleWindowMs?)` for Playwright assertions without DOM scraping.

### Tests
- **`cadre-core/test/connection-path.spec.ts` (new)** — 19 tests: classifier table (incl. empty/garbage → direct/unknown, never throws); summary + stuck-on-relay (aged relayed no-sibling → stuck; same peer with direct webrtc → not stuck; younger-than-window → not stuck; no-open-timestamp → not stuck); byTransport/relayed/direct/total invariants; `bytesOverRelay` null when no counter, summed best-effort when a metrics shape is present (direct conns excluded). The classifier table is exported as `CLASSIFIER_TABLE` and mirrored in the web parity spec.
- **`reference-app-web/e2e/solo/connection-path-parity.spec.ts` (new)** — Node-side drift guard: same multiaddr table asserted against the web copy's `classifyTransport`. (Web ships no separate unit runner, so it lives under the Playwright runner but does not drive the browser.)
- **`reference-app-web/e2e/distributed/connection-path.spec.ts` (new)** — two-browser NAT-to-NAT pair connects via the Tier-2 relay, drives a cross-browser dial (A sends, B converges), then asserts `__optimystic.getConnectionPaths()` is well-formed (invariants: `relayed+direct==total`, byTransport sums to total, paths counts agree) and `relayed >= 1`. Inline `WEBRTC-TICKET FLIP POINT` comment marks where the consumer ticket adds the `direct`/`webrtc` + `stuckOnRelay===0` assertion.

## Validation performed (all green)

```
yarn workspace @serfab/cadre-core build                         # ok, emits dist/diagnostics/connection-path.*
yarn workspace @serfab/cadre-core test connection-path          # 19/19
yarn workspace @serfab/cadre-core test                          # 189/189 (15 files) — no regressions
yarn workspace @serfab/cadre-cli build                          # ok (type-checks against new CadreNode method)
yarn workspace @serfab/reference-app-web exec svelte-check ...  # 0 errors, 0 warnings (405 files)
yarn workspace @serfab/reference-app-web run typecheck          # ok (tsc --noEmit)
(cd packages/reference-app-rn && npx tsc --noEmit)              # ok (0 errors)
```

Note: the ticket's `yarn workspace reference-app-web check` command does not exist — the web package has no `check` script. svelte-check was run directly (covers `.ts` + `.svelte`) plus the `typecheck` script; both clean.

## Use cases for review / validation

1. **Classifier correctness** — the ordering matters: a hole-punched WebRTC conn has a *direct* `/webrtc` remoteAddr while the `/p2p-circuit` is a *separate* connection; verify `classifyTransport` orders `/p2p-circuit` first so a relayed conn is never mis-tagged, and `/webrtc-direct` before `/webrtc`.
2. **stuck-on-relay semantics** — confirm `directPeerSet` is keyed on `peerId` (a peer mid-upgrade with both a relayed circuit conn and a direct webrtc conn must NOT be flagged), and that the settle window + null-age guards behave.
3. **CLI surfaces** — scrape `/metrics` and read `/status`: new `cadre_connections_*` gauges present, `by_transport` only emits non-zero series, `cadre_peers_connected == total`, `/status.node.connectionPaths` has counts but no `paths[]`.
4. **Web /diag** — relayed/direct/stuck badges and the per-connection path column render; stuck-warning row appears only when `stuckOnRelay > 0`.

## Known gaps / honest flags for the reviewer

- **e2e specs were NOT executed.** The two new Playwright specs require `yarn build && yarn preview` + Chromium install + the Tier-2 reference-peer fixture, which is not agent-runnable under tess (heavy + needs the fixture). They are authored to the existing distributed/_helpers.ts patterns but are **unproven at runtime** — a reviewer with the fixture should run `yarn workspace @serfab/reference-app-web test:e2e --grep "connection-path"`. In particular the distributed guard *assumes* a cross-browser message-convergence reliably produces a `/p2p-circuit` connection on at least one tab; if the cluster routes the dial differently the `relayed >= 1` poll could be flaky — worth a real run before trusting it.
- **`bytesOverRelay` is always `null` today** by design — stock libp2p `Connection` has no byte counter. Real per-path accounting is cross-repo and tracked in `tickets/backlog/relay-bytes-metrics-libp2p.md`. The defensive reader is exercised by a unit test that injects a synthetic `metrics` shape, but the production path is untested against a real metrics component (none is wired).
- **Duplicate classifier drift.** cadre-core and the web copy are hand-kept in sync; the only guard is the two mirrored test tables. If a reviewer changes one classifier, both spec tables must move together. Consider whether the shared `@serfab/libp2p-diagnostics` micro-package (noted in both file headers) is worth pulling forward.
- **RN re-export is type-checked only** — no device/runtime run under tess (per ticket).
- **Web parity spec coupling** — it lives under `e2e/` (not type-checked by svelte-check, since the web tsconfig only includes `src/`). It will only be validated when the Playwright suite runs.
