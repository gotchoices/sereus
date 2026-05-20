---
description: Tier 2 data-convergence specs (two-tab-convergence, cross-tab-activity, disconnect-mid-session) fail on `cluster-tx:supermajority-failed` after browser-relay reservations land. Investigate whether the failure is a too-strict threshold (`ceil(3 × 0.67) = 3` on a 3-peer cluster leaves zero slack) or a real approval-counting bug in cluster-coordinator's merge step.
prereq: reference-peer-cluster-size-cli
files: ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/dist/src/repo/cluster-coordinator.js, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/distributed/two-tab-convergence.spec.ts, packages/reference-app-web/e2e/distributed/cross-tab-activity.spec.ts, packages/reference-app-web/e2e/distributed/disconnect-mid-session.spec.ts
---

## Symptom

After `web-e2e-tier2-data-convergence-relay` landed (circuit-relay
reservations now work; browsers are dialable through service peers),
the three Tier 2 data-convergence specs still fail. The failure mode
is *no longer* dial-timeout — it's:

```
cluster-tx:promise-response (×3)
cluster-tx:promise-summary
cluster-tx:promise-merge-input
cluster-tx:promise-merge-result
...
cluster-tx:supermajority-failed
coordinator-repo:pend-error
```

All three picked cluster members reply, but the merge step at
`@optimystic/db-p2p/dist/src/repo/cluster-coordinator.js:206` reports
`supermajority-failed` anyway. The browser's local commit proceeds
optimistically but no block lands on the cluster peers that tab B
later queries.

## Suspected root causes (one or more)

1. **Threshold has no slack on a 3-peer cluster.** With the default
   `superMajorityThreshold: 0.67` and `clusterSize: 3`,
   `ceil(3 × 0.67) = 3` requires every single picked peer to approve.
   When the browser itself is picked into the cluster keyspace by
   FRET (which happens ~60% of the time on a 5-peer keyspace), the
   browser approving "remote writes from itself" is a self-loop that
   may be intentionally excluded — leaving 2-of-3 effective
   approvals against a 3-required threshold.
2. **Approval-counting bug in the merge step.** The 3
   promise-responses *all* arrive (per the trace), but the merge
   reports < supermajority. Either the merge collapses duplicates
   keyed on the wrong field, or the self-approval is being silently
   dropped where it shouldn't, or the threshold rounding goes through
   the wrong code path. Worth reading
   `cluster-coordinator.ts` end-to-end with `promise-merge-input` /
   `promise-merge-result` log payloads to confirm.
3. **Cluster-size mismatch** — see `reference-peer-cluster-size-cli`.
   Browser uses 3, service peers default to 10. That alone won't
   cause the merge to fail (the picked cluster is determined per
   block), but it can cause asymmetric expectations between the
   coordinator and the responders. Worth excluding before option 1 /
   option 2.

## Acceptance

- `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"`
  reports 16/16 passing locally with the existing 3-node mesh
  fixture.
- If the fix changes the threshold behaviour (option 1) it should
  do so via a configurable knob — not by hardcoding a lower default
  globally. Probably a `superMajorityThreshold` option on
  `createLibp2pNode` / a CLI flag on `reference-peer`, with the e2e
  fixture passing `0.51` (or whatever rounds to a viable 2-of-3).
- If the fix is option 2 (counting bug), add a focused unit test in
  `@optimystic/db-p2p` that constructs a 3-promise merge with the
  exact response shape the e2e traces and asserts the supermajority
  result.

## Notes

- Diagnosis hook: `OPTIMYSTIC_E2E_DEBUG=1` set on the e2e command
  surfaces `cluster-tx:*` browser-console traces in the Playwright
  reporter — that's how the merge-input/merge-result lines above
  were captured. The browser-console capture is gated on the
  `OPTIMYSTIC_E2E_DEBUG=1` env in
  `packages/reference-app-web/e2e/distributed/_helpers.ts:48`.
- This ticket replaces the original ticket's "remaining 3 specs"
  acceptance gap; once it lands the `web-e2e-tier2-data-convergence`
  review ticket can move to complete.
