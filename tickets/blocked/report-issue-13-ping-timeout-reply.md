description: A draft reply to the reporter on gotchoices/sereus#13 and their PR #15, which found why a slow phone gets stuck. Posting it, and merging PR #15, is the maintainer's call.
files:
  - tickets/blocked/slow-peer-dropped-on-ping-timeout.md (the fix plan this reply describes)
----

# Human action: answer #13's root cause and PR #15

PR #15 was reviewed on 2026-09-23: it merges cleanly over `aa33331c`, typechecks against the relay's libp2p 2.10, and changes nothing but `connectionMonitor` in `ops/docker/libp2p-infra/src/main.ts`. Merging it also means redeploying the relay for it to take effect. Before posting, fill in the optimystic version if it has been released by then.

## Draft

> Thanks, this is exactly the root cause we were missing, and the close-attribution trick is a good one.
>
> **Relay (#15):** merged. Widening the ping timeout rather than disabling the abort is the shape we'd have chosen too, for the reason you give: a dead peer is still reclaimed.
>
> **Clients:** Optimystic is adding `NodeOptions.connectionMonitor` (gotchoices/Optimystic#21), with a `Libp2pConnectionMonitorInit` type re-export, as it did for `noiseCrypto`. There's no need to send that PR. Once it's released, cadre-core will pass it through to every node, and will **default** it to your measured values (`minTimeout` 30 s, `maxTimeout` 600 s) rather than leaving it opt-in. Every peer of a slow phone runs the monitor on its connection to that phone, so the phone setting it alone wouldn't cover the PC side.
>
> **Fixture:** we'd still like the CPU-cost fixture as a PR, next to `packages/integration-tests/src/harness/ws-latency.ts`, opt-in by environment variable. It's how we'll confirm the default fixes the full-cost case in our own suite.
>
> On the broader design: agreed that aborting on a single miss defeats the adaptive timeout, and that it's worth raising with libp2p. We'll take the tuning now and follow that upstream.
