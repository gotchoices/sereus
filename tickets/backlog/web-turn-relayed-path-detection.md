----
description: The browser reference app can never show a WebRTC connection as TURN-relayed, even though browsers behind NAT are exactly where TURN relaying happens. The detection that makes this work was only wired into the headless node, not the web app.
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/lib/connection-path.ts, packages/cadre-core/src/diagnostics/webrtc-turn-tracker.ts
difficulty: medium
----

## Background

The `turn-relayed-path-metrics` work added a three-layer detection path so a
TURN-relayed `/webrtc` session is classified `relayed`/`webrtc-turn` instead of
`direct`/`webrtc`:

- **Layer 1 (classifier)** — `classifyConnectionPath` honours a `turnRelayed`
  hint on the connection. This shipped in **both** copies of `connection-path.ts`
  (cadre-core and `reference-app-web/src/lib/`).
- **Layer 2 (`TurnRelayTracker`)** — wraps `globalThis.RTCPeerConnection` and
  records whether ICE selected a TURN relay candidate. Lives in **cadre-core**.
- **Layer 3 (wiring)** — installs the tracker, drains it on `connection:open`,
  and sets `turnRelayed` before summarising. Wired **only into `CadreNode`**.

The web reference app does **not** use `CadreNode`. It builds its own libp2p node
in `cadre-web.ts` and computes connectivity in `diagnostics.svelte.ts`:

```ts
const conns = node.getConnections?.() ?? [];
const paths = summarizeConnectionPaths(conns);   // conns never carry turnRelayed
```

So the web classifier *supports* the `turnRelayed` hint, but **nothing in the web
app ever sets it**. The `webrtc-turn` transport, the relayed/stuck-on-relay
promotion, and the `cadre_connections_by_transport{transport="webrtc-turn"}`-style
UI badge can therefore never appear in the browser Diagnostics — even though the
browser (a NAT'd tab needing a TURN relay to reach a peer) is the *primary* place
TURN relaying actually occurs. The headless cadre-cli node, by contrast, has no
`RTCPeerConnection` at all, so its detection path is inert in practice.

The net effect: the most user-visible TURN case is the one currently unreported.

## Use case / expected behavior

When a browser peer's WebRTC session is carried over a TURN relay, the web app's
Diagnostics panel (relayed / direct / stuck-on-relay counts and the per-transport
breakdown) should reflect it as `webrtc-turn` (relayed), the same way the
cadre-core node does once TURN is enabled.

This requires wiring a TURN-relay tracker into the web app's libp2p lifecycle:

- Install a tracker that wraps the browser's `globalThis.RTCPeerConnection`
  **before** the libp2p node is created (so it wraps the constructor before
  `@libp2p/webrtc` can use it), and dispose it on node stop.
- On the web node's `connection:open` for a genuine `/webrtc` connection (not
  `/webrtc-direct`), drain the tracker and tag the peer; clear on
  `connection:close`.
- Annotate each connection with `turnRelayed` before
  `summarizeConnectionPaths(conns)` in `diagnostics.svelte.ts`, mirroring
  `CadreNode.getConnectionPaths()`.

## Considerations

- **Code sharing.** `TurnRelayTracker` currently lives in cadre-core and is not
  exported from `@serfab/cadre-core/src/index.ts`. The web app already depends on
  `@serfab/cadre-core` (see the note atop `reference-app-web/src/lib/connection-path.ts`).
  The cleanest path is to export `TurnRelayTracker` and reuse it rather than add a
  second copy — and possibly fold the duplicated `connection-path.ts` into a
  shared import at the same time (a tracked follow-up the duplicate's header
  already calls out).
- **Same documented best-effort limits** as the cadre-core wiring (settlement↔open
  timing correlation, startup-race window before the listener attaches). Reuse,
  don't re-derive.
- TURN is off by default today, so this is not urgent — but the feature is only
  half-delivered without it, and the gap is silent (the web classifier *looks*
  TURN-aware but is inert).
