description: The browser reference app's Diagnostics page can never show a WebRTC connection as relayed through a TURN server, because it counts connections with its own copy of the classification code instead of asking the node, which already knows. Make the page ask the node, and delete the copy.
files: packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/connection-path.ts, packages/reference-app-web/e2e/solo/connection-path-parity.spec.ts, packages/reference-app-web/e2e/solo/schema-signature-gate.spec.ts, packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-web/README.md, packages/cadre-core/src/diagnostics/connection-path.ts, packages/cadre-core/test/connection-path.spec.ts, ops/docs/ice-servers.md
difficulty: easy
----

## What is already in place

`CadreNode` (`packages/cadre-core/src/cadre-node.ts`) does all the TURN detection itself, and the web app runs a `CadreNode` (`packages/reference-app-web/src/lib/cadre-web.ts` → `startCadre`):

- `start()` installs a `TurnRelayTracker` (`packages/cadre-core/src/diagnostics/webrtc-turn-tracker.ts`), which wraps `globalThis.RTCPeerConnection` before any libp2p node exists and records, for each WebRTC session that connects, whether ICE picked a TURN relay candidate. `cleanup()` restores the original constructor.
- On the control node's `connection:open` for a `/webrtc` address (not `/webrtc-direct`), `handleTurnConnectionOpen` reads the tracker's latest verdict and, if relayed, adds the peer id to `turnRelayedPeers`; `connection:close` removes it.
- `CadreNode.getConnectionPaths(settleWindowMs?)` copies each control connection, sets `turnRelayed` from that set, and returns `summarizeConnectionPaths(...)` — a `ConnectionPathSummary` in which a TURN-relayed session is `kind: 'relayed'`, `transport: 'webrtc-turn'`.

So nothing needs installing or wiring in the web app. The only gap is the last step.

## The gap

`collectConnectivity` in `packages/reference-app-web/src/lib/diagnostics.svelte.ts` calls the web app's own `summarizeConnectionPaths` (from `./connection-path.js`, a hand-maintained copy of cadre-core's file) over raw `node.getConnections()`. Raw connections never carry `turnRelayed`, so the summary can never contain `webrtc-turn`, and a TURN-relayed session is counted `direct`/`webrtc`.

## Design

**`collectConnectivity` takes the summary from the node.** Change it to work from the `CadreNode` (`getCadreNode()`), not the bare `Libp2p` control node:

```ts
function collectConnectivity(cadre: CadreNode | null): ConnectivityInfo {
	const control = cadre?.getControlNode() ?? null;
	if (!cadre || !control) return { status: null, listenAddrs: [], connections: [], paths: emptyConnectionPathSummary() };
	...
	const conns = control.getConnections();
	const paths = cadre.getConnectionPaths();   // no await between these two lines
	...
}
```

The per-connection table rows still need each connection's stream protocols, which `ConnectionPath` does not carry, so the rows keep being built by pairing `conns[i]` with `paths.paths[i]`. That pairing is valid because `getConnectionPaths()` reads the same `controlNode.getConnections()` and both calls happen synchronously with no `await` between them. Two things follow:

- Both must come from the **same** `CadreNode` fetched inside `collectConnectivity` (or passed in from one `getCadreNode()` read made immediately before the call). `refreshDiagnostics` today reads `getControlNode()` once at the top and then awaits `collectCadre()` and `collectAuthorization()`; a stop/restart during those awaits would otherwise pair a stale node's connections with the new node's summary.
- Leave a one-line comment at the pairing saying it relies on the two reads being synchronous and from the same node. Keep the existing `path?.kind ?? 'direct'` fallbacks.

The other collectors (`collectIdentity`, `collectTransports`, `collectFret`, `attachNodeListenersIfNeeded`) keep taking the `Libp2p` control node; do not widen this change to them.

**Types come from cadre-core.** Import `emptyConnectionPathSummary`, `ConnectionPathSummary`, `ConnectionPathKind`, `ConnectionTransport` (and the `CadreNode` type) from `@serfab/cadre-core` — all four are already exported from `packages/cadre-core/src/index.ts`. `summarizeConnectionPaths` is no longer imported by the web app at all. `TurnRelayTracker` stays unexported: nothing outside `CadreNode` needs it.

**Delete the duplicate and its drift guard.** Remove `packages/reference-app-web/src/lib/connection-path.ts` and `packages/reference-app-web/e2e/solo/connection-path-parity.spec.ts`. The spec exists only to keep the two copies identical; with one copy it has nothing to guard, and the classifier table it asserts is already asserted by `packages/cadre-core/test/connection-path.spec.ts`.

**Tradeoff considered.** Building the table rows purely from `paths.paths` (which already has peer id, address, direction, kind, transport, stuck flag) would remove the index pairing, but the rows also show stream protocols, which only the live `Connection` has. Adding protocols to cadre-core's `ConnectionPath` was rejected: it would put a display-only field into a type that the CLI health endpoint and two phone apps also consume.

