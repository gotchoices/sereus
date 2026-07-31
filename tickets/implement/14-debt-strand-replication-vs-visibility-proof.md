----
description: Our two-node tests prove one machine can see the other's data, but not that it actually holds a copy. Add a test that looks directly inside the second machine's own storage and proves the data is physically there.
prereq:
files: packages/integration-tests/src/harness/block-store-probe.ts (new), packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts
difficulty: medium
----

## What this proves, and why the current tests do not

Every cross-node assertion in `strand-membership-closed-strand-e2e.integration.ts`
reads the *second node's database* and checks a row is there. That is visibility, not
storage. The read path explains why:

- `NetworkTransactor` picks one **coordinator peer per block** via
  `keyNetwork.findCoordinator` (`optimystic/packages/db-core/src/transactor/network-transactor.ts:737`).
- The chosen coordinator answers from **its own** local storage first —
  `CoordinatorRepo.get` reads `storageRepo.get(...)` and only consults the cohort when
  the block is missing locally or read-repair says stale
  (`optimystic/packages/db-p2p/src/repo/coordinator-repo.ts:278-346`).

So when the coordinator for a block resolves to the authoring node, the other node's
`select` is answered entirely out of the author's storage. Nothing needs to live on the
reader for the assertion to pass.

We believe every block lands on both nodes of a two-node strand — breadth is
`DEFAULT_STRAND_CLUSTER_SIZE` = 4 (`packages/quereus-plugin-sereus/src/cluster-size.ts:138`)
and the cohort is capped at the peers actually serving the strand. This ticket makes
that a **measured** claim instead of a believed one.

## Chosen technique: read the second node's raw block store

The plan ticket offered two techniques. **Read the raw storage directly** is chosen.
Rationale, so nobody re-litigates it:

- **No production change is needed.** `CadreNodeConfig.storage.provider` is already a
  per-scope factory. It is invoked as `provider('control')` in
  `packages/cadre-core/src/cadre-node.ts:943-946` and as `provider(strandId)` via
  `resolveStrandStorage` in `packages/cadre-core/src/strand-instance-manager.ts:132`
  (call site line 254). A test can therefore capture each node's **strand-scoped** store
  by scope key, with control-database blocks cleanly excluded.
- **The storage API already exposes everything required.** The scenarios pass
  `MemoryRawStorage`, which is a `KvRawStorage` over `MemoryStoreDriver`
  (`optimystic/packages/db-p2p/src/storage/kv-raw-storage.ts`,
  `.../memory-store-driver.ts`). `MemoryStoreDriver` implements `listBlockIds`, so
  `KvRawStorage` wires the optional `listBlockIds(): AsyncIterable<BlockId>` through.
  `getMetadata(blockId)` returns
  `BlockMetadata = { ranges: RevisionRange[]; latest?: { rev: number; actionId: ActionId } }`
  (`.../storage/struct.ts:10`). `getMaterializedBlock` and `getTransaction` give the
  block content.
- **Stopping the author is slower and proves no more.** Because reads are local-first, a
  surviving read after shutdown succeeds exactly when the block is already in local
  storage — the same fact the probe reads directly, but paid for with dial timeouts and
  the 1 s-per-peer latest-query budget in `queryClusterForLatest`. The comparable
  post-shutdown case in `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts:452`
  measured 43–48 s wall-clock on a dev box and carries a 120 s budget for that reason.
  The coupling-to-internals cost of the probe is the cheaper trade.

### The confound this design must avoid

A read on the joiner can *itself* pull a block into the joiner's local store:
`CoordinatorRepo.restoreCorroborated` calls `acquireBlockFromCohort`, which persists via
`saveReplicatedBlock` (`coordinator-repo.ts:487-524`). So probing a store after the test
has already read that data through the joiner's database proves only "the bytes are here
now", not "replication put them here".

**Therefore the new test must never issue a read against `joinerDb`.** It writes on the
founder and polls the joiner's *raw store* — never its database — so a block found there
arrived by replication, not by read-driven acquisition. This rule is load-bearing; say so
in a comment at the test, not only here.

## Interfaces

New harness module `packages/integration-tests/src/harness/block-store-probe.ts`,
re-exported from `harness/index.ts` (which is a flat `export *` barrel).

