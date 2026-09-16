description: The phone could not open a connection to any other machine — every dial died after ten seconds — because React Native's WebSocket and Hermes are missing three small web APIs libp2p relies on. Fixed on the device by adding them to the app's Hermes polyfills; this ticket is the regression guard and the audit of what else is missing.
files:
  - packages/reference-app-rn/polyfills/hermes.js (the three additions this ticket guards)
  - packages/reference-app-rn/test/metro-babel/async-generator-cleanup.spec.ts (the pattern for a headless guard)
  - packages/reference-app-rn/docs or docs/reference-app-rn.md (§ Key Dependencies — record the Hermes gaps)
repro: verified
----

# The phone could not dial anyone (Hermes/React Native API gaps)

## What was observed (device, 2026-09-16)

Galaxy Note 9, debug `reference-app-rn`. **Settings → Dial Peer** against a lent cadre-host node on a loopback WebSocket address:

1. First failure: `TypeError: AbortSignal.timeout is not a function (it is undefined)`.
2. After polyfilling that: `AbortError: The operation was aborted`, exactly 10.3 s later (libp2p's dial timeout).
3. The same address dialled from the PC with a plain libp2p client (WebSocket + noise + yamux): **connected in 37 ms**.

With `DEBUG=libp2p:*` on the phone, the dial reached `libp2p:websockets connected`, then repeated
`buffered amount now undefined` until the abort.

## Cause

Three APIs libp2p expects are absent under React Native / Hermes:

- **`AbortSignal.timeout`** — `libp2p/connection-manager/dial-queue.js` does
  `signal: options.signal ?? AbortSignal.timeout(this.dialTimeout)`, so every dial without its own
  signal threw. Also used by `@libp2p/circuit-relay-v2` (reservations), `@libp2p/websockets`,
  `@libp2p/identify`, and libp2p's connection/registrar/pruner paths.
- **`AbortSignal.any`** — same family; polyfilled alongside it.
- **`WebSocket.bufferedAmount`** — React Native's WebSocket defines it nowhere (verified on device:
  absent from the instance *and* from `WebSocket.prototype`). `@libp2p/websockets`'
  `websocket-to-conn.js` gates sending on `websocket.bufferedAmount < maxBufferedAmount`
  (`undefined < n` is false, so it stops sending) and then waits for a poll to see
  `bufferedAmount === 0`, which never comes. The socket opened and the handshake was never written.

## What was fixed in place

`polyfills/hermes.js` now defines `AbortSignal.timeout`, `AbortSignal.any` (abort reason falls back to
a named `Error` where `DOMException` is absent), and a `WebSocket.prototype.bufferedAmount` getter
returning 0 — honest under RN, which hands each frame to the native socket on `send()` and keeps no
JS-side queue.

After the fix, on the device: Dial Peer connected in **1.6 s**, the connection showed `open` in the
control node, the phone held a **relay reservation** for the first time ("Reachable: Yes — via relay"),
and a cross-party closed-strand `formStrand` completed in 2.3 s through that relay.

## Why this needs a ticket rather than just the fix

- **No guard.** Nothing fails if these polyfills are deleted or if a dependency starts using another
  missing API; the failure only shows on a device, as a 10-second timeout with no error text.
  `test/metro-babel/async-generator-cleanup.spec.ts` is the precedent for a headless guard: add one
  that asserts each polyfill is installed after importing `polyfills/hermes`, and — more valuable —
  one that fails if `@libp2p/*` or `libp2p` reference a global the app does not provide.
- **The audit is unfinished.** These three were found by hitting them one at a time. Sweep libp2p and
  its dependencies for other browser/Node globals Hermes lacks (a scan for `AbortSignal.`,
  `WebSocket.`, `queueMicrotask`, `performance.`, `structuredClone`, `Blob`, `FileReader` against
  what `polyfills/` provides), and either polyfill or document each.
- **Upstream.** `@libp2p/websockets` treating a missing `bufferedAmount` as "never drains" is worth
  reporting: a one-line `?? 0` there would make every React Native consumer work.

## Scope note

`packages/reference-app-ns` (the NativeScript app) has its own polyfill set and was not checked; it
uses the same libp2p stack, so it likely has the same three gaps.
