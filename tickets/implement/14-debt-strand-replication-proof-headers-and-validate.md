description: A new test that proves one machine physically holds a copy of another's data has been written but never run. Run it, fix whatever it turns up, and update the stale comments that still say this proof does not exist.
prereq:
files: packages/integration-tests/src/harness/block-store-probe.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts
difficulty: medium
----

Continuation of `debt-strand-replication-vs-visibility-proof` (Phases 1-3 landed; this
ticket is Phases 4-5 plus whatever running the new test turns up). The original ticket was
cut short by a token budget warning before any test was executed.

## What already landed (do not redo)

**`packages/integration-tests/src/harness/block-store-probe.ts`** — new, re-exported from
`harness/index.ts`. Reads a node's raw block store directly, so a test can prove a block
physically lives on a node rather than merely being readable through it:

- `captureRawStorage(factory?)` → `{ provider, forStrand(strandId), scopes() }`. The
  `provider` is a per-scope factory suitable for `CadreNodeConfig.storage.provider`,
  memoized per scope so a strand rebuild does not silently mint a fresh empty store.
  `forStrand` throws (naming the scopes seen) on an unknown scope, on the literal
  `'control'`, and when the strand store and the control store are the same object.
- `readBlockIndex(storage)` → `Map<BlockId, ActionRev>` of every block with a committed
  `latest`. Throws `BlockStoreProbeError` when the backend has no `listBlockIds`, rather
  than reporting an empty index (which would make every coverage check pass vacuously).
  Pending-only blocks are skipped — they are not yet a durability claim.
- `compareBlockCoverage(source, target)` → `BlockCoverageGap { absent, behind,
  metadataOnly }`. One-directional (`source ⊆ target` at `targetRev >= sourceRev`), never
  set equality, never revision equality. Content counts as present if EITHER
  `getMaterializedBlock` or `getTransaction` resolves for the target's latest action.
- `blockCoverageIsComplete(gap)` and `formatBlockCoverageGap(gap)` — the latter renders
  offending block ids into an assertion/timeout message.

**`strand-membership-closed-strand-e2e.integration.ts`** —
`createTestNodeConfig` now takes a `RawStorageCapture` as its second argument;
`bringUpClosedStrand` gives the founder and the joiner **separate** captures and the
fixture exposes `strandId`, `founderStore`, `joinerStore`, `founderCapture`,
`joinerCapture`. A fourth `it` was added: founder-only writes (`issueInvite` +
`consumeInvite` + a signed `App.Items` insert), then a poll of the joiner's raw store on
the shared `GATE` budget until `compareBlockCoverage` is empty, with anti-vacuity floors
(stores distinct, both scopes seen per node, founder index size >= 2) asserted separately.
The test never reads `joinerDb` — that rule is load-bearing and commented at the test.

`yarn typecheck` in `packages/integration-tests` passes. **Nothing has been run.**

## What is left

### Phase 4 — headers and the rbac note

- The `VISIBILITY IS NOT PHYSICAL REPLICATION` paragraph in the closed-strand file header
  (search for that phrase; it ends with the parked backlog slug
  `backlog/debt-strand-replication-vs-visibility-proof`) still says the proof does not
  exist. The visibility caveat itself still holds for the three original tests and must
  stay stated — replace only the parking pointer with a pointer to the new fourth test.
- Same for the inline caveat on `requireJoinerAgrees` in the removal test ("NOTE: this
  proves the removal is VISIBLE from the second node's database, not that the block
  replicated to it — see the visibility caveat in the header").
- `rbac-signed-write.integration.ts` (~lines 170-196): the "Cross-node replication is a
  BEST-EFFORT observation here" comment forward-references ticket
  `2-integration-tests-real-control-sync-and-scenario-honesty`, which is **not** in
  `tickets/complete/` under that name — confirm what became of it rather than restating
  it. The comment also claims the strand "runs in `bootstrap` (local) mode"; that is a
  cohort-inferred mode (`selectStrandMode(explicitMode, seed.hasOtherPeers)` in
  `cadre-node.ts` `launchStrand`) and this test passes no explicit `mode`, unlike the
  closed-strand test which forces `'networked'`. **Verify before rewriting** — the test
  already logs `cross-node replication observed=<bool>`, so one run answers it. Point the
  comment at the closed-strand physical proof. No behavioural change to that file.

### Phase 5 — validate

- `yarn lint` (fully-enforced gate — every rule is `error`).
- `yarn typecheck` in `packages/integration-tests` (was clean at hand-off; re-run after
  Phase 4).
- From `packages/integration-tests`, streamed to a log — never a silent redirect, the
  runner's idle timeout is 10 minutes:
  `yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts 2>&1 | tee /tmp/closed-strand.log`
- Run `rbac-signed-write.integration.ts` too, since its comment changed.
- The three pre-existing tests in the closed-strand file must still pass unchanged — the
  capture is meant to be a pure observation.

### The risk this ticket exists to resolve

**The fourth test may legitimately fail on its first run, and that is information, not
necessarily a bug in the test.** The founder writes its bootstrap rows (`Header`,
`Member`, `Manager`) BEFORE the two strand libp2p nodes are dialled together, so those
blocks committed to a cohort of one. Whether they are ever pushed to the joiner
afterwards, or only ever fetched on demand at read time, is exactly the unmeasured
question this work exists to settle. If the gate times out naming only pre-dial blocks:

- Do **not** loosen the comparison to make it green. Either narrow the claim
  deliberately — snapshot the founder index right after bring-up and require coverage only
  for blocks that are new or advanced relative to that baseline, which still proves
  post-dial authored blocks replicate — or file the finding.
- If post-dial authored blocks also fail to land, that is a real replication finding:
  file it as a `bug-` ticket with the `formatBlockCoverageGap` output, and land the
  narrowed version of the test so the property that DOES hold is covered.
- Record whichever way it went in the review hand-off. The reviewer needs to know if the
  assertion was narrowed and why.

### Measurement the comments still owe

Phase 3 of the original ticket asked for observed numbers in the code comments, the way
`GATE`'s comment carries its measured convergence. The test already logs founder block
count, convergence time, and joiner block count. After a real run, put those observed
numbers in the anti-vacuity comment (which currently says only "far below the observed
count") and reconsider the `>= 2` floor now that a real count exists. Do not assert a
number that has not been observed.

## TODO

- Run the closed-strand scenario streamed to a log; read the
  `[closed-strand:physical]` line for the measured counts and convergence time.
- Resolve whatever the run turns up, per "The risk this ticket exists to resolve".
- Put the observed numbers into the anti-vacuity comment and revisit the `>= 2` floor.
- Rewrite the two closed-strand caveats (file header + `requireJoinerAgrees`) to point at
  the new test instead of the backlog.
- Verify the rbac cross-node comment's two claims (ticket reference, bootstrap mode)
  against a real run, then rewrite it to point at the closed-strand physical proof.
- Run `rbac-signed-write.integration.ts`.
- `yarn lint` and `yarn typecheck`.
- Pre-existing-looking failures: follow `tickets/.pre-existing-known.md` then
  `tickets/.pre-existing-error.md`. Never skip or loosen a test.