```ts
/** Every raw store a node's config handed out, keyed by the scope it was asked for. */
export interface RawStorageCapture {
	/** Pass as `storage.provider` in a CadreNodeConfig. */
	provider: (scope: string) => IRawStorage;
	/** The store created for `strandId`; throws naming the scopes seen if absent. */
	forStrand(strandId: string): IRawStorage;
	/** Every scope the provider has been asked for so far ('control' plus strand ids). */
	scopes(): string[];
}

export function captureRawStorage(factory?: () => IRawStorage): RawStorageCapture;

/** blockId -> latest committed (rev, actionId), for every block the store holds. */
export async function readBlockIndex(storage: IRawStorage): Promise<Map<BlockId, ActionRev>>;

/** What `target` is missing relative to `source`, empty when target covers source. */
export interface BlockCoverageGap {
	/** Block ids present in source, absent from target. */
	absent: BlockId[];
	/** Block ids present in target at a strictly older revision than source. */
	behind: Array<{ blockId: BlockId; sourceRev: number; targetRev: number }>;
	/** Block ids present at the right revision but with no content bytes stored. */
	metadataOnly: BlockId[];
}

export async function compareBlockCoverage(
	source: IRawStorage, target: IRawStorage
): Promise<BlockCoverageGap>;
```

Notes for the implementer:

- `listBlockIds` is **optional** on `IRawStorage`. `readBlockIndex` must throw a named
  error when it is absent, rather than reporting an empty index — an empty index makes
  every coverage assertion pass vacuously.
- Check whether `IRawStorage` / `BlockMetadata` are exported from `@optimystic/db-p2p`.
  If not, declare a minimal structural interface locally (`listBlockIds?`, `getMetadata`,
  `getMaterializedBlock`, `getTransaction`) rather than casting to `any` — the repo
  forbids type laziness.
- "Content bytes stored" means **either** `getMaterializedBlock(blockId, latest.actionId)`
  **or** `getTransaction(blockId, latest.actionId)` resolves. Both are legitimate: a block
  replicated in through `saveReplicatedBlock` lands materialized, while a block this node
  committed locally has its transform promoted into the transaction store. Requiring only
  one of the two would be a false negative.
- `compareBlockCoverage` reports; it does not assert. The test turns a non-empty gap into
  a failure whose message names the offending block ids — a bare `expect(ok).toBe(true)`
  on a replication test is useless when it fails.

## The new test

Add to `strand-membership-closed-strand-e2e.integration.ts`, as a fourth `it`, reusing
`bringUpClosedStrand` and `stopBoth`. `bringUpClosedStrand` must be extended to expose
each node's strand-scoped store; the simplest shape is to have `createTestNodeConfig`
accept a `RawStorageCapture` and to add `founderStore` / `joinerStore` to
`ClosedStrandFixture`, resolved by `capture.forStrand(formResult.strandId)` after
`addStrand`.

Shape:

- Bring up the two-node closed strand as the other tests do.
- Author writes **only on `founderDb`**: an `issueInvite` + `consumeInvite` pair (so
  `Strand.*` blocks move) and a signed `App.Items` insert (so an application block moves).
  Reuse the existing `signItem` helper.
- Poll the **joiner's raw store** until `compareBlockCoverage(founderStore, joinerStore)`
  returns an empty gap, on the shared `GATE` budget. This poll is simultaneously the
  convergence wait and the assertion.
- Non-vacuity floor, asserted explicitly and separately: the founder's block index must be
  non-empty (state a concrete minimum once you have measured it — do not assert a number
  you have not observed), and `founderStore` must not be the same object as `joinerStore`.
- Assert `capture.scopes()` for each node contains both `'control'` and the strand id, so
  a silent change to how the provider is invoked shows up as a named failure rather than
  as a store that was never populated.

## `rbac-signed-write.integration.ts` — decision: no probe

Do **not** add the probe there. Its own scope header declares replication out of scope,
and its cross-node block (lines 167-196) is explicitly a best-effort *observation* that
does not gate. Adding a physical-replication proof to a test whose deliverable is sApp
RBAC accept/reject would widen it for no coverage the closed-strand test does not already
give.

The one edit it does get: replace the "Cross-node replication is a BEST-EFFORT
observation here" comment's forward reference so it points at the closed-strand physical
proof, and drop the claim that the strand "runs in `bootstrap` (local) mode" if that is no
longer true at HEAD — verify before rewriting, and leave the code path alone either way.

## Header maintenance

The `VISIBILITY IS NOT PHYSICAL REPLICATION` paragraph in the closed-strand file header
(lines 64-71) parks this work in the backlog. Rewrite it: the visibility caveat still
holds for the three existing tests and must stay stated, but the parking pointer becomes a
pointer to the new test. Same for the inline caveat on `requireJoinerAgrees` (lines
544-550).

## Edge cases & interactions

- **Vacuous pass.** An empty founder block index, or a capture that never populated,
  makes coverage trivially satisfied. Both must fail loudly and separately from the
  coverage assertion itself.
- **Shared-instance mistake.** The two nodes build their configs independently, so each
  needs its **own** `captureRawStorage()`. A single shared capture would hand both nodes
  the same store and the test would pass for the worst possible reason. Assert the two
  strand stores are distinct objects.
