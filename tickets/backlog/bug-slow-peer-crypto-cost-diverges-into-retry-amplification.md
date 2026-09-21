description: A phone whose crypto is slow enough doesn't just take longer to sync: past a point it never finishes, because the extra delay makes the system redo work, and the redone work costs more crypto. A reporter reproduced this in Node without a phone. Find which deadline causes the redo, and make a slow peer slow rather than stuck.
files:
  - packages/integration-tests/src/harness/ws-latency.ts (sibling fixture; a CPU-cost fixture would sit next to it)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (the topology the reporter ran)
  - ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (line ~621: `connectionEncrypters: [noise()]`, hardcoded)
  - ../Fret/packages/fret/src/service/fret-service.ts (`MAINTENANCE_RPC_TIMEOUT_MS = 2000`, a suspect)
----

# A slow peer's crypto cost diverges into retry amplification

Reported on gotchoices/sereus#13 by `kjeib`, 2026-09-21, with a device-free reproduction.

## What they measured

They charge the Galaxy S7's measured crypto cost as a blocking busy-wait inside the Noise crypto implementation. Blocking is the right model for CPU, unlike latency. They then ran the two-party blind-relay scenario:

| fraction of S7 cost | first sync | total | crypto ops | CPU burned | result |
|---|---|---|---|---|---|
| 0 | 1.4 s | 2.8 s | — | — | pass |
| 0.10 | 1.7 s | 14.3 s | 13,572 | 9.8 s | pass |
| 0.25 | 4.4 s | 30.6 s | 19,061 | 25.4 s | pass |
| 0.50 | 26.1 s | 53.5 s | 22,038 | 48.1 s | pass |
| 1.00 | — | fails | 42,557 | 313 s | fail |

From 0.5× to 1.0× the per-operation cost doubles, but the total crypto work grows about 6.5 times. Raising the first-sync timeout from 30 s to 300 s (they set it as node config, `strandFirstSync.timeoutMs`) still failed after 313 s of CPU. So a longer timeout doesn't help: something is re-issuing work once a deadline passes.

These measurements were taken before optimystic 1.2.0 (4 `/cluster` streams per commit instead of 9). Fewer rounds should move the failure point but not remove the amplification.

## Why the phone is so slow

`@chainsafe/libp2p-noise` maps its crypto to a pure-JS build through its `browser` field, and Metro honours that mapping. So React Native runs unaccelerated JS crypto on Hermes, which has no JIT, while Node uses OpenSSL plus WASM. `@optimystic/db-p2p` hardcodes `connectionEncrypters: [noise()]`, so an app can't supply native crypto (Noise's `ICryptoInterface`). The reporter offered a PR for that option. It spans optimystic's `createLibp2pNode` and cadre-core's `buildControlNodeOptions` (`cadre-node.ts`, ~line 1431). Not started. It is the maintainer's layering call.

That option would shrink the constant. This ticket is about the divergence, which any heavily loaded device can reach.

## Do

1. Build or accept the reporter's CPU-cost fixture (they offered about 40 lines). Patch the Node crypto build, not `pureJsCrypto`: the reporter found that patching `pureJsCrypto` in Node registered zero operations.
2. Reproduce the divergence at the current optimystic floor. Find the cost fraction where it starts.
3. Count re-issued work by layer: FRET maintenance RPCs (2 s budget), optimystic cluster and repo RPC timeouts and retries, sereus first-sync and formation retries, libp2p dial and relay reservation retries. The layer whose retry count grows faster than the cost is the cause.
4. Fix at that layer. Typical fixes are backoff, not re-issuing while an earlier attempt is still in flight, or deadlines that measure the peer's progress. Don't simply raise timeouts; the reporter showed that doesn't work.
