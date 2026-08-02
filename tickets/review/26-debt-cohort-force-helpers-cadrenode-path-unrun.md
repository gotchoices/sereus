description: Test helpers that pin a fixed set of machines for a shared write now also accept a second kind of node (a full running app instance, not just a bare test stub) — the widening type-checks and is covered by a dedicated new test, but the one scenario meant to exercise it end-to-end still can't run, because of an unrelated, already-tracked bug in a sibling library that hangs its setup before it ever reaches the widened code.
files: packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/key-network-patch.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/scenarios/control-cohort-harness-helpers.integration.ts, docs/STATUS.md, tickets/.pre-existing-known.md
difficulty: easy
----

# Review: `CohortNodeSource` widening (forceFullCohort / pinCoordinator) — static coverage solid, one scenario's runtime path stays blocked upstream

## What this ticket is

`packages/integration-tests/src/harness/forced-cluster.ts` exports two helpers,
`forceFullCohort` and `pinCoordinator`, used by integration scenarios to force a
deterministic multi-node write-consensus group and a deterministic coordinator onto a
running trio of nodes (real FRET-based cohort discovery is cold inside a test's
lifetime and would otherwise return self-only cohorts). Their node parameter type,
`CohortNodeSource` (`forced-cluster.ts:77`), was widened from accepting only
`TestCadreNode` (a bare harness stub) to also accepting `CadreNode` (the real
`@serfab/cadre-core` class) and a raw started `Libp2p`. `resolveControlLibp2p`
(`forced-cluster.ts:90-109`) discriminates the three shapes unambiguously today via
`'getControlNode' in node` (CadreNode) vs `'libp2p' in node` (TestCadreNode) vs a
peerId/getMultiaddrs duck-check (bare Libp2p) — see the doc comment there for why that
ordering is safe now and what would break it later.

## Verification performed this pass (implement stage)

- `yarn typecheck` in `packages/integration-tests`: clean, no errors.
- `yarn lint` at repo root: clean, no errors.
- `yarn vitest run src/scenarios/control-cohort-harness-helpers.integration.ts`
  (from `packages/integration-tests`): **12/12 passed**, ~13 s. This is the dedicated
  new suite for the widened helpers and covers, among the `TestCadreNode`/`Libp2p`
  cases: forcing a full cohort from harness party nodes, rejecting a node shape it
  can't recognise (naming the shape rather than forcing an empty cohort), rejecting a
  node listed twice (would silently shrink the forced cohort), the out-of-order-restore
  throw that `key-network-patch.ts` enforces (last-applied-first-restored stacking of
  `findCluster`/`findCoordinator` patches), and a bare started `Libp2p` accepted as a
  cohort source.
- Confirmed `control-write-degraded-cohort-member.integration.ts` actually calls the
  widened `CadreNode` branch: `forceFullCohort([A, B, C])` at line 401 and
  `pinCoordinator([A])` at line 406, where `A`/`B`/`C` are real `CadreNode` instances
  (constructed at lines 344/359/360). This is the one scenario meant to exercise the
  `CadreNode` arm of `CohortNodeSource` at runtime.
- That scenario's `beforeAll` still times out before reaching either call:
  `Timeout waiting for B self-publishes its CadrePeer record after 45000ms`, ~64 s in,
  all 6 cases reported skipped. Root cause is **not in this repo** — it is the same
  upstream boot-race bug already tracked in
  `tickets/blocked/transactor-key-network-ignores-network-scoping.md` (a node that races
  its own first outbound dial can elect itself coordinator for a control-DB key and
  cache that self-pick for 30 minutes; fix lives in
  `../optimystic/packages/db-p2p/src/libp2p-key-network.ts`, filed upstream as
  `../optimystic/tickets/fix/coordinator-cache-poisoned-by-boot-time-self-selection.md`).
  Already listed in `tickets/.pre-existing-known.md` (line 28) with this exact
  reconfirmation — **not re-run in this review pass**, per the pre-existing-failure
  protocol (already tracked under a `blocked/` slug; re-chasing it here would just
  reproduce a known ~64 s hang for no new information).
- `docs/STATUS.md` entry for this scenario reads `[ ]` with a note pointing at the
  blocked ticket and stating the design/coverage prose is otherwise accurate and was
  last observed green pre-regression — confirmed present and accurate, not re-edited.

## What's proven vs. not

**Proven:** the `CohortNodeSource` widening itself — type-checks, lints clean, and its
own dedicated test file is 12/12 green, covering every branch of the shared
`resolveControlLibp2p` discriminator and the `key-network-patch.ts` restore-ordering
guard except the specific combination of "real `CadreNode`, live network, full
three-node `beforeAll`".

**Not proven (and can't be, in this repo):** the `CadreNode` branch running inside an
actual multi-node scenario end-to-end — `control-write-degraded-cohort-member`'s 6 test
cases (healthy trio, 2 s per-RPC delay, never-answering member, etc.) never run,
because `beforeAll` hangs one step before the widened calls. This is a pre-existing,
already-tracked upstream blocker, not a defect introduced by the widening.

## For the reviewer

- If `../optimystic` gets rebuilt with the upstream coordinator-cache fix before this
  is picked up, re-run
  `yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts`
  fresh. A green run there is the first real runtime proof of the `CadreNode` branch —
  worth calling out explicitly if it happens, but not required to close this ticket.
- No code changes were needed or made this pass — this ticket's job was confirming the
  prior pass's claims (docs edits, `.pre-existing-known.md` entry, build state) were
  real and reproducible, which they were.
- Nothing here should be re-filed: the upstream blocker already has its ticket
  (`blocked/transactor-key-network-ignores-network-scoping`), and it already appears in
  `tickets/.pre-existing-known.md`.
