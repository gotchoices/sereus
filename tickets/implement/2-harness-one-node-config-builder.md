description: The integration test suite keeps re-writing the same few test-setup helpers by hand in each scenario file, so a bug in one has to be found and fixed in every copy — which already happened once. Move them into the one shared file and delete the copies.
files: packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/harness/formation-mocks.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts
difficulty: medium
----

# One node-config builder, one pair-construction helper, one set of formation mocks

Promoted from `tickets/plan/2-harness-one-node-config-builder.md` (2026-09-08). The plan ticket's
scope split in two on run cost: this ticket carries every harness-side change plus the four
cheap scenario folds; `harness-fold-strand-suite-node-configs` carries the two heavy strand
suites, whose test runs are long enough to be their own agent run.

This ticket is the prerequisite for `harness-topology-builder` — that ticket needs
`stopStartedNodes` exported and needs the pair fixtures' node construction to already be a shared
helper before it adds a third fixture.

## Why

The suite has a shared helper that builds a `CadreNodeConfig` for one test node —
`controlNodeConfig` (`packages/integration-tests/src/harness/node-fixtures.ts:131`). Scenario
files nonetheless hand-write their own equivalents. That duplication already produced a real
defect in four places at once: every private copy forwarded the caller's relay flag as
`...(opts.enableRelay ? { enableRelay: true } : {})` — a truthiness test — so a caller passing
`enableRelay: false` had that `false` silently dropped and got the profile default instead, which
for a storage-profile node is relay **on**, the opposite of what was asked. The harness copy was
fixed under `control-db-bring-up-runs-before-first-connection`; the scenario copies stayed broken
and were fixed separately under `cold-start-redial-assertion-has-no-teeth`. Nothing links the
sites, so nothing would catch the next one.

The relay flag is not special. `controlNodeConfig` has since grown a connection gater, reconcile
cadence, relay addresses, pinned owner keys, hibernation, enrolled machines, a strand filter and
a caller-supplied storage provider; the private copies have none of them, so a scenario that
wants one grows another divergent copy instead of a shared improvement.

## Inventory, re-measured 2026-09-08

Two of the plan ticket's blockers are already gone: `ControlNodeOpts.storageProvider` landed with
`scenario-strand-follows-a-late-joining-cadre-node` (`node-fixtures.ts:88`, `:140`), and
`control-offline-read-after-restart.integration.ts` was folded during that ticket's review. What
is left, all under `packages/integration-tests/src/scenarios/`:

### Node-config duplication in this ticket's scope

| file | site | call sites | how it differs from `controlNodeConfig` |
|---|---|---|---|
| `rbac-signed-write.integration.ts` | `createTestNodeConfig`, `:42` | 2 (`:116`, `:119`) | nothing — a strict subset |
| `multi-party-workflows.integration.ts` | `createNodeConfig`, `:91` | 6 (`:178`, `:182`, `:279`, `:283`, `:286`, `:331`, `:334`, `:403`, `:406`, `:467`, `:470`) | **different defaults** — see the trap below |
| `convergence-stress.integration.ts` | inline `CadreNodeConfig` literals, `:157` and `:176` | 2 | nothing — strict subsets |
| `websocket-chat.integration.ts` | inline `CadreNodeConfig` literals, `:70` and `:94` | 2 | nothing — strict subsets |

The last two rows are new: the plan ticket's inventory only looked for builder *functions*, so it
missed the same duplication written as an inline object literal. They are folded here because
they are cheap (1 and 3 tests) and they are the same class.

### Formation-mock duplication

`createMockProvisioner` exists in **four** copies — `rbac-signed-write.integration.ts:33`,
`strand-formation-e2e.integration.ts:45`, `strand-membership-closed-strand-e2e.integration.ts:177`,
`multi-party-workflows.integration.ts:61`. All four bodies are identical apart from the default
`prefix` value, and **every** call site passes an explicit prefix, so the differing defaults are
dead. `createMockUsageRecorder` exists in two identical copies —
`strand-formation-e2e.integration.ts:55` and `multi-party-workflows.integration.ts:70`.

