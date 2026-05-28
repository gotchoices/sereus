---
description: Under the Tier-2 e2e full-sweep run, three multi-tab specs (`cross-tab-activity`, `disconnect-mid-session`, `two-tab-convergence`) fail with `StreamResetError` on the `cluster-tx:promise-response` stream during consensus broadcast — distinct from the "no valid addresses" symptom that the relay-only-peers exclusion fixed. The dial succeeds; the libp2p stream resets mid-transaction. `ClusterClient.update`'s legacy-protocol fallback then surfaces a noisy secondary `Protocol selection failed - could not negotiate /db-p2p/cluster/1.0.0` dial:fail. Repro is sequential, multi-spec sweep against the shared 3-service-peer fixture; the same specs pass in isolation.
files: ../optimystic/packages/db-p2p/src/cluster/client.ts, ../optimystic/packages/db-p2p/src/cluster/cluster-service.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts, packages/reference-app-web/e2e/distributed/global-setup.ts, packages/reference-app-web/e2e/distributed/_helpers.ts
---

## Reproduction

Run the full Tier-2 sweep, single worker:

```
OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web test:e2e
```

In the most recent baseline (after the relay-only-peers exclusion landed),
13/16 pass. The 3 failures all log the same pattern in the e2e capture
(search `/tmp/e2e-*.log` or the playwright stdout for `StreamResetError`):

```
dial:ok peer=<svc-peer> protocol=/optimystic/db-p2p/cluster-tx/1.0.0 ms=…
…
stream reset: cluster-tx:promise-response  (StreamResetError)
dial:fail peer=<svc-peer> protocol=/db-p2p/cluster/1.0.0
  code=ERR_PROTOCOL_SELECTION_FAILED
  msg=Protocol selection failed - could not negotiate /db-p2p/cluster/1.0.0
```

The same specs **pass in isolation** (`yarn workspace @serfab/reference-app-web test:e2e --grep "two-tab convergence"` — ~23s wall-clock).

## What is known

  - The dial completes; the stream is reset by the remote mid-transaction.
    This is libp2p-level, not the "no valid addresses" / addressless-cohort
    class.
  - `ClusterClient.update` falls back to the unprefixed legacy protocol
    `/db-p2p/cluster/1.0.0` on first-protocol error. The optimystic
    cluster service registers only the prefixed protocol
    (`/optimystic/db-p2p/cluster-tx/1.0.0`), so the fallback always
    surfaces `Protocol selection failed` — secondary noise, not the root
    cause.
  - Failures appear under concurrent load and after several specs have
    run against the shared service-peer fixture (spawned once in
    `global-setup.ts` and reused across specs).

## Plausible root causes to investigate (in priority order)

  1. **Relay-server stream/byte-cap regression.** The prior
     `optimystic-circuit-relay-reservation-lifetime` ticket disabled the
     libp2p default 2-min / 128 KiB reservation limit
     (`applyDefaultLimit: false`). Verify this is still wired correctly
     end-to-end for the service peers acting as relays in the e2e
     fixture. If a regression has crept in, browser-tab traffic relayed
     through a service peer would hit the cap and the relay would reset
     the stream.
  2. **yamux flow-control under concurrent in-flight cluster RPCs.**
     With multiple specs sharing the same bootstrap connection and
     multiple browser tabs writing concurrently, yamux's per-stream window
     may stall. Check yamux config on both service peers and browser tab
     transport; look for backpressure / window-update misalignment.
  3. **Accumulated FRET / peerStore state across specs.** Each test adds
     a fresh pair of browser-tab peer-ids that never get pruned during
     the mesh's lifetime. After several specs the service peers carry a
     large peerStore and FRET keyspace they didn't have at startup.
     Consider whether the per-spec teardown should also signal the
     service peers to evict the disconnected browser-tab peer-ids.

## What this ticket is NOT

  - Not "browser tabs admitted to cluster as members" — that was
    `web-e2e-tier2-exclude-relay-only-peers-from-clusters` and is
    complete. The failure mode here is different (dial succeeds, stream
    resets).
  - Not the legacy `/db-p2p/cluster/1.0.0` fallback noise itself — that
    is a known cleanup candidate, but it is a *symptom* of the primary
    failure, not its cause.

## Acceptance

  - Full Tier-2 sweep passes at 16/16 consistently (3 consecutive runs).
  - `StreamResetError` is no longer observed in the e2e capture for the
    three named specs.
  - Either the legacy `/db-p2p/cluster/1.0.0` fallback is removed from
    `ClusterClient.update`, or it is justified in a code comment why it
    must remain.
