----
description: A safety check that decides whether a machine can trust a repair answer for a shared file now counts every machine in the group, even the ones that never joined the workspace the file belongs to. When a workspace is shared by fewer machines than the group has, that check asks for more agreement than can ever exist, and those machines stop being able to repair a stale copy at all.
files: packages/cadre-core/src/cadre-node.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, docs/architecture.md
difficulty: hard
repro: static
----

# The strand repair yardstick counts party machines, not the machines on that strand

## Background — what the yardstick is

Optimystic repairs a stale or missing block by asking the block's holders for the newest
revision and trusting the answer only when enough independent holders agree. "Enough" is
measured against a **declared** number (`clusterPolicy.repairCorroborationClusterSize`), not
against the holders it can currently see, because the visible set comes from unauthenticated
routing and a partition can shrink it.

`feat-repair-yardstick-strand-nodes` (landed, commit `5321d6c`) started deriving that number
for strand networks instead of leaving it pinned at 2, using
`max(2, min(machines, replication breadth))`. The count it passes is
`CadreNode.enrolledMachineCount()` — the party's authorized `CadrePeer` rows plus self.

## The defect

**A strand does not run on every machine in the party.** A strand starts on a machine only
when that machine's embedding app registered an sApp config for it (`CadreNode.addStrand`);
`handleStrandAdded` emits `strand:discovered` and returns without launching anything when no
config is registered. The React Native reference app, for example, auto-joins only *open*
strands (`use-cadre.ts` returns early for `strand.Type !== 'o'`), so a closed strand runs on
exactly the machines that were invited to it. A headless node in the party (a CLI or hosted
node that calls `addStrand` for nothing) runs no strands at all while still counting as an
enrolled machine.

So the number passed is an upper bound on the machines that can hold a strand's blocks, and
declaring an upper bound is not free — it is unsafe in the availability direction:

- With `N` declared and `p` holders visible besides the reader, the corroboration floor is
  `max(1, min(2, max(p, N - 1)))` (`corroboratorCapacity` / `quorumSize` in
  `db-p2p/src/cluster/quorum-restore.ts`).
- A strand actually served by **two** machines has `p = 1`. Declaring `N = 2` gives a floor of
  1 and the single peer's answer is accepted, so repair converges. Declaring `N >= 3` pins the
  floor at 2 while only one peer can ever answer, so the quorum is never met and the block is
  **never repairable** — `cluster-fetch:no-quorum`, which surfaces to an application as a read
  failing with `Missing block`.

Therefore a party of three or more machines running a strand that only two of them joined has
gone from "repairs, with the known single-voter exposure
(`backlog/debt-read-repair-single-voter-corroboration`)" to "cannot repair at all". This is
the exact failure `docs/architecture.md` already warns about for a too-wide target — reached
now from the declaration side.

The milder version of the same mistake applies at every subset size: an over-declared `N` also
makes `CoordinatorRepo.commitQuorumRulesOutRivals` demand `approvals > N/2` against a cohort
that can never supply them, so the commit freshness window never arms and every read of those
blocks pays a cohort consult.

The control network is **not** affected and its own derivation (`2-feat-repair-yardstick-control-node`)
should not be held up by this: every enrolled machine runs the control node by construction, so
there the party count *is* the serving count.

## `repro: static`

Derived by reading the code and the upstream arithmetic; not observed on a running party. What
would confirm it: an integration scenario with three party machines where only two register the
strand's sApp config, a block written while one of the two is offline, and an assertion that the
returning machine's read still repairs. Today's tests cannot catch it — every unit test mocks
`createLibp2pNode` and asserts the object handed to it, and the plugin's networked e2e mesh
passes the bare `STRAND_CLUSTER_POLICY` with no count at all.

## What a correct answer needs

The declaration must reflect **machines that serve this strand**, and the hard part is that no
such number is available where it is needed:

- The strand's own `Member` / `MemberPeer` rows live *inside* the strand database, which runs on
  the libp2p node whose policy is being decided — the value is frozen at node construction, so
  the rows cannot be read first.
- `CadreNode.resolveCohortSeed` does learn which siblings serve a strand (the
  `/sereus/strand-addr/1.0.0` RPC over authenticated control connections), and it already runs
  immediately before every launch and every resume. But it only reaches siblings that are
  *currently connected*, so it under-reports a hibernating party — and a number a shrunken view
  can talk down is exactly what a declaration is supposed to be immune to.

Shapes worth weighing, without committing to one here:

- A per-strand, per-machine participation record on the **control** database (which every party
  machine does hold), written when a machine joins a strand and read as the declaration. Makes the
  serving count authenticated application state, like the party count already is.
- A persisted per-strand high-water mark of serving machines actually observed, used as the
  declaration — monotone, so a partition cannot lower it, at the cost of never recovering from a
  machine genuinely leaving the strand.
- Confining the derivation to networks where every enrolled machine serves by construction —
  i.e. the control network only — and returning strands to the bare `STRAND_CLUSTER_POLICY` until
  one of the above exists. Cheapest and safe; gives up the strand half of the landed feature.

Whichever lands, the type should stop inviting the mistake: `resolveRepairYardstick`'s first
parameter and `StartStrandConfig.enrolledMachines` are both named for the party, and the value
they actually need is "machines serving *this network*". A rename plus a strand-scoped source is
what makes the wrong number hard to pass again.

## Coverage the fix should carry

- The `CadreNode` arm has no test at all today — neither `enrolledMachineCount()` nor its two
  call sites (`launchStrand`, `resumeStrandRuntime`) is exercised. Whatever count replaces it
  needs one, since that seam is where the wrong quantity entered.
- A test that pins the safety property directly rather than the plumbing: for any declaration a
  strand node is built with, the declared value must not exceed the machines that can serve that
  strand.