This ticket hoists both into the harness and folds the two files it already touches; the sibling
ticket folds the other two files' copies.

## The trap: `multi-party-workflows` has different defaults

`createNodeConfig` (`multi-party-workflows.integration.ts:91`) is **not** a subset of
`controlNodeConfig`. It defaults `profile` to `'storage'` (the harness helper defaults to
`'transaction'`) and hard-codes `enableRelay: true` with no way to turn it off. None of its
eleven call sites passes a profile, so all of them get a relaying storage node today.

Folding those sites onto `controlNodeConfig` naively would silently flip every node in the file to
a non-relaying transaction node — a change that boots fine and behaves differently, which is
exactly the failure mode this whole ticket exists to prevent. Keep the file's defaults by
converting `createNodeConfig` into a one-line delegation instead of deleting it:

```ts
/** Every node here is a relaying storage node; nothing else differs from the harness default. */
function nodeConfig(partyId: string, opts: { bootstrapNodes?: string[] } = {}): CadreNodeConfig {
	return controlNodeConfig({ partyId, profile: 'storage', enableRelay: true, ...opts });
}
```

That is the pattern already in the tree twice — `control-stream-authz.integration.ts:59` (pins
`strandFilter: 'none'`) and `control-offline-read-after-restart.integration.ts:55` (pins a
storage capture). A delegating one-liner is not a duplicate builder; a hand-written
`CadreNodeConfig` literal is. The *Expected outcome* below is written against that distinction.

## Second arm: node construction behind the pair fixtures

`bootPair` (`node-fixtures.ts:266`) and `bootConnectedPair` (`node-fixtures.ts:333`) duplicate
roughly eight lines of node construction, and the site carries an explicit tripwire at
`node-fixtures.ts:318-323`: *"If a THIRD pair fixture lands, extract a shared node-construction
helper that takes the ordering as its argument."* `harness-topology-builder` is that third
fixture, so the condition has tripped. Do the extraction now, while the only callers to keep green
are the two existing ones.

The ordering is load-bearing and must become a parameter, not disappear. `bootPair` performs owner
genesis on A while A is still alone, so a scenario can prove write-while-alone convergence;
`bootConnectedPair` defers genesis until both nodes are connected and both report a control cohort
of two, so every row — genesis included — is offered to a two-machine cohort and can be read back
on B. The distinction is spelled out at `node-fixtures.ts:305-316` and is what the
write-while-alone scenarios rest on.

Extract with the ordering as data, not a callback — `harness-topology-builder` will want the same
knob and a closure does not generalize to N nodes:

```ts
/** Where owner genesis lands relative to B's start — the one thing the two pair fixtures disagree on. */
type PairGenesisOrdering = 'genesis-before-b' | 'genesis-deferred';

interface StartedPairNodes {
	A: CadreNode;
	aKey: PrivateKey;
	B: CadreNode;
	bKey: PrivateKey;
	/** A's derived owner PUBLIC key — present only under `'genesis-before-b'`. */
	ownerPublicKey?: string;
}

/**
 * Build and start the A/B pair: A a relaying storage node, B a plain transaction node.
 * Pushes each node onto `started` as it starts, so a caller that owns failure-path
 * teardown can hand in its own array; pass nothing when the caller owns shutdown itself.
 */
async function startPairNodes(
	partyId: string,
	ordering: PairGenesisOrdering,
	opts?: { strandWatchMs?: number; started?: CadreNode[] },
): Promise<StartedPairNodes>;
```

`bootPair` becomes `startPairNodes(partyId, 'genesis-before-b', { strandWatchMs })` followed by its
existing `A.authorizePeer(...)`. `bootConnectedPair` becomes
`startPairNodes(partyId, 'genesis-deferred', { strandWatchMs, started })` followed by its existing
connect, cohort wait, `makeOwnOwner` and `authorizePeer`. Neither fixture's public signature,
return shape or doc comment changes; both keep their current teardown contract (`bootPair` leaves
shutdown to the caller, `bootConnectedPair` cleans up a boot that throws).

