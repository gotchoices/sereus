description: The NativeScript app almost certainly cannot open a connection to any other machine, for the same reason the phone app could not until last week — its WebSocket library never reports how much data is waiting to be sent, and the networking stack reads that as "the socket is full" and stops sending. The fix is the same one-line shim, plus the same tidy-up in its abort-signal code.
files:
  - packages/reference-app-ns/src/polyfills/hermes.ts (where the bufferedAmount shim belongs)
  - packages/reference-app-ns/src/polyfills/abort.ts (AbortSignal.any / AbortSignal.timeout cleanup)
  - packages/reference-app-ns/src/polyfills/audit.ts (probe list — WebSocket presence is probed, bufferedAmount is not)
  - packages/reference-app-ns/src/cadre-phone.ts (line 169 — the WebSocket transport this affects)
  - packages/reference-app-rn/polyfills/hermes.js (the verified shim to mirror)
  - docs/reference-app-ns.md
repro: static
difficulty: easy
----

# The NativeScript app has the WebSocket gap the phone app just fixed

## What this is

On 2026-09-16 the React Native app could not dial any peer over WebSocket. The cause was that React Native's `WebSocket` defines `bufferedAmount` nowhere, and `@libp2p/websockets`' `websocket-to-conn.js` gates sending on `websocket.bufferedAmount < maxBufferedAmount`. `undefined < 4194304` is `false`, so the transport concluded the socket was full, started polling for a drain (`bufferedAmount === 0`, never true against `undefined`), and never wrote the handshake. The socket opened; nothing was sent; libp2p's ten-second dial timeout fired with `AbortError: The operation was aborted` and no clue as to why. Commit `7a0fd6c` added a `WebSocket.prototype.bufferedAmount` getter returning `0` and the phone connected in 1.6 s.

`packages/reference-app-ns` uses the same transport — `src/cadre-phone.ts:169` builds the node with `transports: [webSockets(), circuitRelayTransport()]` — over `@valor/nativescript-websockets`. That package declares `bufferedAmount?: number` in `websocket.d.ts` and assigns it nowhere: a search across every `.js` in the installed package finds the name only in that type declaration. So at runtime it reads `undefined`, and the NativeScript app should be failing exactly the way the phone was.

## How sure this is

Read from source, not observed. Nobody has run the NativeScript app against a WebSocket peer and watched it fail, and there is no NativeScript device in this pipeline. What would confirm it: launch the app against a WebSocket-listening node, and either watch a dial sit until the ten-second timeout, or read `bufferedAmount` off a live socket instance and see `undefined`. Do that before or right after landing the shim — the shim is harmless either way (reporting `0` is the honest answer when the library keeps no JavaScript-side send queue), but the record should say which it was.

The one thing that could make this a non-issue: if `@valor/nativescript-websockets` sets the property from native code in a way a source search cannot see. The device check settles it.

## The same abort-signal cleanup

`src/polyfills/abort.ts` implements `AbortSignal` from scratch for NativeScript, whose runtime ships none. Its `static any(signals)` has the same defect the React Native version has: it attaches an `abort` listener to each input signal and removes none of them when the combined signal settles, so listeners accumulate on any long-lived input. Optimystic's repo client (`../optimystic/packages/db-p2p/src/repo/client.ts:91`) combines a caller signal with a fresh per-request deadline controller on every remote block RPC, and `p-wait-for` (reached through `libp2p`, `@libp2p/websockets` and `@libp2p/circuit-relay-v2`) does the same at `index.js:79` — so on an app left running, that is one listener per RPC that never goes away. `static timeout(ms)` likewise leaves its timer running after the signal is no longer referenced; bounded by the timeout, so a smaller cost, but the same shape.

Fix both here so the two apps do not drift: detach the listeners once the combined signal aborts, register nothing when an input is already aborted, and clear the timeout's timer once it has fired or the signal has aborted.

## What the boot audit misses

`src/polyfills/audit.ts` probes `WebSocket` for presence, which passes — the class exists. It cannot see that an instance property the networking stack depends on is missing. Probe the property itself, not just the constructor, so this specific gap would have announced itself at boot. A probe entry of the shape `WebSocket.prototype.bufferedAmount` fits the existing dotted-path resolver as-is.

## TODO

- Add a `WebSocket.prototype.bufferedAmount` getter returning `0` to `packages/reference-app-ns/src/polyfills/hermes.ts`, guarded on the property being absent from the prototype, mirroring the React Native version — including its explanation of why `0` is the honest answer. Call `markPolyfilled` for it so the audit can report `polyfilled` rather than `native`.
- Make `AbortSignalPolyfill.any` in `src/polyfills/abort.ts` detach its `abort` listeners from every input once the combined signal aborts, and register nothing when an input is already aborted.
- Make `AbortSignalPolyfill.timeout` clear its timer once the signal has aborted.
- Add a `WebSocket.prototype.bufferedAmount` probe to the `PROBES` list in `src/polyfills/audit.ts`, keyed to whatever `markPolyfilled` name the shim registers.
- Note the gap and the shim in `docs/reference-app-ns.md`, next to whatever that file already says about the polyfill set.
- Run `yarn workspace @serfab/reference-app-ns test` and the package's typecheck, plus `yarn lint`.
- Confirm on a NativeScript device or emulator: a WebSocket dial that previously sat until the ten-second timeout now connects, and the boot audit shows no `MISSING` rows. Record which of the two outcomes described under "How sure this is" actually happened.