## Edge cases & interactions

- **Node not started / stopped mid-refresh.** `getCadreNode()` is null before `startCadre` and after `stopCadre`; `getControlNode()` is null before `start()` completes. Both must yield the empty `ConnectivityInfo`. Verified by inspection and by the type (`CadreNode | null`).
- **Restart between awaits in `refreshDiagnostics`.** Covered by reading the `CadreNode` once and deriving connections and summary from it back to back (above). Verified by inspection.
- **Row/summary length mismatch.** Cannot happen while the two reads are synchronous on one node; the existing `?? 'direct'` / `?? 'unknown'` / `?? false` fallbacks stay as the guard. Verified by inspection.
- **Svelte reactivity.** `snapshot.connectivity.paths` is assigned into `$state`; the summary from cadre-core is a fresh plain object per call, same as today. `Diagnostics.svelte` iterates `Object.entries(paths.byTransport)` and needs no change — `webrtc-turn` is already a key. Verified by `yarn workspace @serfab/reference-app-web check:svelte`.
- **No other importer of the deleted file.** Only `diagnostics.svelte.ts` and the parity spec import `./connection-path.js`; `Diagnostics.svelte` does not. Verified by `typecheck` + `typecheck:e2e` (both run inside `build`).
- **Browser bundle.** The web app already imports `CadreNode` from the `@serfab/cadre-core` root, so importing the summary helpers from the same entry adds nothing. Verified by the solo e2e's transport canary still passing.
- **Strand nodes.** `getConnectionPaths()` covers the control node only, as the Diagnostics page does today. Strand-node connections are out of scope.
- **Shared detection limits.** The tracker matches an ICE verdict to a `connection:open` by timing (1 second window) and can miss a connection that opens before listeners attach. These are cadre-core's documented limits and are inherited unchanged. One further limit specific to a browser tab, where strand nodes share the wrapped `RTCPeerConnection` with the control node, is filed separately as `debt-turn-relay-verdict-can-come-from-another-node` (backlog); do not address it here.

## Testing

No new test. This is wiring: the classifier and summary are covered by `packages/cadre-core/test/connection-path.spec.ts`, the tracker by `packages/cadre-core/test/webrtc-turn-tracker.spec.ts`. A true end-to-end check (two browsers forced through a TURN server) needs a running coturn and is not agent-runnable; say so in the review handoff rather than approximating it with a mock.

Validation to run: `yarn lint`, `yarn workspace @serfab/reference-app-web build` (typecheck + e2e typecheck + vite build), `yarn workspace @serfab/reference-app-web check:svelte`, `yarn workspace @serfab/reference-app-web test`, and the solo Playwright tier (`yarn workspace @serfab/reference-app-web test:e2e`, which includes `e2e/solo/diagnostics.spec.ts`). Do not build anything under `../optimystic`, `../quereus` or `../Fret`; if the stale-build guard reports a sibling `dist` stale, stop and record it.

## TODO

- In `diagnostics.svelte.ts`: switch `collectConnectivity` to the `CadreNode`, take the summary from `getConnectionPaths()`, update the call in `refreshDiagnostics`, and move the four imports to `@serfab/cadre-core`.
- Delete `packages/reference-app-web/src/lib/connection-path.ts` and `packages/reference-app-web/e2e/solo/connection-path-parity.spec.ts`.
- Update the text that describes the duplicate, stating only the current arrangement:
  - `packages/cadre-core/src/diagnostics/connection-path.ts` header (lines 6–11): drop the "deliberate duplicate" paragraph; and the `turnRelayed` doc if it needs no change, leave it.
  - `packages/cadre-core/test/connection-path.spec.ts` comment near line 15 that says the table is mirrored by the web parity spec.
  - `packages/reference-app-web/e2e/solo/schema-signature-gate.spec.ts` line 9: it cites the parity spec as the other pure-Node spec; reword so it stands alone.
  - `packages/reference-app-web/src/lib/ice-config.ts` header: line 6 ("same constraint as `connection-path.ts`") and the last TURN note (lines 40–42, which says a TURN-relayed path is misclassified and points at this ticket) — replace the note with one sentence saying a TURN-relayed session is reported `webrtc-turn` by `CadreNode.getConnectionPaths()`. Check whether `packages/reference-app-rn/src/ice-config.ts` carries the same note and align it.
  - `packages/reference-app-web/README.md`: remove the `connection-path.ts` line from the file tree (line 292) and "the connection-path classifier parity table" from the Tier 1 list (line 316).
  - `ops/docs/ice-servers.md` lines 252–255: the `web-turn-relayed-path-detection` forward pointer describes the gap as open; replace it with the current behaviour (TURN-relayed WebRTC sessions are counted relayed, transport `webrtc-turn`, in both the CLI health output and the web Diagnostics page).
- Run the validation listed above and report results, including the TURN end-to-end check that was not run.
