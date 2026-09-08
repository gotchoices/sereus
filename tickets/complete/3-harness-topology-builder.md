description: Reviewed and finished the test helper that stands up any shape of network (several people, several machines each, optionally sharing a workspace); closed a gap that made private shared workspaces unusable through it, split the helper in two, and added the missing self-tests.
files: packages/integration-tests/src/harness/topology.ts, packages/integration-tests/src/harness/strand-join.ts, packages/integration-tests/src/harness/control-cohort.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/harness-topology.integration.ts
----

# Topology builder (N parties × M machines of real `CadreNode`s) — implemented + reviewed

## What exists now

- **`harness/control-cohort.ts`** — `waitForCohortOn(libp2p, minPeers, { label })` is the
  polling core (carried-last-error poll, rich timeout message, upfront keyNetwork
  resolution, `minPeers >= 1`); it works on ANY node `createLibp2pNode` built, control or
  strand. `waitForControlCohort(party, …)` keeps its old signature and adds only the
  party-size upper bound, which is the one thing it alone knows.
- **`harness/topology.ts`** (411 lines) — the CONTROL plane. `bootTopology(spec)` builds N
  mutually independent parties of M real `CadreNode`s. Orderings `'genesis-first'`
  (production seed-enrollment path) and `'genesis-after-cohort'` (`bootConnectedPair`
  generalized); `controlMesh: 'full' | 'star'`. Every node lands in an internal list
  (mirrored to `spec.started`) the moment it starts, and any throw stops everything before
  rethrowing. Handle: `parties`, `machine(party, index)`, `nodes()`, idempotent `stop()`.
  Every boot stage is tagged `bootTopology[party X machine k: stage]: …`.
- **`harness/strand-join.ts`** (252 lines, split out during review) — the STRAND plane.
  `joinStrandOn(spec)`: one shared `StrandRow`, explicit `addStrand` per member in order,
  optional full-mesh strand wiring with both-sides-confirmed dials, cohort barrier at
  `min(members.length, DEFAULT_STRAND_CLUSTER_SIZE)`. Open and closed strands, optional
  owner-signed `publishStrand`. Contradictory specs throw by name before any `addStrand`.
- **`scenarios/harness-topology.integration.ts`** — self-test, now 7 tests: malformed-spec
  throws; degenerate 1×1 (owner surface plus every named lookup/join throw); genesis-first
  asymmetric 3+1; genesis-after-cohort at M=3; 2 parties × 2 machines with one strand
  across 3 of the 4; `controlMesh: 'star'` + `mesh: 'none'` + `publish` + closed-strand
  founder; deterministic mid-boot failure with teardown asserted.

## Deviations from the original spec (all deliberate, all still standing)

- Workspace is `@serfab/integration-tests`, not `@sereus/…`.
- `DEFAULT_STRAND_CLUSTER_SIZE` comes through `@serfab/cadre-core`'s re-export, as other
  suites already take these constants.
- `waitForControlCohort`'s party-cap check runs before the core's `>= 1` check but is
  guarded on `Number.isInteger`, so a non-integer ask still gets the ">= 1" message.
- `strand-late-cadre-join`'s `foundStrandAlone`/`enrollNewcomer` were NOT folded onto the
  builder — that suite interleaves captures, collectors and assertions between the recipe
  steps. A `NOTE:` at `topology.ts`'s `ownerGenesis` records the deliberate duplication.

## Review findings

Read the implement diff (`40fc20c`) before the handoff summary, then every file it touched.

### Fixed in this pass (minor)

- **Closed strands were advertised but unusable.** `joinStrandOn` exposed `type: 'c'` and
  `founder: true` while hard-coding `MemberPrivateKey: null` on the shared row. A closed
  strand's row IS the party's membership secret — the founder derives its Member/Manager
  keypair from it (`strand-membership-closed-strand-e2e` mints one with
  `generateStrandMemberKey` and shares it) — so every closed strand the builder could
  produce was one nobody, founder included, could ever hold membership in, and `publish`
  wrote a keyless row that a discovering machine would launch as a different identity.
  Added `memberPrivateKey?: string` to `StrandJoinSpec`, threaded it into the row and into
  `publishStrand`, and made the two contradictions throw by name (`type: 'c'` without a
  key; a key with an open strand). Covered by the new closed-founder arm, which asserts the
  founder's `Strand.Member` key equals `strandMemberKeyPair(memberPrivateKey)`.
- **`topology.ts` carried two planes in one 593-line file.** Split at the seam its own
  banner comment already marked: control plane stays in `topology.ts` (411 lines), strand
  plane moves to `strand-join.ts` (252), re-exported from `harness/index.js` so no consumer
  changed. Largest sibling harness file is `node-fixtures.ts` at 454 (`wc -l
  packages/integration-tests/src/harness/*.ts`).
- **`meshAndBarrier` took an `alreadyLinked(i, j)` callback both call sites passed
  identically** (`(i, _j) => i === 0`). Removed: the loop now starts at `i = 1`, and the
  comment states the invariant (both orderings link every member to the owner before the
  mesh step) instead of parameterizing it.
- **Three `instance.libp2pNode!` assertions** in the mesh and barrier loops would have
  surfaced a launch regression as `Cannot read properties of undefined` from inside a dial
  loop. Replaced with `strandNodeOf(instance, strandId, label)`, which throws naming the
  machine and the status it reported.
