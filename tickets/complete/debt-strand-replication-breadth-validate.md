description: Shared workspace data now keeps four copies instead of two; the tests proving it were run, they pass, and the review tightened three of them so they would actually notice if the reasoning behind "four" stopped holding.
prereq:
files: packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/integration-tests/src/harness/control-cohort.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, docs/architecture.md, docs/cadre-consistency.md, docs/strands.md
----

# Complete: breadth-4 strand replication, validated and its tests hardened

Two earlier tickets did the work this one closes out.
`debt-strand-replication-breadth-ignores-party-count` raised `DEFAULT_STRAND_CLUSTER_SIZE`
from 2 to 4 — how many nodes hold a copy of each block of a strand's application data — and
wrote tests for it, but ran out of budget before running any of them.
`debt-strand-replication-breadth-validate` ran them: everything passed unmodified, and it
added one measured-timing comment. This review pass re-ran them, audited the whole change,
and made four small fixes.

**No product code changed in either this ticket or its predecessor.** All edits are tests,
test harness, and docs.

## What the change actually is

A strand's data used to land on 2 nodes. It now lands on 4. The reason is the commit bar: a
write commits when three quarters of the holders approve (`ceil(cohort x 0.75)`), so at 2
holders you need 2 and at 3 you need 3 — every holder must be awake for every write. 4 is the
first width where `ceil(4 x 0.75) = 3` lets a write through with one holder asleep, which for
a workspace shared between a phone and a laptop is the ordinary case rather than the rare one.
Above 4 you buy no extra fault tolerance until 8. There is a second, correctness reason: at 2
holders a node that has fallen behind has exactly one peer to ask whether it is current, and
if that peer is also behind the reader believes the stale answer forever.

Breadth is a fixed number, not a function of how many people are on the strand — so a strand
with more than 4 members still keeps 4 copies, and the members outside a given block's holder
set fetch it on demand when they read. That is deliberate for application data; only the
control database (membership, addresses, the strand list) needs a copy on every member.

## Validation

Full workspace build first — the suites are guarded against a stale `dist`.

| suite | result |
|---|---|
| `yarn build` | green, 38 s |
| `yarn lint` (workspace) | 0 errors, 6 warnings — all pre-existing, all unused-eslint-disable directives in `zz-scratch-delete-alone.integration.ts` |
| `@serfab/quereus-plugin-sereus` (`unit` + `e2e`) | 7 files, 74 passed, 1 todo — run twice, before and after this review's edits |
| `@serfab/cadre-core` | 83 files, 1313 passed, 1 skipped |
| `@serfab/integration-tests` → `strand-formation-e2e` | 12/12, run twice |
| `quereus-plugin-sereus` typecheck, `integration-tests` typecheck | clean |

The predecessor ticket additionally recorded green runs of `@serfab/cadre-host` (508 passed),
`@serfab/cadre-cli` (161 passed), `reference-app-*` (126 passed) and `check-dep-ranges` (9/9);
this review did not re-run those, as nothing in either ticket's diff reaches them.

### The four mesh tests, the risky part, re-measured

`packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts`, suite **"strand sizes under
the default breadth"**. These start real libp2p peers and dial them into a full mesh; nothing
like them existed before this work. Timings from this review's run, after the assertions were
strengthened (predecessor's three runs in parentheses):

| test | this run | predecessor runs | budget |
|---|---|---|---|
| 1-node strand commits | 2.5 s | 2.4-3.9 s | 60 s |
| 2-node strand commits | 5.7 s | 5.4-7.3 s | 60 s |
| 3-node strand commits | 8.9 s | 7.3-8.6 s | 60 s |
| 4-node strand commits after one holder stops | 45.9 s | 43.4-47.8 s | 120 s |

Consistent with the predecessor's numbers; the extra cross-peer assertions this review added
cost well under a second. 16 of 16 test executions green across four runs of the suite, no
retries, no `Failed to get super-majority` anywhere.

## Review findings

**Fixed in this pass (4).**

- **`packages/quereus-plugin-sereus/test/plugin.spec.ts` — the test that justifies the number 4
  hard-coded the number it justifies it against.** It declared `const SUPER_MAJORITY_THRESHOLD
  = 0.75` locally, so it pinned Cadre's *reasoning* to a literal rather than to Optimystic's
  actual `DEFAULT_SUPER_MAJORITY_THRESHOLD`. If that upstream constant moved, the reasoning
  behind a breadth of 4 would silently stop holding while the suite stayed green — which is
  exactly the gap the predecessor's handoff flagged as open. Now imported from
  `@optimystic/db-core`, so the existing assertions become a live tripwire on it in both
  directions: raising it above 0.75 breaks `approvalsNeeded(4) < 4`, lowering it below breaks
  `approvalsNeeded(2) === 2`. **This closes the predecessor's "no negative test at 3" gap** —
  the concern there was a silent threshold change, not the missing live test, and a live
  negative test would cost about a minute of wall clock to assert a timeout.
- **`packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts` — the mesh dial used
  `getMultiaddrs()[0]`** while every other dial in the file went through `pickLocalAddr`, which
  exists precisely because a machine with a LAN or VPN adapter advertises several addresses and
  the first is not guaranteed to be loopback. Factored `pickLocalAddr` into a `Multiaddr`-returning
  `pickLocalMultiaddr` plus a one-line string wrapper, and pointed the mesh dial at it. The
  multiaddr type is derived from `getMultiaddrs` rather than imported, so it always matches what
  that node's `dial` accepts even if two copies of `@multiformats/multiaddr` resolve.
- **`packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts` — the 1/2/3-node tests only
  ever read back from the author.** They proved the write *committed*, which the `exec` alone
  establishes, but never that any other peer could see it — so the "more members means more
  copies" half of the whole change went unasserted below 4 nodes. They now wait for every peer
  in the mesh to observe the row and assert its contents from each. The comment is honest that
  this is availability from every member, not proof of a local copy: a peer that fetched the
  block on demand also passes.
- **`packages/integration-tests/src/harness/control-cohort.ts` — `readCohort` and
  `resolveKeyNetwork` took `unknown`.** The refactor that generalised them from `TestCadreNode`
  to any libp2p node dropped the parameter type to `unknown`, which made `readCohort(42)` a
  legal call. Both call sites pass a `Libp2p`, so both signatures now say `Libp2p` and the cast
  narrowed from `unknown as NodeWithKeyNetwork` to `Libp2p & NodeWithKeyNetwork`. Type-only
  change; `integration-tests` typecheck and `strand-formation-e2e` both re-run green.

**Tripwires recorded, not filed as tickets (2).**

- The 4-node mesh test consistently spends ~45 s of its 120 s budget, essentially all of it in
  the second insert while the coordinator waits out a dial to the stopped peer. Fine today;
  only matters if a slower CI box narrows the 2.5x headroom. Parked as a `NOTE:` at the site
  (added by the predecessor, re-verified here at 45.9 s).
- `startMesh` waits on TCP connection count, not on the strand's cohort — it proves the mesh
  formed, not that every peer has been classified as serving the strand, so the cohort can
  still be narrower than the mesh for a moment after it passes. Sufficient on loopback at 1-4
  peers; the most likely source of flakiness on slower hardware or at larger sizes. Parked as a
  `NOTE:` at the site naming the stronger gate (`keyNetwork.findCluster`, what the
  integration-tests harness does in `readCohort`) and saying to switch to it rather than
  lengthen the timeout.

**Docs checked, one fix (1).** Every file the change touched was read against the new reality,
plus the ones it should have touched. `docs/architecture.md` ("Replication cluster size" — the
canonical section), `docs/cadre-consistency.md`, `packages/quereus-plugin-sereus/README.md`,
`cluster-size.ts`, `cadre-core/src/types.ts`, `strand-instance-manager.ts` and
`quereus-plugin-sereus/src/types.ts` were all correctly updated to 4 by the predecessor, and
the arithmetic they quote (`ceil(n x 0.75)` for n = 2..6, and that 5 and 6 tolerate no more
absences than 4) checks out. The one stale claim was in `tickets/.pre-existing-known.md`, which
the validate ticket had already corrected. **Fixed here:** `docs/strands.md` defines "cohort"
as *all* the nodes on a strand, while the code comments and `architecture.md` use Optimystic's
narrower sense — the nodes holding one block. A reader moving between them would silently
misread every cohort-size statement. Added a disambiguation to the glossary entry pointing at
the canonical section.

**No major findings — no new tickets filed.** The two coverage gaps that would have justified
one are gone: the silent-threshold-change gap is closed by the import above, and the "does
adding members add copies" gap is closed by the cross-peer assertions. The two remaining known
gaps are already tracked elsewhere and were deliberately not re-filed: read repair is not
directly driven by any test (`backlog/debt-read-repair-single-voter-corroboration` for the
upstream defect, `plan/14-debt-strand-replication-vs-visibility-proof` for the test), and all
timings are from a single win32 dev box with no CI or contention numbers, which is a property
of the environment rather than a defect to file.

**Pre-existing failures — aware, not re-reported.** `control-write-degraded-cohort-member` and
`control-cohort-three-node-isolation` both fail at HEAD on the same gate (node B never resolves
node C's signed address record within 45 s). The validate ticket wrote them up; the runner's
triage pass has since consumed that report and both are listed in
`tickets/.pre-existing-known.md` against `blocked/transactor-key-network-ignores-network-scoping`.
Root cause already tracked, so this review neither re-ran nor re-triaged them. Nothing was
skipped, disabled, or loosened.
