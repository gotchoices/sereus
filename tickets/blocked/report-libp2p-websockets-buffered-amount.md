description: Two small changes in a networking library we depend on would fix two silent failures: phones that cannot connect out of the box, and connections that one side drops without the other side ever being told, which leaves the other side waiting up to half a minute and leaks a network socket on both ends. Somebody needs to decide whether we report them to the library's maintainers, and then report them.
files:
  - packages/cadre-rn/polyfills/hermes.js (our local workaround, and the evidence)
  - node_modules/@libp2p/websockets/dist/src/websocket-to-conn.js (the upstream code, v10.1.3; `sendReset()` in v10.1.21)
  - packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (where the second arm's consequence was measured)
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

## Second arm (2026-10-12, from `fix/slow-relay-joiner-strand-connection-keeps-dropping`): the listener side cannot send a reset

Same file, same project. In `@libp2p/websockets` 10.1.21, `websocket-to-conn.js`'s `sendReset()` is `this.websocket.close(1006)`. On the listening side the socket is the `ws` package's, and `ws` refuses 1006 as a close code to send (`lib/sender.js`: `TypeError: First argument must be a valid error code number`; 1006 is reserved for a closure that was not sent). So when a listener, such as a relay, aborts a connection, no close frame reaches the client and the client keeps the connection until its own connection monitor notices, up to 65 s on the deadline Sereus declares. Seen three times as `failed to send reset to remote - TypeError: First argument must be a valid error code number` in the harness relay's log on `joiner-first-commit-over-slow-relay.integration.ts` (`backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults`, third arm, 2026-10-11), and its consequence on the client as `ConnectionClosedError: The connection muxer is "closed" and not "open"` on every dial through the dead connection. The suggested change is to close with a sendable code (1001 or 1011) or to destroy the underlying socket in `sendReset()`. Same decision as the first arm: whether and who reports it.

### Second arm, extended (2026-10-13, from `fix/slow-link-joiner-first-sync-slower-when-relay-answers-pings`)

- **Both ends, not only the listener.** The dialing side's socket is the WHATWG `WebSocket` (Node's built-in one here), and it refuses 1006 too, as the WebSocket standard requires (React Native's was not checked): `failed to send reset to remote - InvalidAccessError: invalid code`. So no libp2p abort of a WebSocket connection closes the socket, from either end.
- **The sockets leak.** Verified with two bare libp2p 3.3.11 nodes over `@libp2p/websockets` 10.1.21 on loopback, connection monitor off: the listener aborted its connection; 3 s later the dialer still listed the connection as `open` with its muxer `closed` (the listener's yamux reset every stream), the dialer's socket was still `OPEN`, and the listener's was stuck in `CLOSING`. The dialer learned only when it next opened a stream (`ConnectionClosedError: The connection muxer is "closed" and not "open"`). After the dialer aborted too, 3 s later its socket was still `OPEN` and the listener's TCP socket was not destroyed. Read, not measured: nothing in either abort path schedules a later close (`ws` arms its close timer only after it has sent a close frame), so on the deployed relay (`ops/docker/libp2p-infra`) each connection its monitor aborts would hold a socket until the client closes it or goes away.
- **Measured consequence.** On `joiner-first-commit-over-slow-relay`'s fourth arm (12 runs, 2026-10-13), when the harness relay aborted a strand node's connection and that node had no stream of its own in flight on it, the node kept the dead connection for 25 to 50 s (5 runs) and was unreachable through the relay meanwhile. When the node's own ping to the relay was in flight, the reset ended that ping and the node's monitor dropped the connection at once (7 runs). How this shortens or lengthens the arm is in that scenario's header ("Why the joiner's first sync takes minutes there").
- **Not fixed upstream yet.** `sendReset()` still calls `close(1006)` in 10.1.22 (latest, 2026-10-10) and in the 10.1.22-4a416447c prerelease (2026-10-12).
- **Suggested change:** in `sendReset()`, end the socket without a close handshake where the socket allows it (the `ws` package's `terminate()` on the listening side), otherwise `close()` with no code or with a sendable one (1011, "internal error"), and do not let a refused close skip the rest of the abort.
