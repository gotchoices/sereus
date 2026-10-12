description: Every Sereus node answers liveness pings with a 10-second limit built into a library Sereus does not control, so on a slow link the node being pinged gives up before the 30 seconds the pinging side was told to allow, and the connection is dropped anyway. Needs a change in Optimystic, or a decision to work around it here.
architecture: docs/architecture.md
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (`ping: ping()` ~959, built bare), packages/cadre-core/src/types.ts (`DEFAULT_CONNECTION_MONITOR` ~665, the 30 s deadline this defeats), ops/docker/libp2p-infra/src/main.ts (the deployed relay's `ping: ping()` ~97, same defect, fixed in this repo by `implement/slow-relay-joiner-strand-connection-keeps-dropping`), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (where it was measured)
repro: verified
----

# A ping handler's 10 s timeout drops connections the 30 s monitor deadline was meant to keep

**Blocked on a dependency outside this repo.** `@optimystic/db-p2p` constructs libp2p's ping service as a bare `ping()` (`libp2p-node-base.ts` ~959) and exposes no way to set its handler timeout. Unblocks when Optimystic accepts the option proposed below, or when a human accepts the in-repo workaround listed under alternatives.

## What happens

libp2p's connection monitor on node A opens a `/ipfs/ping/1.0.0` stream to node B and waits for the echo under A's deadline (30 s on every cadre node, `DEFAULT_CONNECTION_MONITOR`; 30 s on the deployed relay). On B, `@libp2p/ping`'s inbound handler runs its own timer, `TIMEOUT = 10000` (`@libp2p/ping` 3.1.13, `constants.js`), and when it fires the handler aborts the stream. A then sees `StreamResetError: The stream has been reset` from its ping, and the monitor aborts the whole connection, exactly as it would on its own timeout. B's 10 s limit, not A's 30 s, decides when the connection dies, and nothing in cadre-core's settings can move it.

Measured on `joiner-first-commit-over-slow-relay.integration.ts`'s slow-link arms (20 ms per-frame cap, event loop 70% busy), with the harness relay carrying the deployed relay's monitor settings (so no monitor timed out): the fourth arm logged 8 `aborting connection due to ping failure` in 114 s and the fifth 11 in 143 s, every one `StreamResetError` or `UnexpectedEOFError`, none a timeout. Outbound frames on that link waited 10 to 22 s in the socket queue, so an inbound ping's echo routinely took longer than 10 s. The two strand nodes' relayed connection dropped on each, and the strand member redial reconnected them 21.5 s later. Logs: `tickets/.logs/slow-relay-joiner-strand-connection-keeps-dropping.exp1.log` and `.exp2.log` (pruned after 14 days).

Isolated reproduction (two bare libp2p 3.3.11 nodes over WebSockets with the harness's `installWsLatency({ delayMs: 150, mode: 'serial' })`; the dialer's monitor at `pingInterval: 8_000`, `pingTimeout` pinned at 30 s; the listener handling `/ipfs/ping/1.0.0` with `@libp2p/ping`'s handler body and its timeout made a parameter): with the handler timeout at 100 ms the dialer logged `StreamResetError` and dropped the connection within 14 s; at 10 000 ms the connection stayed. Run once each, 2026-10-12.

## Proposed change in Optimystic (the recommended default)

Give `NodeOptions` a ping handler timeout and pass it through: `ping({ timeout: options.pingHandlerTimeoutMs })`, defaulting to strictly above the node's `connectionMonitor.pingTimeout.maxTimeout` when one is declared (the same relation the existing rule keeps between `pingInterval` and that deadline), and to `@libp2p/ping`'s 10 s otherwise. Add the relation to the same spec family as `test/connection-monitor-ping-overlap.spec.ts`: "the handler timeout is never the first deadline to fire". The handler's timer exists only to free a stream whose dialer went silent, and the dialer's own deadline already resets that stream, so a handler timeout of twice the monitor deadline costs nothing.

Then cadre-core sets it beside `connectionMonitor` at both of its node builders (`cadre-node.ts`, `strand-instance-manager.ts`), and `types.ts`'s `DEFAULT_CONNECTION_MONITOR` comment gains the rule.

## Alternatives, and why they were not taken

- **Re-register the ping protocol in cadre-core after the node is built** (`node.unhandle('/ipfs/ping/1.0.0')`, then `node.handle` with an echo handler under a longer timer). Works today without Optimystic, but duplicates a libp2p service in this repo, and silently diverges from upstream's handler on every later `@libp2p/ping` change. Acceptable as an interim if Optimystic declines; a human should say so.
- **Raise cadre-core's monitor interval or deadline.** Does nothing: the handler on the other end fires first regardless.
- **Lower the monitor deadline to 10 s to match.** Brings back gotchoices/sereus#13 (a busy phone missing short deadlines), which the 30 s deadline exists to prevent.

## If nothing is done

Every relayed connection whose one-way queue exceeds 10 s drops on the next ping, on both ends. The strand member redial (`strand-peer-redial.ts`) reconnects after its 21.5 s backoff, and the slow-link arms pass with the relay fix alone (2 of 2 runs, 2026-10-12), but each drop costs a relayed redial (about 9 s on that link) and resets every read in flight. On real phones over the public relay, that is the connect-and-drop cycle the fix ticket describes.

## Reversibility

A configuration option with a default equal to today's behaviour when undeclared. Fully reversible.
