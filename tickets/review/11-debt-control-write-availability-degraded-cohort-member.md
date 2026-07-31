description: Finish the review of the test suite that measures how much a slow or unresponsive machine slows down shared-settings changes made on another machine — the code review is done and its fixes are applied, but the suite has not been re-run since.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, docs/architecture.md, tickets/fix/transactor-key-network-ignores-network-scoping.md, tickets/plan/10-integration-test-harness-helper-consolidation-remaining-files.md
difficulty: medium
----

# Review continuation: degraded-cohort-member scenario

The adversarial read-through is **done** and its inline fixes are **applied**; the run ended on
a token budget warning before the suite could be re-run. What remains is validation plus one
open coverage decision. Everything already established is recorded below so the next pass does
not repeat it.

## Already done in this review

### Read and checked

The full implement diff (`git diff c29b8fc..HEAD`): the scenario file, `harness/forced-cluster.ts`,
the harness barrel export, the `docs/architecture.md` bullets, and the spawned
`fix/control-reads-blocked-by-stalled-write` ticket. Also cross-read `harness/node-fixtures.ts`,
`plan/13-debt-harness-control-cohort-never-multi-peer`,
`plan/10-integration-test-harness-helper-consolidation-remaining-files`, and the relevant
optimystic sources (`libp2p-key-network.ts`, `libp2p-node-base.ts`, the Quereus collection
factory) to verify the diff's own claims about them.

### Fixed inline (all in the scenario file unless noted)

- **A doomed write leaked into the next case.** In the expected-failure case ("a control read
  answers locally while a write is stalled"), the stalled `authorizePeer` was joined at the
  *end* of the `try` — a line the currently-expected failure path never reaches, so the write
  was still in flight (holding the control write lock) when the next case started. The write
  is now started outside the `try` and drained in the `finally`, after `restore()` aborts the
  held streams so it settles promptly.
- **The healthy baseline case was the one case with no proof the trio was real.** A self-only
  cohort also commits sub-second, so `forced.callCount()` alone could not distinguish them.
  Added `observeClusterHandler` — the existing degradation wrapper at zero delay, i.e. a pure
  counter — and the case now asserts C actually received inbound cluster RPCs. It also logs
  its measured elapsed time, which `docs/architecture.md` cites (~0.5 s) but nothing emitted.
- **Duplicated harness helpers.** The file re-implemented `makeOwnOwner`, `wsTransports` and
  `randomPeerId` (as `freshTargetPeerId`), all of which already live in
  `harness/node-fixtures.ts` — the exact class of duplication that
  `plan/10-integration-test-harness-helper-consolidation-remaining-files` exists to remove.
  Swapped to the shared versions. The local `nodeConfig` stays, because folding it in needs the
  `trustedOwners` option that ticket 10 flags as an open decision; a comment now says so, and
  ticket 10's table gained a row for this file.
- **Header comment duplicated `forced-cluster.ts`.** Trimmed the restated
  two-key-network-instances explanation down to a pointer, keeping the parts unique to the
  scenario (why the coordinator pin changes *which* branch is measured, and why A not B).
- Added a failure message to the previously bare cohort-size assertion.

### Filed as a new ticket

`fix/transactor-key-network-ignores-network-scoping` — the production concern the implement
ticket raised. Verified: optimystic's Quereus collection factory builds the transactor's key
network as `new Libp2pKeyPeerNetwork(libp2pNode)` with **no arguments**, one line before
computing the correct protocol prefix for `RepoClient`. Consequences confirmed by reading the
constructor: no network scoping on `findCluster`/`findCoordinator`, and `clusterSize` defaults
to 16 — harmless for control (Cadre configures 16 anyway) but wrong for strands
(`DEFAULT_STRAND_CLUSTER_SIZE = 2`).

### Checked and found fine

- Restore ordering (`pinned` before `forced`, degradation before `node.stop()`), the abort
  plumbing in `delayOrAbort`/`untilAbort`, the no-unhandled-rejection handling in the degraded
  wrapper, and `afterAll` tolerating a `beforeAll` that threw part-way.
- The expected-failure case is `it.fails`, not `it.skip`, with unweakened assertions — correct
  per the pre-existing-failures rule, and it turns red if the defect is ever fixed.
- The relaxation of the approval count to `\d+/3` is right: the round count genuinely varies,
  and the parts that carry the claim (cohort of 3, `needed 3`, **0 rejections**) are still
  pinned literally.

### Validated after the edits

`tsc --noEmit -p tsconfig.typecheck.json` in `packages/integration-tests`: clean.
`npx eslint` over both touched files: clean.

## What remains

- **Re-run the suite.** It has NOT been run since the inline fixes. Expect ~180–200 s.
  ```
  cd packages/integration-tests
  yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts --reporter=verbose
  ```
  Expected outcome: **5 passed + 1 expected fail, exit 0**. The three edits that could plausibly
  move behaviour are the zero-delay observer wrapper on the healthy case (adds one macrotask per
  inbound RPC), the drain in the expected-failure case's `finally`, and the shared-helper swap
  (`makeOwnOwner` now returns the owner public key rather than the scenario deriving it
  separately — same value, different call site).
  If the run trips `Stale build detected`, rebuild the linked workspace first:
  `cd ../quereus && yarn workspace @quereus/quereus build`.
- **Decide on the uncovered coordinator branch.** `docs/architecture.md` now states that a write
  coordinated *by* the degraded node commits fast. Nothing asserts this — the coordinator pin
  deliberately excludes that branch, and the implement notes say pinning to a non-A node makes
  reads fail with `Missing block` because only A holds the genesis-era control blocks. So the
  claim is documented on the strength of a pre-pin observation. Either add a case that pins the
  coordinator to C and asserts the fast commit (if the `Missing block` problem can be worked
  around for a write-only case), or file a coverage ticket, or soften the docs bullet to say it
  is observed-not-asserted. Pick one and say which in the completion ticket.
- **Write the `complete/` ticket** with a `## Review findings` section covering everything above
  plus the run result. Note explicitly that no tripwires beyond the two the implementer already
  parked (the second-round zero-approvals `NOTE:` and the failed-write-poisoning `NOTE:`) were
  added, and that both were checked and judged correctly placed as code comments rather than
  tickets.
