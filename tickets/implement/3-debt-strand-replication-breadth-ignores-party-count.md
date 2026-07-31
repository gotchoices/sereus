----
description: Data in a shared workspace is copied to only two machines, and any one of them being offline blocks writes for everyone. Raise the default to four, which is the smallest number that lets a write succeed while one holder is away.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/src/types.ts, packages/cadre-core/src/types.ts, docs/architecture.md, docs/cadre-consistency.md
difficulty: medium
----

# Raise the strand replication default from two to four

Supersedes the human decision ticket `replication-breadth-two-signoff` (answered: two is not
acceptable) and the engineering ticket that was waiting on it,
`debt-strand-replication-breadth-ignores-party-count`. Both are deleted; this is their merged
output.

## The decision that was taken

**`DEFAULT_STRAND_CLUSTER_SIZE` goes from 2 to 4.** Not adaptive, not derived from how many
people are in the workspace — a fixed constant, for the reasons below.

### Why four specifically

A write commits when a super-majority of the group holding the data approves, and that bar is
75% (Optimystic's `DEFAULT_SUPER_MAJORITY_THRESHOLD`, which Cadre selects by naming no
threshold at all). Rounded up, that means:

| copies | approvals needed | how many holders may be offline |
|---|---|---|
| 2 | 2 | **0** |
| 3 | 3 | **0** |
| 4 | 3 | 1 |
| 5 | 4 | 1 |
| 6 | 5 | 1 |

Four is the smallest breadth that tolerates a single absent holder. At two or three, every
write requires every holder awake — for a workspace shared between phones and laptops that is
the ordinary failure, not the rare one. Six buys no more fault tolerance than four and costs
more (see *Overfetch* below).

### Why this is also a correctness fix, not only a durability one

At breadth 2 a node that falls behind asks exactly one peer whether it is current, and
Optimystic accepts that single answer as the cluster's truth (`corroboratorCapacity` in
`../optimystic/packages/db-p2p/src/cluster/quorum-restore.ts` lowers the corroboration floor to
one when the cohort cannot hold a second voter). If that peer is also behind it honestly
reports the stale revision, the reader concludes it is current, and re-arms its repair window
forever. Measured on the control-DB replication scenario: **4 failures in 10 runs at breadth 2,
0 in 20 at breadth 3, 0 in 10 at breadth 8.** Any value above 2 lifts the floor off a single
voter. This is the same defect tracked upstream as
`backlog/debt-read-repair-single-voter-corroboration`; raising breadth removes Sereus's
*exposure* to it without fixing the underlying Optimystic behaviour.

### Why it is not derived from the member list

The obvious idea — scale the number with how many parties are in the workspace — was
considered and rejected. Four independent reasons, any one fatal:

- **Bootstrap ordering.** `Member` rows live *in* the strand database, which runs on the strand
  libp2p node, whose cluster size is frozen when that node is constructed. Reading the member
  list to configure the node requires the node to already exist. Same cycle already documented
  for the control network in `docs/architecture.md` → "Replication cluster size".
