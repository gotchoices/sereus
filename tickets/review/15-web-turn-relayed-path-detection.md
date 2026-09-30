description: The browser reference app's Diagnostics page now asks the running node how each connection is routed, so a WebRTC connection relayed through a TURN server can show as relayed. The page's own copy of the classification code, and the test that kept the two copies identical, are deleted.
files: packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/e2e/solo/schema-signature-gate.spec.ts, packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-web/README.md, packages/cadre-core/src/diagnostics/connection-path.ts, packages/cadre-core/test/connection-path.spec.ts, packages/cadre-core/src/cadre-node.ts, ops/docs/ice-servers.md
difficulty: easy
----

## What changed

`collectConnectivity` in `packages/reference-app-web/src/lib/diagnostics.svelte.ts` now takes the `CadreNode` (or null) instead of the bare libp2p control node. It reads `cadre.getControlNode()` for status, listen addresses and the connection list, and takes the path summary from `cadre.getConnectionPaths()`, which is the only place the TURN-relay flag is applied. `refreshDiagnostics` passes `getCadreNode()` read at the call, after the two awaited collectors, so connections and summary always come from one node.

The table rows are still built by pairing `conns[i]` with `paths.paths[i]`, because rows show stream protocols, which the summary does not carry. A comment at that site says the pairing relies on both reads being synchronous and from the same node. The `?? 'direct'` / `?? 'unknown'` / `?? false` fallbacks are unchanged.

The four summary imports (`emptyConnectionPathSummary`, `ConnectionPathSummary`, `ConnectionPathKind`, `ConnectionTransport`) plus the `CadreNode` type now come from `@serfab/cadre-core`. The other collectors still take the libp2p control node.

Deleted: `packages/reference-app-web/src/lib/connection-path.ts` and `packages/reference-app-web/e2e/solo/connection-path-parity.spec.ts`.

Text updated to describe only the current arrangement: the header of `packages/cadre-core/src/diagnostics/connection-path.ts`, the classifier-table comment in `packages/cadre-core/test/connection-path.spec.ts`, the header of `e2e/solo/schema-signature-gate.spec.ts`, two places in the header of `src/lib/ice-config.ts`, the file tree and Tier 1 list in the web `README.md`, and the forward pointer in `ops/docs/ice-servers.md`.

## Things the reviewer should look at

- **Not in the ticket:** `CLASSIFIER_TABLE` in `packages/cadre-core/test/connection-path.spec.ts` lost its `export`. Nothing imported it (the deleted parity spec kept its own table), and the comment explaining the export was the one the ticket said to remove.
- **`packages/reference-app-rn/src/ice-config.ts`** was checked and carries no TURN-misclassification note, so it was left alone.
- **`ops/docs/ice-servers.md` heading.** The section is still titled "Forward pointers (TURN gaps — do not lose these when TURN is enabled)", and both of its items now describe built features. The heading was left as is to avoid breaking any link to it; renaming or folding the section is a judgment call for review.
- **Order of reads in `refreshDiagnostics`.** `getControlNode()` is still read at the top for the other collectors, while connectivity reads `getCadreNode()` later. After a restart during the awaits, identity/transports could be from the old node and connectivity from the new one for a single 2-second tick. Connectivity itself is internally consistent, which is what the ticket asked for.

## Validation run

- `yarn lint` — passed.
- `yarn workspace @serfab/reference-app-web build` (typecheck, e2e typecheck, vite build) — passed.
- `yarn workspace @serfab/reference-app-web check:svelte` — 0 errors, 0 warnings.
- `yarn workspace @serfab/reference-app-web test` — 3 files, 66 tests passed. The first run stopped on the stale-build guard for `@serfab/cadre-core` (this ticket's comment edit made its source newer than its `dist`); `yarn workspace @serfab/cadre-core build` cleared it. No sibling repository was reported stale or built.
- `yarn workspace @serfab/cadre-core vitest run test/connection-path.spec.ts` — 37 passed.
- `yarn workspace @serfab/reference-app-web test:e2e` — 19 passed, including `e2e/solo/diagnostics.spec.ts` (the transport canary) and the two formation-convergence tests.

## Not tested

- **A real TURN-relayed session in the browser.** No test, automated or manual, showed the Diagnostics page displaying `webrtc-turn`. That needs two browsers forced through a running coturn server (ICE transport policy `relay`) and is not agent-runnable. To check by hand: point `VITE_ICE_CONFIG_URL` at a manifest with a TURN entry, force relay-only ICE, connect two tabs, and confirm the Diagnostics path summary counts the session as relayed with transport `webrtc-turn`.
- No test was added. The change is wiring; the classifier and summary are covered by `packages/cadre-core/test/connection-path.spec.ts` and the tracker by `packages/cadre-core/test/webrtc-turn-tracker.spec.ts`.

## Known limits, inherited unchanged

- The tracker matches an ICE verdict to a `connection:open` within a 1-second window and can miss a connection that opens before its listeners attach.
- In a browser tab, strand nodes share the wrapped `RTCPeerConnection` with the control node, so a verdict can come from another node. Filed separately in backlog as `debt-turn-relay-verdict-can-come-from-another-node`.
- `getConnectionPaths()` covers the control node only; strand-node connections are not shown, as before.
