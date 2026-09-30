description: The database library is gaining its own "how slow is the slowest link" setting, from which it sizes all of its network time limits. Once that is released, Sereus should hand it the value a deployment already declares, instead of setting the library's limits one by one, and drop the workarounds that exist only because the library's 3-second limit could not be changed.
files: packages/cadre-core/src/link-budget.ts, packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions), packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime), packages/quereus-plugin-sereus/src/cluster-size.ts (COHORT_READ_DEADLINE_MS), packages/*/package.json (@optimystic/* floor), docs/cadre-consistency.md
----
# Pass the declared link round trip to optimystic's `NodeOptions.linkRoundTripMs`

## Blocked on

A published `@optimystic/*` release containing optimystic main's:
- 7ac3a0e5, ce5a0068: `NodeOptions.linkRoundTripMs`;
- e40ad2a5, e1849462: cohort consults bounded only by `cohortQueryTimeoutMs`.

optimystic-tend will send the version once the maintainer cuts it. **Unblock when** that version is on npm. The same release should carry the fixes for `blocked/report-request-dial-deadline-cuts-cohort-consults-on-open-connections-to-optimystic`; close that ticket in the same pass.

## What landed upstream (per optimystic-tend, 2026-09-29)

- `NodeOptions.linkRoundTripMs`: the worst round trip between any two nodes, relayed hops included. Optimystic derives every dial, response, connection and cohort-query deadline from it, each floored at its current default. `connectionManager.dialTimeout` and `inboundUpgradeTimeout` still override when set.
- The hidden 3 s RPC dial deadline no longer bounds a cohort consult on an open connection.
- Also in that range, relevant to sereus: re-attach over a partial replica (a node that remembers peers no longer treats itself as alone and serves missing blocks as absent), and a refresh after a refused write demanding the confirmed revision (bears on `blocked/forked-control-collection-sync-livelocks`).

## Do, once unblocked

1. Raise the `@optimystic/*` floor (`yarn upgrade:optimystic`), then `yarn check` and `yarn check:published`.
2. Pass `resolveLinkRoundTripMs(config.network?.linkRoundTripMs)` as `NodeOptions.linkRoundTripMs` for the control node and every strand node.
3. Remove what that makes redundant. Keep anything that sizes cadre's own deadlines. Candidates:
   - the explicit `connectionManager.dialTimeout` / `inboundUpgradeTimeout` pass-through, since optimystic now derives them from the same number;
   - a hand-set `cohortQueryTimeoutMs`, if optimystic's derivation matches `cohortReadDeadlineMs`.

   Check each against `docs/cadre-consistency.md`'s deadline ladder; the upstream deadlines must still nest inside cadre's.
4. Re-run the fresh-join arm of `strand-reattach-first-sync-measure.integration.ts` at 1500 ms one-way. Declined reads should no longer be spaced 3.00–3.02 s apart, and consults should complete. Record the numbers in the ticket and in `link-budget.ts`'s "What still fails".
5. Re-check `blocked/forked-control-collection-sync-livelocks` against the revision-floor change; unblock it if it now converges.
6. Release note: sereus now forwards `network.linkRoundTripMs` to optimystic.
