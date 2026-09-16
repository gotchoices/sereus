description: A one-line change in a networking library we depend on would make it work on phones out of the box, instead of every phone app having to discover and work around the same silent failure. Somebody needs to decide whether we open that report with the library's maintainers, and then open it.
files:
  - packages/reference-app-rn/polyfills/hermes.js (our local workaround, and the evidence)
  - node_modules/@libp2p/websockets/dist/src/websocket-to-conn.js (the upstream code, v10.1.3)
difficulty: easy
----

# Human action: report the missing `bufferedAmount` handling to js-libp2p

## Why this is a human's call, not an agent's

Opening an issue on another project's tracker posts under a person's account, in public, in our name. That is a decision for whoever owns our relationship with the js-libp2p maintainers. Everything needed to write the report is below; all that is missing is the decision to send it and somebody to send it.

## The finding

`@libp2p/websockets` decides whether it can keep writing to a socket by reading the standard `bufferedAmount` property — how many bytes the socket still has queued. In `dist/src/websocket-to-conn.js` (version 10.1.3):

```js
sendData (data) {
  for (const buf of data) { this.websocket.send(buf) }
  const canSendMore = this.websocket.bufferedAmount < this.maxBufferedAmount
  if (!canSendMore) { this.checkBufferedAmountTask.start() }
  return { sentBytes: data.byteLength, canSendMore }
}

checkBufferedAmount () {
  this.log('buffered amount now %d', this.websocket.bufferedAmount)
  if (this.websocket.bufferedAmount === 0) {
    this.checkBufferedAmountTask.stop()
    this.safeDispatchEvent('drain')
  }
}
```

React Native's WebSocket implements that property nowhere — not on the instance, not on `WebSocket.prototype`. So `bufferedAmount` is `undefined`, `undefined < 4194304` evaluates to `false`, and the transport concludes the socket is permanently full. It then starts a poll waiting to see `bufferedAmount === 0`, which `undefined` never satisfies. The socket opens and the handshake is never written.

The user-visible result is a connection that appears to be establishing and then fails ten seconds later with `AbortError: The operation was aborted` — libp2p's dial timeout, with nothing anywhere naming the real cause. Our own device log showed the transport reaching `libp2p:websockets connected` and then repeating `buffered amount now undefined` until the abort.

The suggested change is one operator in each of those two reads — treat a missing `bufferedAmount` as `0`:

```js
const canSendMore = (this.websocket.bufferedAmount ?? 0) < this.maxBufferedAmount
```

Zero is the correct reading for React Native, which hands each frame to the native socket on `send()` and keeps no JavaScript-side queue, so from the caller's point of view nothing is ever pending. The same applies to `@valor/nativescript-websockets`, which declares the property in its type definitions and assigns it nowhere.

## Evidence we can offer

Observed on a Galaxy Note 9 on 2026-09-16, debug build of `packages/reference-app-rn`, dialling a WebSocket-listening node:

- Before: every dial died at libp2p's ten-second timeout. The same address dialled from a desktop with a plain libp2p client (WebSocket, noise, yamux) connected in 37 ms.
- After adding a local `WebSocket.prototype.bufferedAmount` getter returning `0`: connected in 1.6 s, and the phone held a circuit-relay reservation for the first time.

## Decisions for the person taking this

- Whether to open the report at all, given we already carry a local workaround that costs us nothing further.
- Whether to open an issue or go straight to a pull request. The change is two operators; a pull request is probably less work for everyone than an issue describing it.
- Which repository and which account. The package's manifest points at `git+https://github.com/libp2p/js-libp2p.git`; `@libp2p/websockets` lives in that monorepo.
- Once it is sent, record the issue or pull request link here (or in `docs/reference-app-rn.md` beside the polyfill note) so the next person hitting this can see whether upstream has moved and whether our workaround can be dropped.
