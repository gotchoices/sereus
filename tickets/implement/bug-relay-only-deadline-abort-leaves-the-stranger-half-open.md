description: When a node lets a stranger connect only so it can ask to borrow the node's forwarding capacity, and the stranger never asks, the node is supposed to hang up after five seconds. It does not: the way it hangs up never reaches the wire, so the socket stays open on both machines — the node quietly accumulates one dead socket per stranger, and the stranger only notices minutes later.
architecture: docs/architecture.md#relay-integration
files:
  - packages/cadre-core/src/membership-connection-gater.ts (`PendingReserveDeadlines.expire` — the one line to change — plus every doc line that says the deadline "aborts")
  - packages/cadre-core/test/membership-connection-gater.spec.ts (`abortableConn`, and the four not-reserving-deadline cases that assert on it)
  - packages/cadre-core/test/peer-dial.spec.ts (the pattern for the new real-transport spec: `startNode`, `afterEach` teardown)
  - packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts (case 4, "is dropped when it never reserves" — its comment and its 20 s wait)
  - packages/integration-tests/src/scenarios/control-stream-authz.integration.ts (case (a) of the delegate test — its comment and its 20 s wait)
repro: verified
----

# The relay-only deadline never reaches the wire

## What was measured

Reproduced on sereus `60014d05`, optimystic linked, 2026-09-23.

`yarn workspace @serfab/integration-tests test src/scenarios/relay-only-control-addr.integration.ts -t "is dropped when it never reserves"` fails with `Timeout waiting for not-reserving stranger connection dropped after 20000ms`. The same run passes in 5.7 s with the one-line change below.

The cause is upstream, and it is not the timer, the policy or the deadline — those all work. `PendingReserveDeadlines.expire` calls `maConn.abort(...)`, and **`abort()` on a WebSocket connection never touches the socket**:

- `@libp2p/websockets@10.1.3`, `dist/src/websocket-to-conn.js`, `sendReset()` calls `this.websocket.close(1006)`.
- 1006 is a reserved WebSocket status code that RFC 6455 forbids an endpoint from sending, so `ws@8` throws `TypeError: First argument must be a valid error code number` — measured directly against `ws`, with the socket left in `CLOSING`, no close frame sent, and the TCP socket still up.
- `AbstractMessageStream.abort()` in `@libp2p/utils` wraps `sendReset()` in a `try`/`catch` that only logs. So the local end flips its status to `aborted` — which is why the relay drops the connection from `getConnections()` immediately, and why this looked like "A never had the connection at all" — while nothing whatever happens on the wire.

