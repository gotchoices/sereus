description: Finished moving the last few integration-test scenario files off their own private copies of test setup code and onto the shared test harness, so this cleanup pass is now fully done.
prereq:
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-three-node-isolation.integration.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts
difficulty: easy
----

Continuation of an in-progress harness-consolidation sweep (`membership-connection-gater.integration.ts`
and `control-stream-authz.integration.ts` were converted in an earlier pass, before this ticket's
slug existed). This pass converted the remaining three scenario files:

- `strand-addr-seed-convergence.integration.ts` — now imports `controlNodeConfig`,
  `createSignedSAppConfig`, `makeOwnOwner`, `connectControlNodes`, `controlAddrs` from
  `../harness/index.js`. Kept only the file-local `SIMPLE_SCHEMA` constant, which is not a
  harness concern.
- `control-cohort-three-node-isolation.integration.ts` — deleted its local
  `bootTrio`/`stopTrio`/`Trio`/`TrioHandles`/`wsTransports`/`nodeConfig`/`makeOwnOwner`/
  `connectionsTo`/`hasOutboundTo`/`peerStoreAddrsFor`; now imports `bootControlTrio`,
  `stopControlTrio`, `ControlTrioHandles`, `hasOutboundTo`, `connectionsTo`, `peerStoreAddrsFor`,
  `waitUntil`, `sleep` from `../harness/index.js`.
- `control-cohort-cold-start-retry.integration.ts` — now imports `controlNodeConfig`,
  `makeOwnOwner`, `randomPeerId`, `connectionsTo` from `../harness/index.js`. Kept
  `ed25519KeyPairFromLibp2p` imported directly from `@serfab/cadre-core` (used once, for
  `pinnedKeyTrustPolicy`'s owner-key argument — not a harness helper).
- `packages/integration-tests/src/harness/control-trio.ts` — updated its file-header note to
  drop the "awaiting the harness-consolidation ticket" language, since that ticket's work now
  includes this file's own consumers.

Confirmed via grep across all five `files:` above: no leftover references to `nodeConfig`,
`wsTransports`, `CadreNodeConfig`, `MemoryRawStorage`, `webSockets`, `circuitRelayTransport`,
`TrioHandles`, `bootTrio`, or `stopTrio`.

## Validation performed

- `yarn workspace @serfab/integration-tests typecheck` — clean.
- `yarn lint` (repo-wide) — clean.
- Targeted `vitest run` over all five touched scenario files (after rebuilding `../quereus` and
  `../optimystic/packages/db-core`'s `dist`, both of which the suite's stale-build guard flagged
  as behind their `src`):

  ```
  cd packages/integration-tests && npx vitest run --reporter=verbose \
    src/scenarios/membership-connection-gater.integration.ts \
    src/scenarios/control-stream-authz.integration.ts \
    src/scenarios/strand-addr-seed-convergence.integration.ts \
    src/scenarios/control-cohort-three-node-isolation.integration.ts \
    src/scenarios/control-cohort-cold-start-retry.integration.ts
  ```

  Result: 5 files, 9 tests — 5 pass, 4 fail.
  - `membership-connection-gater.integration.ts` — 3/3 pass.
  - `control-stream-authz.integration.ts` — 2/2 pass.
  - `strand-addr-seed-convergence.integration.ts` — 1 fail (`Timeout waiting for B observes A's
    CadrePeer membership row written on A after 30000ms`).
  - `control-cohort-three-node-isolation.integration.ts` — 2/2 fail (`Timeout waiting for B's
    start-time self-registration`; `insert failed: collection default/CadrePeer/index/_uniq_5
    holds committed revision 3, but its header block read as absent`).
  - `control-cohort-cold-start-retry.integration.ts` — 1 fail (`collection default/CadrePeer
    holds committed revision 6, but its header block read as absent`).

  All three failing files are already tracked in `tickets/.pre-existing-known.md` against the
  blocked ticket `control-db-cross-node-convergence-halted` (an upstream `@optimystic/db-core`
  cross-node sync defect, confirmed present as of `optimystic` v0.18.0 — see that ticket for the
  full analysis). `control-cohort-three-node-isolation.integration.ts` is additionally tracked
  against `transactor-key-network-ignores-network-scoping`. This pass's diff only swaps which
  module a scenario imports its setup helpers from — it does not touch node bring-up, sync, or
  transport logic — so there is no mechanism by which it could cause or change these failures.
  Not a regression; not re-triaged.

  The exact error text differs slightly from earlier snapshots quoted in the blocked ticket
  (`"header block read as absent"` vs. the `SyncRetryExhaustedError` wording quoted there) — the
  blocked ticket itself documents that this failure class's surface error has shifted across
  `optimystic` versions while the underlying defect persists, so this is expected drift in
  wording, not a new failure mode.

  A full whole-suite `vitest run` was not attempted: it exceeds the ~10-minute single-command cap
  in this environment, and the change surface (import sources only, in five files) makes it very
  unlikely anything outside this set is affected. If a future pass wants that extra confirmation,
  split the full run into chunks that each fit under the cap.

## Review findings

None — this was a mechanical import-consolidation with no behavior change. All three
non-passing scenarios in the touched set fail with pre-existing, already-tracked upstream
defects (`control-db-cross-node-convergence-halted`, `transactor-key-network-ignores-network-scoping`);
the two remaining touched scenarios pass. Typecheck and lint are clean.
