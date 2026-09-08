description: The integration test suite had the same test-setup helpers hand-copied into several scenario files; the copies are gone and everything now calls one shared version. Reviewed, three defects fixed, and the shared version now has direct unit tests.
files: packages/integration-tests/src/harness/formation-mocks.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/test/control-node-config.spec.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts
----

# One node-config builder, one pair-construction helper, one set of formation mocks

Landed 2026-09-08 (implement commit `3a7839d`), reviewed the same day. The integration suite
now has exactly one place that builds a `CadreNodeConfig` for a test node
(`controlNodeConfig`, `harness/node-fixtures.ts`), one place that builds the A/B pair
(`startPairNodes`), and one set of strand-formation mocks (`harness/formation-mocks.ts`).

## What shipped

**`harness/formation-mocks.ts`** (new, re-exported from `harness/index.ts`) holds
`createMockProvisioner(prefix)` and `createMockUsageRecorder()`. `prefix` is required — the four
former copies disagreed on their default and every call site passed one, so the defaults were
dead. `createMockUsageRecorder`'s intersection return type is preserved: callers mutate
`knownTokens` directly, so it is contract, not implementation detail.

**`startPairNodes(partyId, ordering, opts)`** extracted from the two pair fixtures, taking the
genesis ordering as data (`PairGenesisOrdering = 'genesis-before-b' | 'genesis-deferred'`).
`bootPair` and `bootConnectedPair` keep their exported signatures, return shapes and teardown
contracts. `stopStartedNodes` exported for `harness-topology-builder`.

**Five scenario files folded** onto `controlNodeConfig`: `rbac-signed-write`,
`multi-party-workflows`, `convergence-stress`, `websocket-chat` in the implement pass, plus
`control-delete-while-alone-convergence` found and folded during review. Dead imports
(`MemoryRawStorage`, `wsTransports`, `CadreNodeConfig`, `StrandProvisioner`,
`FormationUsageRecorder`) dropped from each.

**`test/control-node-config.spec.ts`** (new, 10 tests) asserts the builder's output field by
field — the guard that makes the remaining folds safe.

**Still to fold**: `strand-formation-e2e.integration.ts` and
`strand-membership-closed-strand-e2e.integration.ts`, owned by
`harness-fold-strand-suite-node-configs` (in `implement/`, unblocked by this landing).

## Review findings

**Checked**: the implement diff read before the handoff summary; each of the four folded configs
compared field by field against the literal it replaced; the genesis-ordering split across
`startPairNodes` / `bootPair` / `bootConnectedPair`; failure-path teardown on both fixtures;
resource cleanup; the new exports' consumers; a repo-wide sweep for `CadreNodeConfig` literals and
`wsTransports` callers the plan may have missed; whether any `docs/` file describes the harness
modules. Lint, typecheck and 14 test files re-run.

### Major — none

No finding rose to a new ticket. Every defect below resolved at its own site inside this pass, and
none belonged to a class needing a type change, a boundary invariant, or a generalized test beyond
the one written here.

### Minor — fixed in this pass

- **`bootPair` leaked node A on a failed boot** (`harness/node-fixtures.ts`). It had no
  `try`/`catch`, so a throw from `B.start()` or `A.authorizePeer()` returned no node handles and
  left A's libp2p node running past the test. Its sibling `bootConnectedPair` already guarded
  against exactly this and its doc comment already argued why. Pre-existing, but the extraction put
  the fix one argument away: `bootPair` now hands `startPairNodes` its own `started` array and
  calls `stopStartedNodes` on the way out. Doc comment updated to state the contract it now keeps.

- **`multi-party-workflows.createNodeConfig` spread the caller's options AFTER its pins.** The
  delegating one-liner read
  `controlNodeConfig({ partyId, profile: 'storage', enableRelay: true, ...opts })`. Today's opts
  type carries only `bootstrapNodes` so nothing can override, but the next option added there would
  silently unpin the two values the implementer identified as load-bearing — the exact failure mode
  this ticket exists to prevent, re-introduced one edit away. Pins now spread last, matching the
  precedent at `control-stream-authz.integration.ts:59`.

