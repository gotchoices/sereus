description: When a machine keeps only two copies of shared data, a machine that falls behind asks exactly one other machine whether it is up to date — and believes the answer. If that one machine is also behind, the first one stays permanently out of date and stops checking.
files: ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/cluster/quorum-restore.ts
difficulty: hard
----

# Read repair accepts a single voter and then stops asking

Latent defect in `../optimystic` (`db-p2p`), split out of Sereus's
`bug-control-db-rx-record-never-converges-on-sender` at fix stage.

**Scope narrowed 2026-07-29: strand data only.** `control-db-replicates-to-whole-party` has landed, so
the control database no longer configures two-copy replication — its cohort is the whole party, which
raises `corroboratorCapacity` from 1 to N-1 and with it the corroboration floor, so a lone stale peer
can no longer pass as the cluster's truth there.

**Scope narrowed again 2026-07-31: no default configuration in Sereus is exposed.**
`debt-strand-replication-breadth-ignores-party-count` raised `DEFAULT_STRAND_CLUSTER_SIZE` from 2 to
4, so strand networks no longer configure two-copy replication either. Any breadth above 2 lifts the
corroboration floor off a single voter. Do **not** close this ticket: the Optimystic behaviour is
unfixed, and a caller that explicitly configures a strand at 2 (`CadreNodeConfig.strandClusterSize`,
`StrandConnectionOptions.clusterSize` — both accept `MIN_CLUSTER_SIZE` = 2) still hits it, as does
any other Optimystic embedder.

## What happens

A node reading a block it holds at an old revision asks the block's cohort for the newest revision.
With a replication factor of 2, that cohort contains exactly one other node. Optimystic's
corroboration quorum lowers its floor from two voters to one when the cohort can hold only one
(`corroboratorCapacity` / `quorumSize` in `quorum-restore.ts`) — otherwise a genuinely two-node
deployment could never converge at all. So one peer's answer becomes the cluster's truth.

If that peer is *also* behind, it honestly reports the old revision. The reader sees
"cluster revision <= my revision", logs `cluster-fetch:local-current`, and calls `markBlocksSeen`,
which re-arms the lazy repair window (10 s by default). Every later read repeats the same exchange
with the same peer and re-arms the window again. The reader never converges and never escalates.

Optimystic's source already names this, in a comment at the deciding branch in `coordinator-repo.ts`
(just above the `cluster-fetch:local-current` log): *"in a cohort of two, that sole peer is the only
corroborator … If two-member cohorts become a supported production topology rather than a dev
convenience, stop re-arming the window on a corroboration that came from a single voter."* Sereus hit
it in production configuration, with an honestly-stale peer rather than a lying one — same outcome.

## Evidence

Measured in Sereus, `packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts`, test
`wakes a member whose authorization and address were learned by control-DB replication, not local
seeding`, on a 3-node party: 4 failures in 10 runs at replication factor 2, 0 in 20 at factor 3,
0 in 10 at factor 8. In a captured failing run the stuck node logged
`cluster-fetch:local-current { blockId: 'default/CadrePeer', localRev: 1, clusterRev: 1 }` repeatedly
across the whole 30-second window while another party member held revision 2.

## What a fix has to reconcile

Two requirements pull against each other, which is why this is not a one-liner:

- A genuinely two-node deployment must still be able to converge; that is what the relaxed floor
  exists for. Simply requiring two corroborators makes divergence permanent instead of safe (the
  `selectQuorumRev` doc comment says so explicitly).
- A single voter's claim must not be able to *silence* further checking. At minimum, a corroboration
  that came from one voter should not re-arm the lazy repair window; better, the reader should be able
  to reach beyond its narrow cohort — `findCluster` already over-fetches a wider band of
  same-network peers (`membershipOverfetch`) and discards all but `clusterSize - 1` of them, and
  reads are cheap and idempotent, unlike writes.

Note that widening the queried set alone is not sufficient: with more responders the quorum floor
rises to two, so a revision held by only one of two responders still fails to corroborate. Any fix
needs to say what authority a reader may converge on when the newest revision is, by construction, a
minority of the peers it can ask — e.g. a commit certificate it can verify (already tracked in
Optimystic as `debt-read-repair-commit-cert-verification`) rather than a headcount.

## Why backlog rather than fix

Sereus's control path — where this was found and measured — is out of reach now that the control
cohort is the whole party. What is left is the strand path, whose own breadth question is tracked
separately (`backlog/debt-strand-replication-breadth-ignores-party-count`) and which has no reported
failure yet. The design question above also wants a considered answer in the Optimystic repo rather
than a quick patch driven by a Sereus scenario.