- **Open workspaces have no member list.** A founder of an open strand seats only a
  `Header(Type='o')` — no `Member` or `Manager` rows at all (see
  `packages/cadre-core/test/strand-founder-bootstrap.spec.ts`, "founder of an open strand seats
  only a Header(o)").
- **It changes, in the unsafe direction.** Someone joining pushes the count up, so a node that
  restarted derives a wider expected group than one that has not. The membership admission
  gate's confident path rejects a declared group that looks smaller than the member's own
  derived view — so the node configured *higher* is the one that refuses to vote, and the write
  fails. Growth is exactly the direction that breaks writes.
- **Members are not nodes.** A `Member` row is a party; how many machines that party runs is
  not known to the strand (cross-party peer discovery is still an open question — see
  `docs/strands.md`). Cohort width consumes machines, not parties.

The one input that *does* work is the open/closed flag, which already exists in two places and
is immutable in both: `Strand.Header.Type` (`schemas/strand.qsql`, insert-only singleton) and
`CadreControl.Strand.Type` (`schemas/control.qsql`, `NoUpdate check on update (false)`). The
control-DB copy is readable before the strand node is built, and
`strand-instance-manager.ts` already has the row in scope at the exact call site
(`config.strandRow.Type` is used a few dozen lines below `resolveStrandClusterSize`).

**Do not thread that flag through in this ticket.** Open and closed want the same breadth
today — both benefit identically from lifting the corroboration floor, and the knob that
*should* differ between them is the security floor, which is not shipped. A parameter whose two
branches are identical is speculative generality. `backlog/feat-open-strand-witness-policy`
owns that threading when it has a real branch to justify it.

## Scope

In: the constant, every doc and comment that states or justifies the old value, the plugin-side
default that must move in lockstep, and tests.

Out: `MIN_CLUSTER_SIZE` (stays 2 — it is Optimystic's validation floor, not a default),
`CONTROL_REPLICATION_BREADTH` (unchanged at 16), party-aware cohort selection
(`backlog/debt-cohort-selection-party-blind`), open-strand security posture
(`backlog/feat-open-strand-witness-policy`).

## Edge cases & interactions

- **One- and two-node strands must still write.** This is the regression that
  `bug-cluster-size-exceeds-cadre-size` was filed for. Optimystic caps a cohort at the peers
  that actually serve the network and shrinks one it cannot fill (`allowDownsize: true`, which
  the strand path passes), so a breadth of 4 on a 2-node strand must still commit. Needs
  explicit coverage at 1, 2, and 3 nodes — not assumed.
- **Both defaults must move together.** `DEFAULT_STRAND_CLUSTER_SIZE` feeds
  `resolveStrandClusterSize`, which both `cadre-core`'s `strand-instance-manager.ts` and the SQL
  plugin's `connectToStrand` / `connectToStrandBrowser` route through. If the plugin's
  `StrandConnectionOptions.clusterSize` default drifts from the cadre-core one, plugin-created
  and cadre-created nodes on the same strand disagree — the in-repo version of the divergence
  hazard this whole area exists to avoid. Verify one source of truth, not two that happen to
  match.
- **Mixed-version nodes during rollout.** A node still running breadth 2 alongside one at 4
  derives different expected groups, and the confident-path admission gate can reject on that.
  `AGENTS.md` states there is no backwards-compat obligation yet, so the answer is "restart
  every node" — but say so in the docs rather than leaving it to be discovered.
- **Four-node strand tolerating one offline holder.** This is the entire justification for the
  number; it needs a test that actually removes a cohort member and asserts the write commits,
  not just an assertion on the constant.
- **Three-party strand cohort width.** `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts`
  is where cohorts of at most two peers were originally measured, and it carries a now-stale
  comment (~line 647) saying a three-party strand uses a breadth of 2. Good place to assert the
  cohort actually widened rather than trusting the constant.
- **Overfetch.** Cohort selection asks FRET for `max(clusterSize * 4, clusterSize + 16)`
  candidates and does one peerStore protocol lookup per candidate. At 4 that is a 20-candidate
  band (was 18 at breadth 2) — negligible, and bounded by the peers FRET actually knows. Noted
  because the existing `NOTE:` in `cluster-size.ts` flags this as the place to look if cohort
  selection ever shows up as slow.
- **Hibernation resume.** `buildStrandRuntime` is shared by `startStrand` and `resumeStrand`
  and re-resolves the value on each, so a resumed strand picks up the new constant while a
  long-running peer may still hold the old one. Same situation as rollout above; no separate
  mechanism needed, but confirm resume does not read a stale cached value.
- **Downstream ticket scope narrows.** `backlog/debt-read-repair-single-voter-corroboration`
  currently names strand networks as Sereus's remaining exposure. After this lands, that is no
  longer true at the default. Narrow its scope note the way `control-db-replicates-to-whole-party`
  did — do not close it; the upstream defect is unfixed and any caller configuring 2 explicitly
  still hits it.

## TODO

- Change `DEFAULT_STRAND_CLUSTER_SIZE` from 2 to 4 in
  `packages/quereus-plugin-sereus/src/cluster-size.ts` and rewrite its docblock — the current
  text argues *for* two ("Two is the floor and inherits the read-repair weakness"), which
  becomes wrong rather than merely outdated. Record the super-majority table and the
  first-breadth-that-tolerates-one-absence reasoning.
- Confirm `resolveStrandClusterSize` and the SQL plugin's `StrandConnectionOptions.clusterSize`
  default both derive from that one constant with no second literal anywhere.
- Update the docs that state or justify the old value: `docs/architecture.md` → "Replication
  cluster size" (the `DEFAULT_STRAND_CLUSTER_SIZE` paragraph, and the two-member-cohort bullet
  whose "strand data still accepts the exposure" clause changes),
  `docs/cadre-consistency.md` (the "strand networks keep a default breadth of 2" sentence),
  `packages/cadre-core/src/types.ts`, `packages/quereus-plugin-sereus/src/types.ts`,
  `packages/quereus-plugin-sereus/README.md`.
- Update tests that assert or narrate the old value:
  `packages/quereus-plugin-sereus/test/plugin.spec.ts`,
  `packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts`,
  `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts`,
  `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts`,
  `tickets/plan/14-debt-strand-replication-vs-visibility-proof.md` (its two-node premise).
- Add coverage for the edge cases above: writes commit at 1, 2 and 3 nodes under a breadth-4
  default; a 4-node strand commits with one cohort member stopped; the three-party scenario
  shows cohorts wider than two.
- Narrow the scope note on `backlog/debt-read-repair-single-voter-corroboration`.
- Run `yarn lint` and the full test suite; both must pass.
