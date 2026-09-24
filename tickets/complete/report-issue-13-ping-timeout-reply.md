description: A draft reply to the reporter on gotchoices/sereus#13 and their PR #15, which found why a slow phone gets stuck. Posting it, and merging PR #15, is the maintainer's call.
files:
  - ops/docker/libp2p-infra/src/main.ts (the relay's `connectionMonitor`, which this reply describes)
  - packages/cadre-core/src/types.ts (`DEFAULT_CONNECTION_MONITOR`, the client half)
----

**Superseded and posted 2026-09-24** (maintainer-approved): rewritten against the final state (35 s / 30 s pinned, the WebSocket 1006 abort finding) and posted as #13 https://github.com/gotchoices/sereus/issues/13#issuecomment-5808300699, #16 https://github.com/gotchoices/sereus/issues/16#issuecomment-5808300502 and PR #14 https://github.com/gotchoices/sereus/pull/14#issuecomment-5808300904. The draft below is kept for the record and no longer current.

# Human action: answer #13's root cause, PR #15 and PR #14

PR #15 was reviewed on 2026-09-23: it merges cleanly over `aa33331c`, typechecks against the relay's libp2p 2.10, and changes nothing but `connectionMonitor` in `ops/docker/libp2p-infra/src/main.ts`. Merging it also means redeploying the relay for it to take effect. Before posting, fill in the optimystic version if it has been released by then.

PR #14 (relay libp2p 2 → 3) was reviewed on the same day, and **can't be merged as is**:
- It conflicts with `aa33331c`, which removed `@libp2p/kad-dht`, while #14 bumps it. The fix is to drop that line.
- **On a clean install it fails to compile.** `src/env.ts` uses `process`, and `@types/node` is not declared. libp2p 2 pulled it in indirectly and libp2p 3 doesn't, so the Dockerfile's `npm install && npm run build` would fail. Adding `"@types/node": "^22"` to `devDependencies` fixes it. The reporter's "compiles clean" was most likely an existing `node_modules`.
- With both fixed, and #15 merged too, the relay builds on libp2p 3.3.11 and starts. A libp2p 3.1.3 client (sereus's version) reserved over `/ws`, a second client dialed it through the circuit unlimited, and identify completed over it.

**Updated 2026-09-23, during the review of the cadre-core half.** Widening the ping deadline is only half of what PR #15 needed. libp2p starts a fresh ping on every connection each `pingInterval` whether or not the last one answered, and `@libp2p/ping` allows only one outbound ping stream per connection, so the second overlapping ping is refused and the monitor aborts the connection exactly as a timeout would. At the stock 10 second interval, a 30 second deadline is really a 10 second one — which is most likely why the reporter's relay-only run was 2 of 3 rather than 3 of 3. `ops/docker/libp2p-infra/src/main.ts` now also sets `pingInterval: 35_000` and pins `maxTimeout` to the 30 second floor, and cadre-core's default matches. The relay still has to be redeployed. The draft below has been corrected to say this; the rest of the reply is unchanged.

PR #15's code is right, but its comment isn't, on the relay's current libp2p 2.10. It says the timeout "widens on failure" and that a dead peer goes "after ten minutes". In fact the 2.10 (and 3.1.x) monitor never feeds its `AdaptiveTimeout`, so the deadline is a flat `minTimeout` (30 s), and a dead peer is reclaimed in about 30–40 s. That's better than the comment claims. The comment below asks for a correction; you could also fix it when merging. It would have become adaptive once #14 moved the relay to libp2p 3.3.11, but the ceiling is now pinned to the floor so it stays flat there too — see the update above for why.

Merge #15 first; it merges cleanly. Then ask for the two #14 changes (comment below), or make them when merging.

## Draft

> Thanks, this is exactly the root cause we were missing, and the close-attribution trick is a good one.
>
> **Relay (#15):** merged. Widening the ping timeout rather than disabling the abort is the shape we'd have chosen too, for the reason you give: a dead peer is still reclaimed.
>
> One correction to its comment, which we'll fix on our side: the relay's connection monitor doesn't actually adapt below libp2p 3.3. In 2.10 and 3.1.x it asks `AdaptiveTimeout` for a deadline but never calls `cleanUp()`, so the average stays at zero and every ping gets exactly `minTimeout`. 3.3.11 added the `cleanUp` call. So what your runs measured was a flat 30 s deadline, which is also why raising only the ceiling did nothing, and a dead peer is reclaimed in tens of seconds, not ten minutes. We've since pinned `maxTimeout` to the floor on our side rather than letting #14 make it adaptive — see below.
>
> **Clients:** Optimystic is adding `NodeOptions.connectionMonitor` (gotchoices/Optimystic#21), with a `Libp2pConnectionMonitorInit` type re-export, as it did for `noiseCrypto`. There's no need to send that PR. Once it's released, cadre-core will pass it through to every node, and will **default** it rather than leaving it opt-in. Every peer of a slow phone runs the monitor on its connection to that phone, so the phone setting it alone wouldn't cover the PC side.
>
> **One thing your 30 s floor needs alongside it**, which we found while wiring the client half: `pingInterval` has to be raised above the deadline as well. The monitor starts a new ping on every connection each interval whether or not the previous one has answered, and `@libp2p/ping` registers `/ipfs/ping/1.0.0` with `maxOutboundStreams: 1` — so the second overlapping ping fails in `Connection.newStream` with `TooManyOutboundProtocolStreamsError`, which lands in the monitor's own catch and aborts the connection just as a timeout does. At the stock 10 s interval, a 30 s deadline is really a 10 s deadline, which we think is why the relay-only run came out 2 of 3 rather than 3 of 3. We checked it against two local libp2p 3.1.3 nodes whose ping handler answered 600 ms late: a 300 ms interval with a 900 ms deadline aborted the connection, a 900 ms interval with the same deadline kept it. Both the relay config and the cadre-core default now use `pingInterval: 35_000` with the 30 s deadline, and pin `maxTimeout` to it so a later libp2p that adapts the deadline can't grow it back past the interval. The cost is that a dead peer is reclaimed in 30-65 s rather than 30-40 s.
>
> **Fixture:** we'd still like the CPU-cost fixture as a PR, next to `packages/integration-tests/src/harness/ws-latency.ts`, opt-in by environment variable. It's how we'll confirm the default fixes the full-cost case in our own suite.
>
> **#14:** thanks, two things before it can go in. (1) Since you branched, master removed the DHT from the relay (`aa33331c`), so `@libp2p/kad-dht` conflicts; drop that line. (2) It doesn't build from a clean install: `src/env.ts` uses `process`, and `@types/node` came in only through libp2p 2's dependencies. With `"@types/node": "^22"` in `devDependencies` it builds, and we checked a libp2p 3.1.3 client reserves through it and carries identify over the circuit. A fresh `rm -rf node_modules && npm install && npm run build` would have shown the second one.
>
> On the broader design: agreed that aborting on a single miss defeats the adaptive timeout, and that it's worth raising with libp2p. We'll take the tuning now and follow that upstream.