Measured on two bare libp2p WebSocket nodes (dialer B, listener A, A's gater capturing the `maConn` and aborting it half a second after the upgrade):

| | listener `getConnections()` | dialer `getConnections()` | listener's live WebSocket count |
| --- | --- | --- | --- |
| `maConn.abort()` | empty at once | **still `open` 8 s later** | **still 1, 8 s later** |
| `maConn.close()` | empty at once | empty within 250 ms | 0 within 250 ms |

So the answer to the ticket's first question is yes: **the relay leaks one socket per stranger**, held for as long as the stranger keeps it, with no timeout of its own. On a public relay that is a resource-exhaustion path, and it is the real defect here — the two failing tests are only how it surfaced. Widening the ping schedule (`DEFAULT_CONNECTION_MONITOR`) did not cause this; it removed the ~15 s ping failure that was hiding it.

Graceful close is unaffected by the upstream defect: `sendClose()` calls `this.websocket.close()` with no code, which is legal. That is also why the plain `'deny'` verdict has always worked — libp2p's own WebSocket listener calls `maConn.close()` on an upgrade failure, never `abort()`.

## The fix

Close the transport instead of aborting it, keeping `abort()` only as the escalation if the close cannot complete:

```ts
  private expire(remotePeerId: string, entry: PendingReserveDeadline): void {
    const entries = this.byPeer.get(remotePeerId);
    entries?.delete(entry);
    if (entries?.size === 0) {
      this.byPeer.delete(remotePeerId);
    }
    log('Relay-only admission expired for %s — no reservation admitted within %dms, closing the connection', remotePeerId, this.deadlineMs);
    void this.drop(remotePeerId, entry.maConn);
  }

  private async drop(remotePeerId: string, maConn: MultiaddrConnection): Promise<void> {
    try {
      await maConn.close({ signal: AbortSignal.timeout(RELAY_ADMISSION_CLOSE_TIMEOUT_MS) });
      return;
    } catch (error) {
      log('Closing the expired relay-only connection from %s failed — aborting: %o', remotePeerId, error);
    }
    try {
      maConn.abort(new Error(`relay-only admission expired: no relay reservation admitted within ${this.deadlineMs}ms`));
    } catch (error) {
      log('Aborting the expired relay-only connection from %s threw: %o', remotePeerId, error);
    }
  }
```

That exact shape (with the bound inlined as `2_000`) is what was measured green above. Points that matter:

- **The close must be bounded.** `AbstractMultiaddrConnection.close()` awaits an `idle`/`drain` event when it has unsent bytes, and an unsignalled wait never ends. The gate writes nothing to a stranger, so that wait is not reachable today, but an unbounded await inside an unref'd timer callback is not worth leaving behind.
- **It must be `close()` first and `abort()` second, never the reverse.** `abort()` marks the connection `aborted`, and `close()` returns immediately on any status that is not `open` — so an abort first makes the close a no-op.
- **Already-closed stays harmless.** `close()` on a connection the peer already dropped returns at once without throwing, so nothing fires the fallback.
- **`disarm` is untouched**, so a peer that does reserve inside the deadline is unaffected. Cases 2, 3 and 5 of `relay-only-control-addr.integration.ts` cover that and passed unchanged against the patched build.

One residual risk is worth a `NOTE:` at the site: if the bounded close ever fails, the `abort()` fallback is itself a no-op on WebSockets and the socket leaks anyway. There is no way to reach the raw socket through the `MultiaddrConnection` interface, so the fallback is as far as this layer can go.

## The unit spec currently proves nothing about this

`membership-connection-gater.spec.ts`'s `abortableConn()` returns `{ abort: vi.fn() }` — a double with no `close`. That is why all 54 of its cases still pass against the fixed code: `await maConn.close(...)` throws `TypeError: maConn.close is not a function` and the fallback calls `abort` exactly as before. The double has to grow a `close` or the spec silently stops testing the path that matters.

## Related, do not conflate

`tickets/backlog/bug-party-run-relay-drops-a-stranger-dialing-through-it` is a different defect in the same file: a peer hop-connecting *through* the relay never touches `denyInboundRelayReservation`, so nothing disarms its deadline. Today that drop silently does not happen over WebSockets; once this ticket lands it will. That ticket has been annotated with the measurement — do not try to solve it here.

The upstream defect itself — every `abort()` on a WebSocket connection is a silent no-op, libp2p's own ping-failure and duplicate-connection aborts included — is `tickets/blocked/report-libp2p-websockets-abort-close-code.md`, a human's call to report or work around. This ticket does not wait on it.

## Done when

Both scenarios pass under the default connection monitor with the stranger's side closing within a second or so of the 5 s deadline, and a real-transport spec pins the close so a regression fails in seconds rather than in whatever the ping schedule happens to be.

## TODO

- Replace `PendingReserveDeadlines.expire`'s `maConn.abort(...)` with the bounded `close()` plus `abort()` fallback shown above. Name the close bound as an exported constant beside `RELAY_ADMISSION_RESERVE_DEADLINE_MS` and document why it exists.
- Add the `NOTE:` at the fallback: the upstream `sendReset()` close-code defect, that `abort()` is therefore a no-op on WebSockets, and the revisit condition — drop the fallback, or go back to a plain `abort()`, once `@libp2p/websockets` sends a legal reset.
- Update every doc line in `membership-connection-gater.ts` that says the deadline aborts — the module doc's "The relay-reservation seam" bullet (~line 91), `RELAY_ADMISSION_RESERVE_DEADLINE_MS` (~line 200), `createMembershipConnectionGater`'s "arms a `reserveDeadlineMs` timer" paragraph (~line 354), the `PendingReserveDeadline` interface comment (~line 473) and the `PendingReserveDeadlines` class doc (~line 482). Leave ~line 365 alone: that one is about the `'deny'` path aborting the *upgrade*, which is still what happens.
- Give `membership-connection-gater.spec.ts`'s `abortableConn()` a `close` as well as an `abort`, rename it for what it now observes, and update the four deadline cases to assert the close is what fires and the abort is not. Add one case where `close` rejects, proving the abort fallback still runs.
- Add a real-transport regression spec — two plain libp2p WebSocket nodes, `createMembershipConnectionGater` over a policy returning `'admit-for-relay'`, a short `reserveDeadlineMs` — asserting the DIALER's connection leaves `open` within a second or two of the deadline. Follow `peer-dial.spec.ts` for node construction and teardown. Leave the nodes on libp2p's stock connection monitor: its 10 s ping interval is what makes the assertion sharp, because the broken code could only satisfy it via ping failure at ~15 s. One case; do not also re-test `disarm`, which the doubles already cover.
- Correct the two scenario comments that claim the deadline "aborts the connection on both sides" (`relay-only-control-addr.integration.ts` case 4, `control-stream-authz.integration.ts` case (a)) and tighten each 20 s `waitUntil` to 10 s — measured close lands within ~250 ms of the deadline, and 10 s still leaves generous headroom on a loaded machine while failing fast.
- Run `yarn workspace @serfab/cadre-core test`, then both scenarios in `@serfab/integration-tests`, then `yarn lint` and `yarn typecheck`.
