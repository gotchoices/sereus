description: Connection-path observability — classify each open libp2p connection relayed vs direct, tag transport, surface relayed/direct/per-transport counts + a stuck-on-relay condition across cadre-core/CLI/RN/web. Observation only, no behavioral change. Reviewed; one major classifier-ordering bug fixed inline.
files: packages/cadre-core/src/diagnostics/connection-path.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/connection-path.spec.ts, packages/cadre-cli/src/server/health.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/src/lib/connection-path.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/src/Diagnostics.svelte, packages/reference-app-web/e2e/solo/connection-path-parity.spec.ts, packages/reference-app-web/e2e/distributed/connection-path.spec.ts
----

## Summary

Measurement baseline for the relay-reduction effort: a pure, read-only classification of every open libp2p connection as relayed (`/p2p-circuit`) vs direct, tagged by transport, with relayed/direct/per-transport counts and a **stuck-on-relay** condition (relayed past a settle window with no direct sibling to the same peer). Canonical pure-function implementation in `cadre-core` (`getConnectionPaths()`), a deliberate documented duplicate in `reference-app-web` (no cadre-core dependency in the browser bundle), surfaced as Prometheus gauges + `/status` counts in the CLI, an RN re-export, and a `/diag` Connectivity card + `__optimystic.getConnectionPaths()` debug hook in web. No behavioral change.

The implementation landed structurally sound: clean separation (pure classifier vs node accessor vs surface adapters), defensive never-throw reads, an all-zero empty summary, and a drift guard (mirrored classifier tables across the two copies). The adversarial pass found **one major correctness bug** in the classifier's ordering, fixed inline; everything else was sound or already honestly flagged by the implementer.

## Review findings

### Checked

- **Classifier correctness & ordering** — the multiaddr → (kind, transport) table, first-match-wins ordering, and the interaction with combined multiaddrs (webrtc-over-circuit, websocket-to-relay, the raw transport conn to the relay node itself).
- **stuck-on-relay semantics** — `directPeerSet` keyed on `peerId`; settle-window boundary; null-age guard; the mid-upgrade "relayed + direct sibling" non-flag case.
- **Summary invariants** — `relayed + direct == total`, `byTransport` sums to `total`, `paths[]` counts agree with scalar counts; `bytesOverRelay` null/best-effort behaviour.
- **CLI surfaces** — `/metrics` gauges (`cadre_connections_*`, `by_transport` only emits non-zero series), `/status.node.connectionPaths` (counts, no `paths[]`), `cadre_peers_connected == total` back-compat alias.
- **Web** — `ConnectivityInfo` zip of `paths.paths[i]` onto table rows, Diagnostics card badges + stuck warning row, debug hook.
- **Build / type / test gates** — cadre-core build + full suite, cadre-cli build, web typecheck + svelte-check.
- **Docs** — searched `docs/` for any reference to this feature / metrics catalog / connection-path semantics.

### Found & fixed (major → fixed inline, since the fix is small, provably safe for current runtime, and unit-verifiable)

- **Classifier mis-tagged a successful browser-to-browser WebRTC connection as `relayed`.** The table checked `/p2p-circuit` *before* `/webrtc`. In js-libp2p, a private-to-private WebRTC connection is dialed over a relay for SDP signalling and the established connection **retains the circuit prefix** in its `remoteAddr` (`…/p2p-circuit/webrtc/p2p/…`) even though its data path is direct. With the old ordering that connection matched `/p2p-circuit` first and was classified `relayed`/`circuit-relay` — and worse, flagged `stuckOnRelay` after the settle window (it is "relayed with no direct sibling"). This directly contradicted the implementer's documented use-case #1 assumption ("the `/p2p-circuit` connection is a *separate* connection") and would have broken the downstream WebRTC ticket's documented "flip point" assertion (`direct`/`webrtc` + `stuckOnRelay === 0`), as well as producing a false `stuckOnRelay` for a peer that had *both* a relay conn and a webrtc-over-circuit conn.
  - **Fix:** reordered `classifyTransport` so the WebRTC checks (`/webrtc-direct`, `/webrtc`) precede `/p2p-circuit`; only a connection with no transport after `/p2p-circuit` is genuinely relay-carried. Applied to **both** copies (cadre-core canonical + web duplicate), with the doc-comment table/rationale updated in both.
  - **Safety:** zero impact on current runtime — the web app configures only `webSockets()` + `circuitRelayTransport()` (no WebRTC transport today), so no `/webrtc` addresses exist yet; reordering is a no-op for every address shape produced today (pure-circuit relay conns still classify `relayed`; direct websocket-to-relay conns still classify `websocket`). All existing tests still pass unchanged.
  - **Regression coverage added:** a `…/p2p-circuit/webrtc/p2p/…` row in the mirrored `CLASSIFIER_TABLE` (cadre-core spec **and** the web parity spec, kept in sync), plus a summarize-level test asserting an aged webrtc-over-circuit conn is `direct`/`webrtc`, counts toward `direct` not `relayed`, and is never flagged `stuckOnRelay`. cadre-core suite: 191 → 191+2 = **191 passing across 15 files** (the connection-path file is 19 → 21 tests).