- **Control scope leakage.** `provider('control')` and `provider(strandId)` must map to
  different stores. If a test ever passes a non-function `IRawStorage` as `provider`, both
  scopes collapse into one store and the comparison silently includes control blocks —
  `forStrand` should throw on a capture whose scopes look wrong rather than compare
  garbage.
- **Moving target during the poll.** The founder can gain blocks between the two reads of
  one poll iteration. Read the founder index and the joiner index **inside** the same
  iteration and compare only that snapshot; never cache the founder index across
  iterations.
- **Joiner legitimately ahead.** The joiner may hold blocks the founder does not, and may
  be at a higher revision. The assertion is one-directional coverage (`source ⊆ target` at
  `targetRev >= sourceRev`), never set equality and never revision equality.
- **Pending-only blocks.** A block whose metadata exists with no `latest` (seeded by
  `savePendingTransaction`) has no committed revision. Skip these on the source side —
  they are not yet a durability claim — and say so in a comment.
- **Read-driven acquisition.** Covered above: no read may touch `joinerDb` inside the new
  test. A future edit that adds one silently weakens the proof, so the comment must say
  what breaks.
- **`waitUntil` swallows throws.** Per the existing file header note, a probe that errors
  on every attempt reports a plain timeout. Make the final failure message re-run the
  comparison outside the wait, or carry the last gap into the thrown message, so a timeout
  says *which* blocks were missing.
- **Teardown.** Reuse `stopBoth` in a `finally`, matching the other three tests. The
  capture holds only in-memory maps and needs no cleanup, but it must not outlive the
  nodes in a module-level variable.
- **Cross-file blast radius.** `harness/index.ts` is `export *`; check the new module's
  exported names do not collide with anything already re-exported there.

## Out of scope

Changing replication breadth or cohort sizing. Proving the same property for the control
database, or at strand sizes above `DEFAULT_STRAND_CLUSTER_SIZE` where partial
replication genuinely resumes — parked as
`backlog/debt-replication-proof-above-cohort-size`.

## TODO

### Phase 1 — harness

- Add `packages/integration-tests/src/harness/block-store-probe.ts` with
  `captureRawStorage`, `readBlockIndex`, `compareBlockCoverage` and the `BlockCoverageGap`
  type, per the interfaces above.
- Resolve the `IRawStorage` / `BlockMetadata` / `ActionRev` import question against
  `@optimystic/db-p2p` and `@optimystic/db-core`; declare a local structural interface only
  if they are genuinely not exported. No `any`.
- Throw named errors for: `listBlockIds` absent, `forStrand` on an unknown scope.
- Re-export from `harness/index.ts`; confirm no name collisions.

### Phase 2 — wire the capture into the closed-strand bring-up

- Extend `createTestNodeConfig` in `strand-membership-closed-strand-e2e.integration.ts` to
  take a `RawStorageCapture` and use `capture.provider` as `storage.provider`.
- Give the founder and the joiner **separate** captures in `bringUpClosedStrand`.
- Add `founderStore` / `joinerStore` to `ClosedStrandFixture`, resolved after `addStrand`
  via `capture.forStrand(formResult.strandId)`.
- Confirm the three existing tests still pass unchanged — the capture must be a pure
  observation.

### Phase 3 — the proof test

- Add the fourth `it`, per "The new test" above: founder-only writes, poll the joiner's
  raw store on the `GATE` budget, non-vacuity floor, distinct-store assertion, scope
  assertion.
- Comment the "no read against `joinerDb`" rule at the test, with the reason
  (`acquireBlockFromCohort` would satisfy the probe for the wrong reason).
- Make the timeout path report the specific missing / behind block ids.
- Measure the actual founder block count and convergence time on a real run; put the
  observed numbers in the comment the way `GATE`'s comment does, and only then pick the
  non-vacuity minimum.

### Phase 4 — headers and the rbac note

- Rewrite the `VISIBILITY IS NOT PHYSICAL REPLICATION` header paragraph and the
  `requireJoinerAgrees` inline caveat to point at the new test instead of the backlog.
- Update the cross-node comment in `rbac-signed-write.integration.ts` to reference the
  closed-strand physical proof; verify the "bootstrap (local) mode" claim still holds at
  HEAD before restating it. No behavioural change to that file.

### Phase 5 — validate

- `yarn lint` (fully-enforced gate — every rule is `error`).
- Type-check / build the `integration-tests` package.
- Run the closed-strand scenario streamed to a log, e.g.
  `yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts 2>&1 | tee /tmp/closed-strand.log`
  from `packages/integration-tests` — never a silent redirect, the runner's idle timeout
  is 10 minutes.
- Run `rbac-signed-write.integration.ts` too, since its comment changed.
- Any failure clearly unrelated to this diff: follow the pre-existing-failure procedure
  (`tickets/.pre-existing-known.md`, then `tickets/.pre-existing-error.md`). Never skip or
  loosen a test.
