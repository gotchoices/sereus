description: The integration test suite had the same test-setup helpers hand-copied into several scenario files; the copies are gone and everything now calls one shared version. Review the fold for silent behavior changes.
files: packages/integration-tests/src/harness/formation-mocks.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts
difficulty: medium
----

# Review: one node-config builder, one pair-construction helper, one set of formation mocks

Implemented from `tickets/implement/2-harness-one-node-config-builder.md` (2026-09-08). Every item
in that ticket's *Expected outcome* landed; nothing was deferred. The sibling ticket
`harness-fold-strand-suite-node-configs` (in `implement/`, `prereq:` on this one) folds the two
heavy strand suites onto the same harness pieces and is unblocked by this landing.

## What changed

**New `packages/integration-tests/src/harness/formation-mocks.ts`**, re-exported from
`harness/index.ts`. Holds `createMockProvisioner(prefix: string)` and `createMockUsageRecorder()`,
lifted verbatim from the scenario copies. `prefix` is now **required** — all four former copies
disagreed on their default and every call site passed one explicitly, so the defaults were dead.
`createMockUsageRecorder`'s intersection return type
(`FormationUsageRecorder & { knownTokens: Set<string>; usedTokens: Map<...> }`) is preserved
exactly; callers mutate `knownTokens` directly and that is documented at the new site.

**`node-fixtures.ts` — `startPairNodes` extracted.** Both pair fixtures now build their nodes
through one helper that takes the genesis ordering as data:

```ts
export type PairGenesisOrdering = 'genesis-before-b' | 'genesis-deferred';
export async function startPairNodes(
  partyId: string,
  ordering: PairGenesisOrdering,
  opts: { strandWatchMs?: number; started?: CadreNode[] } = {},
): Promise<StartedPairNodes>;
```

`bootPair` calls it with `'genesis-before-b'`; `bootConnectedPair` with `'genesis-deferred'` plus
its own `started` array, then does its connect / cohort wait / `makeOwnOwner` / `authorizePeer` as
before. Neither fixture's exported signature, return shape, doc comment or teardown contract
changed. The duplicated `${partyIdPrefix}-${tag}-${Date.now()}` construction became a one-line
sibling, `pairPartyId`.

**`stopStartedNodes` exported**, `console.error` prefix retargeted from `[bootConnectedPair]` to
`[stopStartedNodes]`.

**Tripwire comment at the old `node-fixtures.ts:318-323` replaced**, not deleted — it now records
that the extraction happened, names `startPairNodes` and `PairGenesisOrdering`, and says the third
fixture coming into view is what tripped the original condition.

**Four scenario files folded** onto `controlNodeConfig`. Dead imports (`MemoryRawStorage`,
`wsTransports`, `CadreNodeConfig`, `StrandProvisioner`, `FormationUsageRecorder`) dropped from each.

## The one place a reviewer should not trust the green tests

`multi-party-workflows.integration.ts` had **different defaults** from the harness helper: it
defaulted `profile` to `'storage'` and hard-coded `enableRelay: true`. Its eleven call sites pass
neither, so folding them naively onto `controlNodeConfig` would have flipped every node in the
file to a non-relaying transaction node — booting fine and testing something else. `createNodeConfig`
was therefore kept as a **delegating one-liner** that pins both:

```ts
function createNodeConfig(partyId: string, opts: { bootstrapNodes?: string[] } = {}): CadreNodeConfig {
	return controlNodeConfig({ partyId, profile: 'storage', enableRelay: true, ...opts });
}
```

Verified before the fold that no call site passes `profile` (`grep -n "createNodeConfig"` — 11 call
sites, all `partyId` only or `partyId` + `bootstrapNodes`), so dropping `profile` from the opts type
removed a dead parameter rather than a used one. **Worth re-checking by hand**: the whole ticket
exists because this class of change passes its tests while proving something different.

## Re-read rather than trust

