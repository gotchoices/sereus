description: A new check that a lent-out machine really does save its network credentials to disk was written but never actually run; it has now been run, and it passed, so there is nothing left to build or fix.
files: packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts
difficulty: easy
---

# Verification already run — record result and close out

## What happened

Built `@serfab/cadre-core`, `@serfab/cadre-cli`, `@serfab/cadre-host`, then ran the full
`cadre-host-node-donation.integration.ts` scenario:

```
cd packages/integration-tests && yarn vitest run --reporter=verbose src/scenarios/cadre-host-node-donation.integration.ts
```

All 6 ordered steps passed, including the previously-unrun `step 6b`:

```
✓ step 2: host provisions a donated node into party P (awaiting_seed, pinned owner key) 47ms
✓ step 3: getPeer reports the donated node's real peer id + multiaddrs 2097ms
✓ step 4–5: requester mints a seed (addDrone), donated node accepts it (peersAdded ≥ 1) 590ms
✓ step 6: the donated node syncs into the requester's cadre (party P, live control peer) 9ms
✓ step 6b: the donated node persists its identity + node-local stores in its workdir 2ms
✓ step 7: terminate removes the node and marks the donation terminated 44ms

Test Files  1 passed (1)
     Tests  6 passed (6)
```

`step 6b` confirmed all three files land in the donated node's workdir as expected:

- `identity.key` on disk decodes to the same peer id the requester approved (re-spawn from
  this workdir would rejoin as the same node, not a stranger),
- a `bootstrap-peers.<party>.json` file exists,
- a `trusted-owners.<party>.json` file exists.

No defect found. No code change needed — the identity-key spawn wiring and the node's own
file-backed store creation both work as designed.

## TODO

- Confirm build (`yarn workspace @serfab/cadre-core build`, `@serfab/cadre-cli`,
  `@serfab/cadre-host`) and this scenario's test run still green (re-run if suspicious of
  drift since this ticket was filed), then hand off to review with no functional changes.
