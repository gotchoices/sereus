description: The database library is gaining its own "how slow is the slowest link" setting, from which it sizes all of its network time limits. Once that is released, Sereus should hand it the value a deployment already declares, instead of setting the library's limits one by one, and drop the workarounds that exist only because the library's 3-second limit could not be changed.
files: packages/cadre-core/src/link-budget.ts, packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions), packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime), packages/quereus-plugin-sereus/src/cluster-size.ts (COHORT_READ_DEADLINE_MS), packages/*/package.json (@optimystic/* floor), docs/cadre-consistency.md
----
# Pass the declared link round trip to optimystic's `NodeOptions.linkRoundTripMs`

## Unblocked (2026-09-29): `@optimystic/*` 1.8.0 is on npm

1.8.0 carries:
- 7ac3a0e5, ce5a0068: `NodeOptions.linkRoundTripMs`;
- e40ad2a5, e1849462: cohort consults bounded only by `cohortQueryTimeoutMs`;
- the three other sereus-requested changes below.

`report-request-dial-deadline-cuts-cohort-consults-on-open-connections-to-optimystic` is closed; its fix shipped here.

## What landed upstream (per optimystic-tend, 2026-09-29)

- `NodeOptions.linkRoundTripMs`: the worst round trip between any two nodes, relayed hops included. Optimystic derives every dial, response, connection and cohort-query deadline from it, each floored at its current default. `connectionManager.dialTimeout` and `inboundUpgradeTimeout` still override when set.
- The hidden 3 s RPC dial deadline no longer bounds a cohort consult on an open connection.
- Also in that range, relevant to sereus: re-attach over a partial replica (a node that remembers peers no longer treats itself as alone and serves missing blocks as absent), and a refresh after a refused write demanding the confirmed revision (bears on `blocked/forked-control-collection-sync-livelocks`).

Also in 1.8.0, from the same request:
- catch-up from a stale replica: a multi-block read consults the cohort for all blocks at once (02b46fc1, 560ee381), and the coordinator no longer asks the reader for its own copy during read repair (98908f92, 329dd5fe). The speedup on relayed links is estimated upstream, not measured; step 4 settles it.
- a read prefers its own copy when it holds the block (4dadc2d5, 5c2ed7c4).

## Do

1. Raise the `@optimystic/*` floor to `^1.8.0` (`yarn upgrade:optimystic`), then `yarn check`. Commit, then `yarn check:published`, which tests against npm and refuses a dirty tree.
2. Pass `resolveLinkRoundTripMs(config.network?.linkRoundTripMs)` as `NodeOptions.linkRoundTripMs` for the control node and every strand node.
3. Remove what that makes redundant. Keep anything that sizes cadre's own deadlines. Candidates:
   - the explicit `connectionManager.dialTimeout` / `inboundUpgradeTimeout` pass-through, since optimystic now derives them from the same number;
   - a hand-set `cohortQueryTimeoutMs`, if optimystic's derivation matches `cohortReadDeadlineMs`.

   Check each against `docs/cadre-consistency.md`'s deadline ladder; the upstream deadlines must still nest inside cadre's.
4. Re-run the fresh-join and restart arms of `strand-reattach-first-sync-measure.integration.ts` at 1500 ms one-way, as before. Declined reads should no longer be spaced 3.00–3.02 s apart, consults should complete, and the stale-replica catch-up should be faster than before. Record the numbers against the previous ones in the ticket, and update `link-budget.ts`'s "What still fails" and the first-sync bands in `strand-first-sync-gate.ts` if they moved.
5. Re-check `blocked/forked-control-collection-sync-livelocks` against the revision-floor change; unblock it if it now converges.
6. Release note: sereus now forwards `network.linkRoundTripMs` to optimystic.
