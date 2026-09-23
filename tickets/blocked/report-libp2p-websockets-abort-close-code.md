description: A networking library we depend on tries to hang up hard on a WebSocket using a code the protocol forbids sending, so the hang-up silently fails and the connection is left open forever while the software believes it is gone. Somebody needs to decide whether we report it upstream, work around it ourselves, or live with it.
files:
  - node_modules/@libp2p/websockets/dist/src/websocket-to-conn.js (the upstream code, v10.1.3 — `sendReset`)
  - node_modules/@libp2p/utils/dist/src/abstract-message-stream.js (`abort()`, which swallows the failure)
  - packages/cadre-core/src/membership-connection-gater.ts (our one call site, worked around in `bug-relay-only-deadline-abort-leaves-the-stranger-half-open`)
difficulty: easy
----

# Human action: a dependency outside this repo, and three ways to respond

**Blocked category: a defect in a third-party dependency (`@libp2p/websockets`) that this repository cannot fix.** What unblocks it is a person choosing one of the three responses at the bottom — report upstream, wrap the transport locally, or accept it — and, if it is the first, opening the report.

## The finding

libp2p connections offer two ways to hang up: a graceful `close()` and a hard `abort()`. Over WebSockets the hard one does nothing at all.

`@libp2p/websockets` v10.1.3, `dist/src/websocket-to-conn.js`:

```js
sendReset () {
  this.websocket.close(1006) // abnormal closure
}
```

Status code 1006 is reserved. RFC 6455 §7.4.1 says it "MUST NOT be set as a status code in a Close control frame by an endpoint" — it exists only as a value a local implementation reports when a connection died without a close frame. The `ws` package enforces that, so the call throws:

```
TypeError: First argument must be a valid error code number
```

and `AbstractMessageStream.abort()` in `@libp2p/utils` swallows it:

```js
try {
  this.sendReset(err)
} catch (err) {
  this.log('failed to send reset to remote - %e', err)
}
```

The result is a connection that is gone on one side and open on the other. The aborting end marks it `aborted` and drops it from `getConnections()`; no close frame is sent, the TCP socket stays up with no timeout of its own, and the remote end learns only when its own liveness ping eventually fails.

Measured on 2026-09-23 against two bare libp2p nodes over WebSockets (listener, dialer, both on stock settings), aborting the listener's side of the connection:

- With `abort()`: the dialer still reported the connection `open` 8 s later, and the listener's WebSocket server still held the socket. The dialer only dropped it at ~15 s, when libp2p's default ping (10 s interval, 5 s deadline) failed.
- With `close()` instead: both ends and the socket were down within 250 ms.

`ws.close(1006)` also sets its own state to `CLOSING` *before* throwing, so a later graceful close on the same socket is a no-op too. The connection cannot be recovered or re-closed; only the process exiting or the remote hanging up ends it.

## Why it is worth a decision rather than a shrug

libp2p aborts connections in its own normal operation, and each of those sites leaks a socket over WebSockets on the aborting side:

- `libp2p/dist/src/connection-monitor.js:82` — ping failure, with `abortConnectionOnPingFailure` defaulting to true. This is the common one.
- `libp2p/dist/src/connection-manager/index.js:193, 327, 355` — including `327`, "Duplicate multiaddr connection", which aborts a perfectly live socket.
- `libp2p/dist/src/connection-manager/utils.js:38` and `upgrader.js:185`.

The severity varies. A ping-failure abort usually follows a peer that has already gone, so the socket is half-dead and the operating system reaps it eventually via TCP keepalive — slow, but self-limiting. The duplicate-connection abort, and our own relay admission deadline, act on live sockets the remote is happily holding: those leak until the remote gives up.

Every sereus deployment is affected, because WebSockets is the transport control nodes listen on.

## Suggested change, if the report route is taken

Send a legal code, or skip the frame and kill the socket. Either of:

```js
sendReset () {
  this.websocket.close(1002) // protocol error
}
```

```js
sendReset () {
  // ws exposes terminate(); the browser WebSocket does not, hence the guard
  if (typeof this.websocket.terminate === 'function') {
    this.websocket.terminate()
  } else {
    this.websocket.close(1002)
  }
}
```

`terminate()` is the closer match to abort semantics — it destroys the socket without a close handshake, which is what a reset means — but it exists only on the Node `ws` implementation, so the browser path still needs a legal code. 1002 (protocol error) or 1011 (internal error) both reach the remote as an explicit abnormal close, which is strictly more information than the remote gets today.

A second, independent suggestion: `AbstractMessageStream.abort()` swallowing a failed `sendReset()` is what turned a wrong constant into a silent leak. Even leaving the catch in place, that log line is `this.log(...)` rather than `this.log.error(...)`, so it does not show by default.

## What sereus already did

`packages/cadre-core/src/membership-connection-gater.ts` was the site where this surfaced — a relay admits a stranger's connection for five seconds so it can request forwarding capacity, and aborted it when no request came. The abort never reached the wire, two integration tests went red, and the relay was leaking a socket per stranger. That site now closes instead of aborting, with the abort kept as a fallback (`bug-relay-only-deadline-abort-leaves-the-stranger-half-open`). It is our only direct call; everything else listed above is libp2p calling its own.

## The decision

1. **Report upstream.** Same considerations as `report-libp2p-websockets-buffered-amount`: it posts in our name, on someone's account, so it is a person's call. The package's manifest points at `git+https://github.com/libp2p/js-libp2p.git`; `@libp2p/websockets` lives in that monorepo. The change is one line, so a pull request is probably less work for everyone than an issue. Recommended, and the cheapest of the three.
2. **Wrap the transport locally.** Subclass or monkey-patch the maConn so `sendReset` uses a legal code, applied wherever sereus builds its transports. This makes libp2p's own abort sites correct too, which reporting alone will not until a release lands. It reaches into a third party's internals and would have to be applied at every construction site (`wsTransports()` in the test harness, and each app that supplies its own `network.transports`), so it is a real architectural commitment — hence a human's call and not an agent's.
3. **Do nothing further.** The gater's own site is already fixed. The remaining exposure is libp2p's internal aborts, mostly on already-dead peers. Defensible; it should be a deliberate choice rather than the default.

**If nothing is decided**, option 3 is what happens, and it is survivable — which is why this is not urgent. Every option is fully reversible.

Record the issue or pull request link here once it is sent, so the next person can tell whether upstream has moved and whether the gater's `abort()` fallback can go away.