- **`publishStrand` was the one call in `joinStrandOn` with no named wrapper** — a rejected
  owner-signed insert reached the test unattributed. Now goes through `publishFounderRow`,
  which names the strand and the machine.
- **`{@link Topology.stop}` in `strand-join.ts`** pointed at a symbol that file does not
  import; demoted to plain code formatting.

### Test coverage added (the implementer's stated gaps, closed)

The handoff listed `controlMesh: 'star'`, `mesh: 'none'`, `publish: true` and
`founder: true` as validated by code reading only. One new test now drives all four in a
single 3-machine star party (~4.7 s): it asserts each spoke holds exactly ONE control
connection (the owner) while the owner's cohort still reaches 3 — the actual difference
between 'star' and 'full', and the reason 'star' barriers on the owner alone — then runs an
unwired published open strand and a closed founder strand on that same topology. The two
new validation throws are covered in the existing degenerate-spec test.

Still uncovered, deliberately: `genesis-after-cohort` + `'star'` (the same two mechanisms,
each already covered separately; a third full boot is ~30 s of suite time for one
combination), and per-machine knobs other than `listenAddrs`/`storageProvider`
(`profile`, `reconcileMs`, `enableRelay`, `strandWatchMs` are forwarded into
`controlNodeConfig`, which has its own unit spec).

### Tripwires parked as `NOTE:`s (conditional — not tickets)

- `topology.ts` at `COHORT_BARRIER_TIMEOUT_MS` — the three barrier budgets are fixed for
  every spec, with 5-6× headroom on loopback; make them per-spec options rather than
  raising the constants globally if slower hardware ever times out on a healthy topology.
- `strand-join.ts` at `validateStrandJoinSpec` — duplicate members are detected by node
  identity, not `(party, index)`; nothing reachable today synthesizes a second handle for
  one machine, but key on the label if a scenario ever does.
- `topology.ts` at `TopologyMachineSpec.listenAddrs` (documented on the field, not tagged
  `NOTE:`) — an empty list makes a client-only machine that `controlMesh: 'full'` cannot
  wire; the throw is stage-tagged, and such a machine needs `'star'` or hand wiring.
- Kept from the implement pass: sequential party bring-up (`topology.ts` header) and the
  deliberate recipe duplication in `strand-late-cadre-join` (`ownerGenesis`).

### Checked and clean — with the reason, not a shrug

- **Failure path.** Every start pushes its node before anything else can throw;
  `stopStartedNodes` logs and continues per node, so cleanup cannot mask the original
  error; `stop()` latches, and because `stopStartedNodes` swallows, the latch cannot strand
  a live node. The self-test asserts exactly the two started nodes were mirrored and both
  stopped.
- **`waitForControlCohort` extraction.** Both consumer message assertions still hold (the
  `Number.isInteger` guard preserves the ">= 1" wording); `harness-party-control-cohort`
  passes 3/3.
- **`addStrand` re-entrancy under `publish`.** Publishing before the other members'
  explicit `addStrand` could race a same-party watcher into launching the strand first;
  `launchStrand` returns the already-tracked instance rather than double-launching
  (`packages/cadre-core/src/cadre-node.ts:4259`), so the recipe is safe in either order.
- **No cross-party control wiring** exists or is added — asserted both ways in two tests.
- **Docs.** No doc enumerates harness fixtures: `docs/testing.md` covers gates and the
  stale-build guard (its `test-harness/` hits are the repo-root build guard, a different
  thing), and `docs/architecture.md`/`docs/strands.md` describe the product, not test
  scaffolding. Nothing in the diff changes product behaviour, so no doc went stale; the
  builder's own contract lives in the two module headers.

### Filed as a ticket: none

Every finding resolved at its own site inside this pass. No finding needed an invariant, a
type change or a generalized test that could not be expressed here.

## Validation record (2026-09-08, review pass)

- `yarn lint` exit 0; root `yarn typecheck` exit 0 (includes the vitest/test-file
  type-check coverage and stale-build-guard wiring gates).
- `harness-topology.integration.ts` 7/7, run twice (~40 s each; the new star test ~4.7 s).
- `harness-party-control-cohort.integration.ts` 3/3 (the `waitForControlCohort` consumer).
- `yarn dep-check` fails at HEAD for reasons outside this diff — four undeclared test
  imports in `packages/cadre-core/test/peer-addr-book.spec.ts`. Recorded in
  `tickets/.pre-existing-error.md` for triage; not fixed here because it edits another
  package's manifest and picks version ranges.
- The full integration suite was NOT re-run in this pass: the implement pass ran it in four
  chunks (270/276, the 6 failures being the `control-write-degraded-cohort-member` and
  `control-cohort-edge-carries-data` families already in `tickets/.pre-existing-known.md`),
  and this pass changed only the topology harness and its own scenario — no product code
  and no shared fixture behaviour. A full run takes ~814 s, past the agent command ceiling.

### One operational note for the human

Partway through the review an external `git reset` landed on the working tree (visible in
`git reflog` as `reset: moving to HEAD`) and discarded this pass's tracked-file edits; the
untracked new file survived. Nothing in this session ran it. The edits were re-applied and
re-validated from scratch — the record above is from the re-applied tree. Worth knowing if
a concurrent runner or hook is issuing resets, since it can silently destroy in-flight work.
