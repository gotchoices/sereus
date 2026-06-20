description: Add per-stream read/session timeouts (and optional concurrency caps) to the control-network request/response handlers (seed delivery + push-wake), which currently read to EOF with no timeout
files: packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/formation-listener.ts
----

Both control-network request/response handlers read an inbound stream **to EOF with no timeout**:

- `StrandWakeService.handleStream` (`strand-wake-protocol.ts`) — `readFrame` iterates the stream until the peer half-closes its write end.
- `SeedBootstrapService`'s seed handler (`seed-bootstrap.ts`) — same pattern.

A peer that opens a stream and never half-closes hangs that read indefinitely, pinning a handler. There is also no concurrency cap, so a single peer could open many such streams. Both handlers are **membership-gated** (only this party's `CadrePeer`s connect), so the risk is low and the exposure is to a buggy/compromised own-cadre node rather than the open internet — which is why `hibernation-push-wake` deliberately deferred this. But the hardening is worth doing for both protocols together.

`FormationListener` already implements the desired shape: `sessionTimeoutMs` / `stepTimeoutMs`. Lift that pattern into a small shared helper (or duplicate minimally) so seed + wake handlers:

- abort a stream whose request frame does not complete within a bounded read timeout, replying with a non-accepting ack where the protocol allows (wake) or just aborting (seed),
- optionally bound the number of concurrent inbound streams per protocol.

Note the sender side has a related minor gap: `dialWake`'s `withTimeout` rejects on timeout but does not abort the in-flight `dialProtocol`/`sendWake`, so a timed-out dial can leak a dangling stream. Abort the underlying stream on timeout while here.
