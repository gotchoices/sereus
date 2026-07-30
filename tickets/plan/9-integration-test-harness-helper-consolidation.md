description: Several integration-test scenario files copy the same setup boilerplate (network transports, node config, authority bootstrap, peer-connection helpers); pull the shared pieces into the test harness so there is one copy to maintain.
prereq:
files: packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts, packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts
difficulty: easy
----

## Problem

The integration-test scenarios duplicate the same per-file helper functions verbatim,
which violates the repo's "Stay DRY" rule and means a fix to the test recipe (e.g. the
control-cohort connection precondition) has to be applied in N places. As of the
`push-wake-replication-backed-authorization` work this debt grew: a *second* control-DB
scenario now carries its own copy of the cohort-connect / authority-bootstrap helpers,
and the two copies have already **diverged** (`connectControlNodes` is pair-scoped in
`push-wake-e2e.integration.ts` but only checks `getConnections().length > 0` in
`control-db-two-node-convergence.integration.ts`).

The cost has since been paid for real: the "owner must vouch the reader before the reader
connects" precondition was present in one copy of `bootPair` and missing from the other two
control scenarios, which made both of those hang until timeout (`scenario-vouch-reader-before-seed`).
One shared helper would have made that a one-line fix instead of a three-file diagnosis.

Duplicated helpers observed across `packages/integration-tests/src/scenarios/`:

| helper | files |
| --- | --- |
| `wsTransports()` | push-wake, control-db-two-node-convergence, control-write-while-alone, control-cohort-auto, strand-formation, rbac-signed-write, multi-party-workflows, strand-membership-closed-strand, convergence-stress, websocket-chat |
| `createSignedSAppConfig()` | push-wake, strand-formation, rbac-signed-write, multi-party-workflows, strand-membership-closed-strand |
| `nodeConfig()` / `NodeOpts` | push-wake, control-db-two-node-convergence, control-write-while-alone, control-cohort-auto (the last adds a `reconcileMs` knob) |
| `makeOwnAuthority()` / `makeOwnOwner()` | push-wake, control-db-two-node-convergence, control-write-while-alone, control-cohort-auto |
| `randomPeerId()` | control-db-two-node-convergence, control-write-while-alone, control-cohort-auto |
| `connectControlNodes()` | push-wake, control-db-two-node-convergence, control-write-while-alone (already divergent) |
| `bootPair()` | control-db-two-node-convergence, control-write-while-alone — now byte-for-byte the same recipe (boot A as owner+storage+relay, boot B as a plain reader, `A.authorizePeer(B)`); only the party-id prefix differs |

## Desired outcome

The shared, behavior-identical helpers live once in the harness (alongside the existing
`waitForCrossNodeControlSync` / `waitForCadrePeerConverged` in `test-network.ts`, exported
through `harness/index.js`) and the scenario files import them. Where a scenario needs a
genuinely different variant (e.g. an extra `enableRelay`/`listenAddrs` knob), express it
through parameters rather than a fork. Reconcile the two `connectControlNodes` copies to
the strictly-more-correct pair-scoped version.

Constraints / acceptance:

- No behavioral change to any scenario; the full integration suite (or at least the
  touched scenarios) still passes, and lint + typecheck stay clean.
- `control-db-two-node-convergence.integration.ts` is the landed network-backing
  regression anchor — re-run it after the move to confirm it still converges.
- Keep helpers that are legitimately scenario-specific local; only hoist the verbatim
  duplicates.

This is a maintainability cleanup, not a functional change — hence backlog rather than
active work. It carries no risk to production code (test-only).