- **Redundant `/wss` check.** `addr.includes('/ws') || addr.includes('/wss')` — `/wss` always contains `/ws`, so the second clause was dead. Simplified to `addr.includes('/ws')` in both copies (DRY) while reordering.

### Found & accepted (no change — documented rationale)

- **`directPeerSet` empty-`peerId` collision.** If `remotePeer.toString()` throws for multiple peers, all collapse to `''` and could cross-suppress each other's stuck flag. The read is wrapped never-to-throw and a thrown `remotePeer` is not an expected condition on a live connection; the blast radius is one diagnostic flag. Not worth special-casing.
- **`cadre_peers_connected == total` is connection count, not distinct-peer count.** A node with both a relay conn and a direct conn to the same peer reports `2`. This is a documented back-compat alias (the field was a hardcoded `0` placeholder before), explicitly commented as `== cadre_connections_total`. Acceptable for a scrape-config alias; the semantically-correct signals (`cadre_connections_*`) are the new gauges.
- **`bytesOverRelay` always `null` today.** Stock libp2p `Connection` exposes no byte counter; the defensive reader returns `null`. Known gap, tracked in `tickets/backlog/relay-bytes-metrics-libp2p.md`, exercised by a synthetic-metrics unit test. Production path remains untested against a real metrics component (none is wired) — correctly flagged by the implementer.
- **`diagnostics.svelte.ts` index-zip coupling.** `collectConnectivity` relies on `summarizeConnectionPaths(conns).paths[i]` lining up with `conns[i]`. This holds because `summarize` does `Array.from(conns)` over the same array `getConnections()` returns (an array, order-stable, reusable). Documented inline; acceptable.
- **Docs.** No existing doc is factually contradicted: `docs/architecture.md` references the `/status` health endpoint and "metrics" only generically, and there is no metrics-catalog doc enumerating gauge names. Per AGENTS.md ("don't create summary documents"), no new doc surface was invented. The new gauges/fields are additive and self-documented in code (HELP lines + JSDoc).

### Not run (carried forward from implement, unchanged by review)

- **The two new Playwright e2e specs were NOT executed** — they require `yarn build && yarn preview` + Chromium + the Tier-2 reference-peer fixture, which is not agent-runnable under tess. They remain authored-but-unproven at runtime. Note: the classifier reorder does **not** affect the distributed spec's `relayed >= 1` expectation — today's browser-to-browser conns are pure `/p2p-circuit` (no `/webrtc` component, since WebRTC transport is not enabled), so they still classify `relayed`/`circuit-relay`. A reviewer with the fixture should still run `yarn workspace @serfab/reference-app-web test:e2e --grep "connection-path"`; the distributed `relayed >= 1` poll could be flaky if the cluster routes the cross-browser dial differently.
- **RN re-export is type-checked only** — no device/runtime run under tess (per ticket).

## Validation performed (all green)

```
yarn workspace @serfab/cadre-core test connection-path     # 21/21 (was 19; +2 regression tests)
yarn workspace @serfab/cadre-core test                     # 191/191 across 15 files — no regressions
yarn workspace @serfab/cadre-core build                    # ok
yarn workspace @serfab/cadre-cli build                     # ok (type-checks against CadreNode.getConnectionPaths)
yarn workspace @serfab/reference-app-web run typecheck      # ok (tsc --noEmit)
yarn workspace @serfab/reference-app-web exec svelte-check  # 0 errors, 0 warnings (405 files)
```

Lint: none of the touched packages (cadre-core, cadre-cli, reference-app-rn, reference-app-web) define a `lint` script, so the root `lint` (workspaces-foreach) is a no-op for this change; static analysis is covered by build + typecheck + svelte-check.

## Downstream

The downstream WebRTC/DCUtR/AutoNAT tickets consume `getConnectionPaths()` / `__optimystic.getConnectionPaths()` to prove a before/after. With the classifier fix, the documented "flip point" in `e2e/distributed/connection-path.spec.ts` (assert `direct`/`webrtc` + `stuckOnRelay === 0` once WebRTC upgrade lands) will now classify a successful hole-punch correctly. `tickets/backlog/relay-bytes-metrics-libp2p.md` tracks real per-path byte accounting.