The `${partyIdPrefix}-${tag}-${Date.now()}` party-id construction is duplicated between the two as
well — fold it into the same helper or a one-line sibling, your call.

Replace the tripwire comment at `node-fixtures.ts:318-323` with a short note saying the extraction
happened, rather than deleting it silently — the next reader should not have to guess whether the
duplication was considered.

## Third arm: export `stopStartedNodes`

`stopStartedNodes` (`node-fixtures.ts:382`) is module-private and does the reverse-order teardown
any multi-node fixture needs; `harness-topology-builder` names it as a dependency. Export it, and
change its `console.error` prefix from `[bootConnectedPair]` to `[stopStartedNodes]` — once it is
shared, the old label misattributes the failure.

## Edge cases & interactions

- **Byte-identical config on the default path.** Every existing caller that passes no storage
  option must get exactly the config it gets today, including the `storageOpDelayMs` wrapper
  branch (`node-fixtures.ts:139-144`). Read the produced object, do not assume.
- **`listenAddrs: []` must survive.** Both `convergence-stress` and `websocket-chat` give their
  "phone" node an empty listen-address list to model a dial-only client.
  `controlNodeConfig` uses `opts.listenAddrs ?? [...]`, so `[]` is preserved — but confirm it,
  because a truthiness test here would silently give the phone a listener and quietly change what
  those scenarios prove.
- **Profile and relay defaults on `multi-party-workflows`.** See *The trap* above. This is the one
  fold in this ticket where a mechanical conversion produces a wrong-but-passing test file.
- **Positional-to-object conversion is where a silent behavior change hides.** A dropped or renamed
  option yields a node that boots fine and behaves differently. Convert one file at a time and run
  that file's suite before starting the next.
- **Ordering as a parameter must not collapse the two orderings.** A `bootPair` that connected
  before the caller could write would invalidate the write-while-alone scenarios while leaving them
  green — they would simply no longer test what they claim. After the extraction, re-read both
  fixtures and confirm the genesis call still sits before `B.start()` in one and after the cohort
  wait in the other.
- **Failure-path teardown must not regress.** `bootConnectedPair` is the only self-cleaning fixture
  today (`node-fixtures.ts:342-378`); its 30 s cohort wait is a real failure window and a leaked
  libp2p node outlives the run. The `started` array must still be populated as each node starts,
  not after both.
- **Dead imports are a lint failure, not a nit.** `yarn lint` is fully enforced at `error`. After a
  fold, `MemoryRawStorage`, `wsTransports`, `CadreNodeConfig`, `StrandProvisioner` and
  `FormationUsageRecorder` may all be unused in a scenario file — drop them.
- **`createMockUsageRecorder`'s return type is load-bearing.** It returns
  `FormationUsageRecorder & { knownTokens: Set<string>; usedTokens: Map<...> }` and callers mutate
  `knownTokens` directly. The hoisted version must keep that exact intersection type.
- **Make `prefix` required on the hoisted `createMockProvisioner`.** Every call site passes one
  today, and the four copies disagree on the default — carrying any one of them forward preserves
  an ambiguity for no benefit.

## Validation

Build first — `test/global-setup.ts` fails the run outright when a cadre package's `dist` predates
its `src`. Run in the foreground with no redirection so the runner's idle timer keeps getting
output; add `| tee tickets/.logs/<name>.log` only if you need to grep it afterwards.

```
yarn workspace @serfab/cadre-core build
yarn workspace @serfab/integration-tests typecheck
yarn lint
```

Then the four folded files, plus every caller of the two pair fixtures (they exercise the
extraction even though their own source does not change):