- **A fifth hand-rolled config literal the plan never enumerated**: `nodeOn` at
  `control-delete-while-alone-convergence.integration.ts:43-58`, a full `CadreNodeConfig` of the
  same shape as the four the ticket folded. Folded to
  `controlNodeConfig({ partyId, privateKey, profile, storageProvider: () => store })`; the
  single-store-per-node pinning that this file's restart choreography depends on is now stated in a
  comment rather than implied by a bare `() => store`. `wsTransports` import dropped. After this,
  the only remaining literals in the suite are the two owned by
  `harness-fold-strand-suite-node-configs`, plus `block-store-probe.ts` (which only mentions the
  type in prose).

- **The handoff's own admitted gap closed**: `test/control-node-config.spec.ts` asserts the
  builder's output directly instead of leaving byte-identity to a careful reading. Covers the
  default shape; that optional keys are OMITTED rather than set to `undefined` (so cadre-core's own
  defaults stand); a fresh store per scope; and the four values whose loss produces a *passing*
  test that proves something else — `listenAddrs: []`, `enableRelay: false`, a zero
  `unauthorizedRelayReservationCap`, and a pinned `storageProvider`. Also pins the
  `storageProvider` + `storageOpDelayMs` mutual-exclusion throw. This is the guard the two
  remaining strand-suite folds will lean on.

### Conditional / speculative — none

Nothing found was of the "fine now, only matters if X later" shape, so no tripwire was recorded.
The one pre-existing tripwire in scope — the note asking for a shared node-construction helper on
the third pair fixture — had tripped and was correctly acted on, its comment replaced with a record
of the extraction rather than deleted.

### Considered and left alone

- **`StartedPairNodes.bKey` and `ownerPublicKey` are returned but no caller reads them.** The
  handoff justified `bKey` by saying `harness-topology-builder` names it; that plan ticket names
  `stopStartedNodes` (`tickets/plan/3-harness-topology-builder.md:62`) but not `bKey`. Kept anyway:
  B's libp2p private key cannot be recovered from the started `CadreNode`, so a future fixture
  wanting to sign as B has no other route, and dropping it makes the helper asymmetric with the
  `aKey` that `bootConnectedPair` does use. Nothing flags it — knip is a separate `dep-check`
  script, not part of the `yarn lint` gate (`dead-code-cleanup-and-knip-gate`, backlog).

- **`startPairNodes` has no direct test and its `started` failure path is uncovered** on both
  fixtures. Forcing a `CadreNode.start()` failure needs injection the harness does not have, and
  `harness-topology-builder` re-shapes these fixtures — a test written against today's signature
  would be rewritten before it ever caught anything. Not filed; recorded here so it is not
  rediscovered as an oversight.

## Validation — commands run, all green

```
yarn workspace @serfab/cadre-core build                     # exit 0
yarn workspace @serfab/integration-tests typecheck          # exit 0
yarn lint                                                   # exit 0

yarn workspace @serfab/integration-tests test test/
  → 4 files, 43 tests passed, 18.2 s   (includes the new control-node-config.spec.ts, 10 tests)

# every caller of the extracted pair fixtures
yarn workspace @serfab/integration-tests test \
  src/scenarios/control-db-two-node-convergence.integration.ts \
  src/scenarios/control-write-while-alone-convergence.integration.ts \
  src/scenarios/control-divergent-repair-yardstick.integration.ts \
  src/scenarios/strand-unpublish-sibling-convergence.integration.ts \
  src/scenarios/strand-formation-concurrent-redemption.integration.ts
  → 5 files, 8 tests passed, 46.7 s

# the two files edited during review
yarn workspace @serfab/integration-tests test \
  src/scenarios/multi-party-workflows.integration.ts \
  src/scenarios/control-delete-while-alone-convergence.integration.ts
  → 2 files, 7 tests passed, 28.1 s

# the remaining folds, re-verified independently of the implement run
yarn workspace @serfab/integration-tests test \
  src/scenarios/rbac-signed-write.integration.ts \
  src/scenarios/convergence-stress.integration.ts \
  src/scenarios/websocket-chat.integration.ts
  → 3 files, 5 tests passed, 42.5 s
```

14 test files, 63 tests, all passing. No pre-existing failures surfaced; nothing skipped, disabled
or loosened.

## Docs

No `docs/` file enumerates the integration harness modules — `docs/testing.md` covers the
stale-build guard, lint coverage and knip, none of which this change touches — and
`packages/integration-tests` has no README. So there was nothing to bring up to date, rather than
nothing checked. The harness modules document themselves at the top of each file, and both new
surfaces (`formation-mocks.ts`, `startPairNodes`) carry that.
