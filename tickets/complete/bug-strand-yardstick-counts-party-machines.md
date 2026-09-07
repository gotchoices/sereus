description: Fixed a safety check that could make a shared workspace's data permanently unrepairable — workspaces now decline to declare a machine count instead of declaring the wrong one, and the plumbing was renamed so the wrong number is hard to pass again.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/enrolled-machine-store.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/test/cadre-node-strand-yardstick.spec.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, docs/architecture.md, docs/cadre-consistency.md
----

# Strand nodes declare no repair yardstick

## What the defect was

Commit `5321d6c` made every strand node declare `clusterPolicy.repairCorroborationClusterSize`
from `CadreNode.enrolledMachineCount()` — the count of machines enrolled in the **party**. A
strand runs only on machines whose embedding app registered its sApp config
(`CadreNode.addStrand`), so a strand shared by two machines of a three-machine party is served
by two. Optimystic's repair corroboration floor is `max(1, min(2, max(visible peers, N - 1)))`
(`quorumSize` + `corroboratorCapacity` in `db-p2p/src/cluster/quorum-restore.ts`): at `N >= 3`
it pins at two corroborators, so a strand that can only field one peer can **never repair a
block** — `cluster-fetch:no-quorum`, surfacing as reads failing with `Missing block`.
Over-declaring also makes the commit freshness window
(`CoordinatorRepo.commitQuorumRulesOutRivals`) demand approvals a smaller serving set cannot
supply.

## What landed

**Strand nodes declare nothing.** `launchStrand` and `resumeStrandRuntime` no longer pass a
machine count, so `strandClusterPolicy` returns the frozen `STRAND_CLUSTER_POLICY` itself —
the pre-`5321d6c` behavior, whose exposure is the known, upstream-tracked single-voter one
(`backlog/debt-read-repair-single-voter-corroboration`) and is strictly better than "cannot
repair at all". `CadreNode.enrolledMachineCount()` is deleted; the party count now has exactly
one consumer, the control-network record written by `refreshAuthorizedControlPeers`.

**The plumbing was renamed, not removed.** `StartStrandConfig.enrolledMachines` and
`ResumeStrandOverrides.enrolledMachines` are now `servingMachines`; `resolveRepairYardstick`
and `strandClusterPolicy` take `servingMachines`. `controlClusterPolicy` keeps
`enrolledMachines` — for the control network every enrolled machine runs the node, so the two
quantities are the same set by construction.
`backlog/feat-strand-yardstick-from-serving-machines` is the feature that will feed the strand
seam.

**Docs restated** in `docs/architecture.md` ("Replication cluster size") and
`docs/cadre-consistency.md`.

## Review findings

Reviewed the implement diff (`98cb824`) first, then the handoff. Ran `yarn lint` (clean),
`yarn typecheck` across the monorepo (clean), `yarn workspace @serfab/cadre-core test`
(109 files, 1778 passed, 1 skipped) and `yarn workspace @serfab/quereus-plugin-sereus test`
(9 files, 108 passed, 1 todo) — all green after the fixes below.

### Verified independently, not taken from the handoff

- **The failure mode is real, and the arithmetic checks out.** Read `quorumSize` /
  `corroboratorCapacity` in `../optimystic/packages/db-p2p/src/cluster/quorum-restore.ts` and
  the fallback order in `cluster/cluster-policy.ts` directly. The floor is
  `max(1, min(2, max(p, N-1)))`, and the resolver prefers `repairCorroborationClusterSize`,
  falling back to `assumedClusterSize`. Declaring 4 with one visible peer needs 2 votes from 1
  responder — unsatisfiable, exactly as claimed. Declaring nothing lands on
  `STRAND_CLUSTER_POLICY.assumedClusterSize = 2`, which yields a floor of 1 at one peer. The
  "declare nothing" choice is sound: the only lower bound a node can honestly assert about a
  strand's serving set is 1, which after the `MIN_CLUSTER_SIZE` floor declares 2 — behaviorally
  identical to declaring nothing. No better option exists without the real count.
- **`CadreNode` is the only production caller** of `startStrand` / `resumeStrand`; no reference
  app, CLI, or host passes a strand machine count. Every remaining `enrolledMachines` identifier
  in the tree is the control-network store's config key, which is correct.
- **The fix also closed an unstated divergence.** The plugin's own strand path
  (`compose-strand.ts:249`) always passed `STRAND_CLUSTER_POLICY` directly, so before this change
  a cadre-core-hosted strand node and a plugin-connected node in the same mesh applied different
  repair floors. They now agree. Tolerable either way — the yardstick is per-node — but it means
  the benefit `5321d6c` bought was only ever partial.
- **The new `cadre-node-strand-yardstick.spec.ts` is not vacuous**, by construction: the fake
  captures the literal config object `launchStrand` builds, `startConfigs` length is asserted,
  and both arms check `'servingMachines' in ...` as well as the value.

### Fixed in this pass (minor)