```
yarn workspace @serfab/integration-tests test \
  src/scenarios/rbac-signed-write.integration.ts \
  src/scenarios/multi-party-workflows.integration.ts \
  src/scenarios/convergence-stress.integration.ts \
  src/scenarios/websocket-chat.integration.ts

yarn workspace @serfab/integration-tests test \
  src/scenarios/control-db-two-node-convergence.integration.ts \
  src/scenarios/control-write-while-alone-convergence.integration.ts \
  src/scenarios/control-divergent-repair-yardstick.integration.ts \
  src/scenarios/strand-unpublish-sibling-convergence.integration.ts \
  src/scenarios/strand-formation-concurrent-redemption.integration.ts
```

Budget: recorded durations in `tickets/.logs/` put a three-test scenario file at roughly 100-115 s
including ~10-30 s of transform/import overhead, so each batch above is a few minutes. Files run
one at a time (`fileParallelism: false`, `vitest.config.ts:29-30`).

These suites all pass at HEAD, so any failure here is a regression from this change, not a
discovery. If one is already red before your edits, follow the pre-existing-failure procedure —
do not skip or loosen it.

## Expected outcome

- No hand-written `CadreNodeConfig` object literal remains in `rbac-signed-write`,
  `multi-party-workflows`, `convergence-stress` or `websocket-chat`. A one-line function that
  delegates to `controlNodeConfig` to pin a file-wide default is fine and expected.
- `createMockProvisioner` and `createMockUsageRecorder` live in the harness, exported from
  `harness/index.ts`, with `rbac-signed-write` and `multi-party-workflows` importing them.
- One node-construction helper behind both pair fixtures, with the genesis ordering as an argument;
  both fixtures keep their existing public signatures and teardown contracts.
- `stopStartedNodes` exported, with a label that no longer names `bootConnectedPair`.
- The tripwire comment at `node-fixtures.ts:318-323` replaced by a note recording the extraction.
- Nine scenario files green.

## TODO

### Phase 1 — harness

- Add `harness/formation-mocks.ts` with `createMockProvisioner(prefix: string)` and
  `createMockUsageRecorder()`, carrying the existing JSDoc and the recorder's intersection return
  type; export it from `harness/index.ts`.
- Extract `startPairNodes(partyId, ordering, opts?)` in `node-fixtures.ts` per the interface above;
  rewrite `bootPair` and `bootConnectedPair` on top of it without changing their signatures.
- Fold the duplicated party-id construction into the same helper.
- Replace the tripwire comment with a note that the extraction landed.
- Export `stopStartedNodes`; retarget its `console.error` label.
- `yarn workspace @serfab/integration-tests typecheck` and `yarn lint`.

### Phase 2 — cheap scenario folds, one file at a time

- `rbac-signed-write.integration.ts`: delete `createTestNodeConfig` (`:42`), convert both call
  sites to `controlNodeConfig({ partyId, ... })`; delete the local `createMockProvisioner`
  (`:33`) and import the harness one; drop dead imports; run the file.
- `multi-party-workflows.integration.ts`: convert `createNodeConfig` (`:91`) into the delegating
  one-liner that pins `profile: 'storage', enableRelay: true`; delete the local
  `createMockProvisioner` (`:61`) and `createMockUsageRecorder` (`:70`) and import the harness
  ones; drop dead imports; run the file.
- `convergence-stress.integration.ts`: replace the `droneConfig` (`:157`) and `phoneConfig`
  (`:176`) literals with `controlNodeConfig(...)` calls, keeping the phone's `listenAddrs: []`;
  drop dead imports; run the file.
- `websocket-chat.integration.ts`: same for the literals at `:70` and `:94`; run the file.

### Phase 3 — regression sweep

- Run the five pair-fixture caller suites listed under *Validation*.
- `yarn lint` and `yarn workspace @serfab/integration-tests typecheck` once more.
- Write the `review/` handoff: what folded, what did not, the exact commands run and their results,
  and anything about the ordering extraction the reviewer should re-read rather than trust.
