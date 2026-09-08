description: Code-review pass for the new test helper that stands up any shape of network (several people, several machines each, optionally sharing a workspace) plus its self-test.
files: packages/integration-tests/src/harness/topology.ts, packages/integration-tests/src/harness/control-cohort.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/harness-topology.integration.ts
difficulty: medium
----

# Review: topology builder (N parties × M machines of real `CadreNode`s, with a strand-join step)

## What was built

Implemented per the plan in the original ticket (now this file's ancestor; the full spec
lived in `tickets/implement/3-harness-topology-builder.md` and was followed closely —
deviations listed below).

- **`harness/control-cohort.ts`** — extracted `waitForCohortOn(libp2p, minPeers,
  options & { label? })` from `waitForControlCohort`'s core: carried-last-error poll,
  rich timeout message (observed size, members, elapsed, budget), upfront keyNetwork
  resolution, `minPeers >= 1` validation. `waitForControlCohort` keeps its signature and
  delegates; the party-size upper-bound check stays in the wrapper. Works on any node
  built by `createLibp2pNode` — control or strand.
- **`harness/topology.ts`** (new, exported from `harness/index.ts`) —
  `bootTopology(spec)` builds N mutually-independent parties of M real `CadreNode`s
  each. Two orderings: `'genesis-first'` (production path: owner genesis →
  self-published row poll → per-member vouch-before-start → createSeed/applySeed →
  settled-outbound poll) and `'genesis-after-cohort'` (all start ownerless →
  connectControlNodes wiring → cohort barrier → genesis + vouches). `controlMesh:
  'full' | 'star'` (star = owner-only links, barrier waits owner only). Failure-path:
  every node lands in an internal list (mirrored to `spec.started`) the moment it
  starts; any throw stops everything (`stopStartedNodes`) before rethrowing. Handle:
  `parties` map, `machine(party, index)` with named throws, `nodes()` in boot order,
  idempotent `stop()`. Every boot stage is tagged (`bootTopology[party X machine k:
  stage]: …`) via the control-trio `atStage` pattern.
- **`joinStrandOn(spec)`** — free function: one shared `StrandRow`, explicit
  `addStrand` per member in order (`members[0]` founds; optional `founder`/`publish`
  flags), optional full-mesh strand wiring with both-sides-confirmed dials, cohort
  barrier at `min(members.length, DEFAULT_STRAND_CLUSTER_SIZE)` (constant imported via
  `@serfab/cadre-core`'s re-export — NOT restated). Contradiction throws: `mesh:
  'none'` + `barrier: true`; `publish` on a non-owner `members[0]`; empty/duplicate
  members.
- **`scenarios/harness-topology.integration.ts`** — self-test, 6 tests (all green,
  run twice): malformed-spec throws; degenerate 1×1 (bootPair-A surface: seed mint,
  owner-signed write, cohort of exactly self, named lookup/join throws, idempotent
  stop); genesis-first asymmetric 3+1 party shape (3-cohort on every trio machine —
  the shape `TestParty` drones can never reach — membership both ways for every
  ordered pair, no cross-party links); genesis-after-cohort at M=3 (genesis-era and
  post-boot rows read back on members); 2 parties × 2 machines with one strand across
  3 of the 4 (cross-party strand write readable both sides, left-out machine has no
  strand-scoped storage scope via `captureRawStorage`, strand peer ids differ from
  control peer ids, zero cross-party control connections); deterministic failure at
  machine 2 (unparseable listen addr → named stage in the error, exactly the 2 started
  nodes mirrored and both stopped).

## Deviations from the spec (all deliberate)

- Workspace name is `@serfab/integration-tests`, not `@sereus/...` (ticket said verify).
- `DEFAULT_STRAND_CLUSTER_SIZE` imported from `@serfab/cadre-core` (which re-exports
  `quereus-plugin-sereus`'s `cluster-size.ts`) — the package was not a direct dependency
  of integration-tests and other suites already take these constants through cadre-core.
- Validation-order nuance in `waitForControlCohort`: the party-cap check now runs
  before the core's `>= 1` check but is guarded on `Number.isInteger`, so a
  non-integer ask still gets the ">= 1" message. Both consumer suites' message
  assertions pass unchanged.
- The ticket's suggested fold of `strand-late-cadre-join`'s
  `foundStrandAlone`/`enrollNewcomer` onto the builder's internals was NOT done: that
  suite interleaves captures, event collectors attached before `start()`, and
  assertions between the recipe steps. A `NOTE:` at `topology.ts`'s `ownerGenesis`
  records the deliberate duplication (per the ticket's own fallback instruction).

## What the reviewer should probe (known gaps — tests are a floor)

- **Untested combinations**: `controlMesh: 'star'` is validated only through code
  reading — no self-test exercises it (either ordering). Same for
  `genesis-after-cohort` + `'star'`, `joinStrandOn`'s `publish: true` happy path,
  `founder: true` (closed strands), `mesh: 'none'`, and per-machine spec knobs other
  than `listenAddrs`/`storageProvider` (profile override, reconcileMs, enableRelay,
  strandWatchMs are forwarded through `controlNodeConfig`, which has its own unit
  spec, but no topology test drives them end-to-end).
- **`listenAddrs: []` (client-only machine) under `'full'` mesh** throws from
  `connectControlNodes` ("writer control node has no listen addresses") with a stage
  tag — reasonable but unproven; a scenario wanting a trio-B-style undialable machine
  must use `'star'` or wire by hand.
- **Barrier timeouts are constants** (30 s cohort, 20 s self-publish, 45 s enroll) —
  not caller-tunable per party. Fine for loopback; a future slow-CI complaint lands
  here.
- **`joinStrandOn` duplicate detection is by node identity**, so the same machine
  reached via two `TopologyMachine` objects would slip past — cannot happen through
  `bootTopology`'s own handles.

## Validation record (2026-09-08)

- `yarn workspace @serfab/integration-tests typecheck` ✓; root `yarn typecheck` ✓;
  `yarn lint` ✓.
- Self-test: 6/6, twice (~25 s of test time; the 2×2+strand case measured ~5-6 s
  against its 240 s budget — comment in the file records it).
- Full integration suite run in four chunks (prior full-run wall-clock ~814 s exceeds
  the agent's 10-minute command ceiling; chunk union = every test file, logs in
  `tickets/.logs/harness-topology-builder.chunk{2,3,4}.test.log`):
  132/132 ✓, 34/40 (see below), 63/63 ✓, 41/41 ✓.
- The 6 failures are all in `control-write-degraded-cohort-member` (5) and
  `control-cohort-edge-carries-data` (1) — both already tracked in
  `tickets/.pre-existing-known.md` (long-running degraded-cohort family /
  `cohort-unreachable` boot gate), with the same fingerprints (optimystic
  `content-digest-mismatch` validator rejections, stream resets). Not re-reported per
  the ledger's instruction; nothing in this ticket touches those paths, and the
  cohort-wrapper consumer suites pass 24/24 twice.

## Tripwires parked as `NOTE:`s

- `topology.ts` module header: parties boot sequentially — parallel bring-up is a
  future speed-up if builder time ever dominates a suite.
- `topology.ts` `ownerGenesis`: the late-join suite keeps its own copy of the
  owner-genesis/enrollment recipe on purpose (phase structure).
