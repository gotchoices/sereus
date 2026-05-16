description: 3/6 Tier 2 Playwright specs still fail after connectivity is restored — a write from one browser tab never lands on the other; cluster consensus likely can't form a 3-peer quorum against a single `--offline` bootstrap
prereq: web-e2e-tier2-connectivity
files: packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts, ../optimystic/packages/reference-peer/src/cli.ts
----

## Symptom

After `tickets/review/web-e2e-tier2-connectivity` lands, the Tier 2 sweep reports:

```
yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"
  ✓ Tier 2 / distributed / bootstrap persistence …                              (5.4s)
  ✓ Tier 2 / distributed / mode flip › Connect flips solo → distributed …       (5.2s)
  ✓ Tier 2 / distributed / mode flip › Disconnect snaps back to solo …          (4.9s)
  ✘ Tier 2 / distributed / two-tab convergence (README acceptance)              (32.7s)
  ✘ Tier 2 / distributed / cross-tab activity                                   (49.4s)
  ✘ Tier 2 / distributed / disconnect mid-session                               (42.9s)
  3 failed, 3 passed (2.9m)
```

All three failures share the same shape: pageA sends a message, pageB's `[data-testid="message-row"][data-message-id="<id>"]` is never visible — `toBeVisible({ timeout: 20_000 })` times out.

`connectToBootstrap` returns within seconds for both tabs, so the dial / mode-flip / connection-row plumbing is healthy. The failure is at the data layer.

## Suspected cause

The browser-side `NetworkTransactor` is constructed with `clusterSize=3` (`packages/reference-app-web/src/lib/optimystic.ts:130-165`, defaulting `clusterSize` for distributed mode). Cluster consensus inside `@optimystic/db-p2p`'s `coordinatedRepo` needs a majority of `clusterSize` peers to acknowledge a pend/commit. Against a single bootstrap peer running `--offline` (`LocalTransactor`), the cluster has at most 2 live peers (browser self + bootstrap) — likely under quorum for `clusterSize=3` — so:

- tab A's `pend` either silently waits for a quorum that never arrives (then fails on `timeoutMs: 30_000`) or commits locally without replicating to the bootstrap; and
- tab B's `get` against `coordinatedRepo` doesn't reach the bootstrap's storage even though their libp2p connections are healthy.

Verify before fixing: run the convergence spec with `localStorage.debug='libp2p:*,@optimystic/*'` in both pages and inspect the cluster-coordinator / repo logs to confirm the quorum-stall hypothesis vs. some other layer (cluster-membership, dispute service, FRET responsibility-K).

## Approach options

Two credible directions; pick after the verification above:

1. **Browser uses `clusterSize=1` against a single-node `--offline` bootstrap.** The cleanest match for the current Tier 2 fixture shape: the peer is intentionally solo-mode, so the browser should too. Either auto-detect (count of bootstrap peers in NodeOptions) or expose a setting on the Network panel. Risk: breaks the README two-tab acceptance scenario semantics — two tabs against the same bootstrap would each form a 1-peer cluster but talk to the same underlying storage, so convergence would still work via remote repo calls. Acceptable.
2. **Run the fixture as a real 3-node mesh** instead of `--offline`. Drop `--offline` from the fixture spawn and bring up two extra `service` nodes the browser can dial alongside the primary. Heavier (orchestration in `e2e/global-setup.ts`, mesh-ready coordination, port allocation) and only motivated if browsers should always assume `clusterSize≥3`. Probably overkill for the convergence acceptance test.

Option 1 is the lighter fix; option 2 buys a more realistic stress surface for later. Recommend option 1 with a follow-up plan ticket for option 2 if/when multi-node browser testing becomes a goal.

## Acceptance

- All 6 Tier 2 specs pass on a clean checkout (with the optimystic siblings rebuilt).
- The README "Two-tab convergence test" still tells a coherent story for a human running the demo locally — no surprise additional steps unless the chosen approach genuinely requires them.
- No regression in Tier 1 (10/10) or in the now-passing Tier 2 mode-flip + bootstrap-persistence specs.

## Risk notes

- The browser's `NetworkTransactor` `timeoutMs` is currently 30s (`packages/reference-app-web/src/lib/optimystic.ts:63`). If the quorum-stall hypothesis is correct, the test wait windows (20s in `two-tab-convergence`) may be tripping a different layer's timeout first — adjust the diagnostic recipe accordingly.
- Whatever path is chosen, do **not** revert the `connectionGater` change from the prereq ticket — that fixed the lower-level dial denial and is required for any Tier 2 work.
