----
description: Per-path byte accounting (bytes-over-relay) needs a libp2p metrics component wired into the optimystic node base. The connection-path observability baseline surfaces `bytesOverRelay` but leaves it null until this lands, because the stock libp2p Connection carries no byte counter and the node base (in ../optimystic) configures no metrics implementation.
prereq: relay-usage-connectivity-observability
files: ../optimystic packages/db-p2p/src/libp2p-node-base.ts, packages/cadre-core/src/diagnostics/connection-path.ts, packages/cadre-core/src/cadre-node.ts
difficulty: easy
----

## Problem

The relay-usage observability baseline (`relay-usage-connectivity-observability`) classifies connections as relayed vs direct and reports counts, but the **bytes-over-relay** number it exposes (`ConnectionPathSummary.bytesOverRelay`) stays `null`. The stock libp2p `Connection` interface has no byte counter, and the optimystic node base does not configure a libp2p `metrics` implementation, so there is nothing to read.

Knowing the *count* of relayed connections is enough to detect a stuck-on-relay state, but not enough to quantify how much actual traffic transits relays — which is the number the relay-reduction effort ultimately wants to drive toward zero.

## What this needs

- Enable a cross-platform libp2p metrics component in the optimystic node base (browser + node + RN safe). Candidates: `@libp2p/simple-metrics`, or a custom lightweight per-connection/per-transport byte tally. Whatever is chosen must not change the data path's behavior — observation only.
- Expose a per-connection or per-transport byte counter that the connection-path summarizer can read so `bytesOverRelay` becomes a real number (sum of bytes over connections classified `relayed`).
- Cross-repo: the node-base change lives in `../optimystic`; the sereus-side summarizer already reads `bytesOverRelay` defensively, so the consumer side may need only a small adapter once the counter exists.

## Use case

Field/CI diagnostics and the relay-reduction before/after: report "X% of bytes still transit relays after the settle window," not just "N relayed connections open." A connection can be classified direct yet still be the wrong transport for the volume; bytes make the cost concrete.

## Notes

This was split out of the observability baseline because it is cross-repo (optimystic node base) and not required for the stuck-on-relay signal, which is the primary failure mode the baseline must catch. Promote to plan once the optimystic metrics approach is chosen.