- **Coverage gap: the wake path had no identity assertion.**
  `strand-instance-manager-cluster-size.spec.ts` pinned `STRAND_CLUSTER_POLICY` by identity only
  on `startStrand`. `resumeStrand` rebuilds the retained config with an explicit
  `servingMachines: overrides?.… ?? launchConfig.…`, so the resumed config carries the *key* with
  an `undefined` value where the launch config had no key at all — a materially different input,
  on the path a hibernating strand walks many times a day. Added "still passes
  STRAND_CLUSTER_POLICY BY IDENTITY after a quiesce/resume with no count".
  **Mutation-checked**: with `?? 5` appended to that merge the new test fails (`clusterPolicy` no
  longer identical); the source was restored from a backup, both suites re-run green afterwards,
  and `git status` shows no stray files.
- **Factual error in `docs/architecture.md`.** The new text claimed the strand `MemberPeer` table
  "has no production writer". `registerMemberPeer` is a real exported writer with its own spec and
  an end-to-end scenario; what it lacks is a *caller* — nothing in `CadreNode` or any reference
  app registers a binding when a machine starts serving a strand. Corrected to say that, which is
  also what `backlog/feat-strand-yardstick-from-serving-machines` says.
- **A doc sentence contradicted the code at the resume seam.** `StartStrandConfig.servingMachines`
  states that omitting the field means "this node does not know", and
  `ResumeStrandOverrides.servingMachines` pointed at it — but on the resume path omitting it
  *retains* the last value (`??`) rather than clearing it. Said so on the override's doc.
- **Comment duplication at the reintroduction site.** The launch-path `NOTE:` restated the whole
  argument already carried by `StartStrandConfig.servingMachines` one hop away (13 lines). Trimmed
  to 7 that keep the "never pass the party count" warning and point at the canonical doc. The
  argument still appears in five other places (the field doc, three blocks in `cluster-size.ts`,
  the test header, and both docs files); each has a distinct audience, so they were left — but a
  future edit to this decision has to touch all of them.

### Recorded as tripwires, not tickets

- **`resumeStrand`'s override merge cannot clear the count.**
  `overrides?.servingMachines ?? launchConfig.servingMachines` lets a resume raise or lower the
  number but never say "this node no longer knows" — the direction that returns to declaring
  nothing. Moot while nothing feeds the field; it becomes real only if a future source can
  legitimately lose the count. `NOTE:` at the merge site in `strand-instance-manager.ts`.

### Filed as an arm on an existing ticket, not a new one

The site-claim grep found `backlog/feat-strand-yardstick-from-serving-machines` already owns
`strand-instance-manager.ts`, so both went there as a review arm rather than as new tickets:

- **Nothing enforces the `servingMachines` contract.** It is a public field typed `number`; an
  embedder driving `StrandInstanceManager` directly can still pass the party count. Climbing the
  architecture ladder, the guard that retires the class is a representation change — a count only
  its authenticated producer can mint, rather than a bare number — which belongs with the feature
  that produces the count, since there is nothing to guard until then.
- The clearing gap above, cross-referenced so the feature's author meets it.

### Checked and clean — nothing to report

- **Accepted-tradeoff `NOTE:`s at the touched sites**: none present, so nothing was re-filed
  against a decision a human had already made.
- **Docs**: read every file the change touches and the ones it should have. `docs/architecture.md`
  and `docs/cadre-consistency.md` are accurate after the `MemberPeer` correction;
  `docs/strands.md` and `docs/testing.md` say nothing about the yardstick and needed no edit.
- **Resource cleanup, error handling, type safety**: the diff adds no resources, no `any`, and no
  swallowed exceptions, and removes a method rather than adding one. `asKnownMachineCount`'s
  degenerate-value handling is already covered (0, -1, 2.5, NaN).
- **File size**: `cadre-node.ts` shrank; its size is already tracked by
  `backlog/debt-cadre-node-single-file-size` and this change moves in the right direction.
- **Pre-existing failures**: none surfaced. `backlog/bug-strand-join-dies-on-missing-block` shares
  the `Missing block` symptom but lives in the plugin's `networked.e2e` suite on the
  `compose-strand` path, which never declared a yardstick — unaffected either way, and already
  owned. No `tickets/.pre-existing-error.md` written.

### Known gaps carried forward, not closed here

- **No integration-level proof.** The claim is pinned at two unit seams with `createLibp2pNode`
  mocked; nothing exercises a real strand mesh and observes corroboration behavior. The original
  failure was established statically at fix stage and never reproduced live, so the fix is
  likewise not live-verified. `packages/integration-tests` has `control-divergent-repair-yardstick`
  for the control side and no strand analogue. Left as-is deliberately: a scenario proving
  "nothing is declared" over a real mesh is a large build for a property two unit seams already
  pin, and the strand serving-count feature will need that scenario anyway.
- **The absence assertions are structural, not semantic.** They pin that no count is passed, not
  why; a differently-named field reaching `strandClusterPolicy` would not fail them. The rename
  plus the field docs are the guard, and a rename is weaker than a type — which is the arm added
  to the feature ticket above.
- **`Object.keys(overrides)` is coupled to the override object's exact shape** and will need
  updating (not relaxing) when the feature adds the count back. Intentional; left alone.
- **`STRAND_CLUSTER_POLICY.assumedClusterSize` now carries both jobs on the strand path** —
  admission gate and repair floor, since nothing is declared. The comment there says so. It is the
  easiest thing for a future editor to "fix" wrongly by raising the 2; the warning is in place.