- **The genesis ordering.** `startPairNodes` computes `ownerPublicKey` (via `makeOwnOwner`) between
  `A.start()` and `new CadreNode(...)` for B, so under `'genesis-before-b'` the owner-key write
  still lands while A is alone, and under `'genesis-deferred'` no genesis happens in the helper at
  all — `bootConnectedPair` still does it after its two-machine cohort wait. Confirm by reading
  `node-fixtures.ts` around `startPairNodes`, `bootPair` and `bootConnectedPair`; the
  write-while-alone scenarios would stay green if this collapsed.
- **Failure-path teardown.** `started?.push(node)` fires immediately after each `start()`, so a
  throw inside `startPairNodes` after A starts still leaves A in `bootConnectedPair`'s array. Not
  exercised by any test — the 30 s cohort wait is the real failure window and nothing forces it.
- **`listenAddrs: []`.** `convergence-stress` and `websocket-chat` give the phone an empty listen
  list to model a dial-only client. `controlNodeConfig` uses `opts.listenAddrs ?? [...]`, so `[]`
  survives; a comment at the `convergence-stress` site now says so. Both files pass, but neither
  asserts the phone has no listener, so the green run is not itself proof.
- **`StartedPairNodes.bKey` is returned but unused** by both current fixtures. It is in the
  interface because `harness-topology-builder` names it; flagging it so it does not read as an
  oversight.

## Validation — commands run, all green

```
yarn workspace @serfab/cadre-core build                    # exit 0
yarn workspace @serfab/integration-tests typecheck         # exit 0 (run after each file's fold)
yarn lint                                                  # exit 0
```

```
yarn workspace @serfab/integration-tests test src/scenarios/rbac-signed-write.integration.ts
  → 1/1 passed, 35.3 s

yarn workspace @serfab/integration-tests test src/scenarios/multi-party-workflows.integration.ts
  → 5/5 passed, 36.8 s

yarn workspace @serfab/integration-tests test \
  src/scenarios/convergence-stress.integration.ts \
  src/scenarios/websocket-chat.integration.ts
  → 4/4 passed, 58.5 s

yarn workspace @serfab/integration-tests test \
  src/scenarios/control-db-two-node-convergence.integration.ts \
  src/scenarios/control-write-while-alone-convergence.integration.ts \
  src/scenarios/control-divergent-repair-yardstick.integration.ts \
  src/scenarios/strand-unpublish-sibling-convergence.integration.ts \
  src/scenarios/strand-formation-concurrent-redemption.integration.ts
  → 8/8 passed, 51.2 s
```

Nine scenario files, 18 tests, all passing. No pre-existing failures surfaced; nothing skipped or
loosened. `grep -rln "bootPair\|bootConnectedPair" packages/integration-tests/src/scenarios/`
returns exactly the five files in the last batch, so every caller of the extraction ran.

## Known gaps — the tests are a floor, not a ceiling

- **No test asserts the produced config directly.** Byte-identity of `controlNodeConfig`'s output
  against the deleted literals was established by reading both, plus the suites passing. A unit
  test over `controlNodeConfig`'s output (default path, `listenAddrs: []`, `enableRelay: false`)
  would turn that reading into a guard. Not filed — it belongs with the harness-wide test debt, and
  `harness-topology-builder` will add more surface to cover at once.
- **`startPairNodes` has no direct test**; it is covered only transitively through the two fixtures.
  The `started` array's failure path is not covered at all.
- **The scenario folds were verified per-file** (typecheck + that file's suite) before moving on, as
  the ticket asked — but a positional-to-object conversion that drops an option produces a passing
  test, so the diff is the evidence here, not the run.
- **Two `createMockProvisioner` copies remain** in `strand-formation-e2e.integration.ts` and
  `strand-membership-closed-strand-e2e.integration.ts`, plus one `createMockUsageRecorder` copy in
  the former. In scope for `harness-fold-strand-suite-node-configs`, deliberately untouched here.

## Tripwires recorded

None new. The one existing tripwire in scope — the "if a THIRD pair fixture lands, extract a shared
node-construction helper" note at `node-fixtures.ts` — had tripped, so it was acted on and its
comment replaced with a record of the extraction rather than deleted.
