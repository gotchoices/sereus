description: A shared party database is set up to keep only two copies of each piece of data, so in a party of three machines one machine can be left permanently out of date about the others — it never finds out it is missing anything. Make the party database copy to every member instead.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, docs/cadre-consistency.md, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/src/cluster/quorum-restore.ts
difficulty: medium
----

# Control database must replicate to the whole party, not to two nodes

Root cause of `bug-control-db-rx-record-never-converges-on-sender` (fix stage, 2026-07-29/30).
Confirmed by experiment; the fix is a configuration-semantics change in this repo, not a
replication bug in Optimystic.

## Plain statement of the defect

Sereus tells Optimystic that the control (membership) database should keep **two** copies of each
block — `DEFAULT_CLUSTER_SIZE = 2` in `packages/quereus-plugin-sereus/src/cluster-size.ts`, passed
by `CadreNode` for every control network and by the integration-test harness.

Two copies means that in a party of three, each write lands on the writer plus **one** other member.
The third member does not receive it. It is supposed to catch up by *read repair*: on reading a block
it asks the block's cohort what the newest revision is. But its cohort is also capped at two, so it
asks exactly **one** peer — and Optimystic's repair logic accepts a single peer's answer as the
cluster's truth when the cohort can hold only one other voter
(`corroboratorCapacity`/`quorumSize` in `../optimystic/packages/db-p2p/src/cluster/quorum-restore.ts`:
a capacity of 1 lowers the corroboration floor from 2 to 1). If that one peer is the member that also
missed the write, it honestly answers with the older revision, the reader concludes "I am current"
(`cluster-fetch:local-current` → `read-repair-noop`), and `markBlocksSeen` re-arms the 10-second lazy
repair window. Every subsequent read repeats this. The member never converges — not slowly,
**never**.

Optimystic already predicts this exact outcome, in a source comment at the deciding branch
(`../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts`, just above the
`cluster-fetch:local-current` log):

> NOTE: in a cohort of two, that sole peer is the only corroborator, so a lying one can park the
> reader here … If two-member cohorts become a supported production topology rather than a dev
> convenience, stop re-arming the window on a corroboration that came from a single voter.

Sereus made two-member cohorts its production topology. A stale peer produces the same outcome as
the lying peer the comment describes.

## Measurements (fix stage, 2026-07-30, HEAD 46708ff)

Command, run alone (whole-file runs mask it), from `packages/integration-tests`:

```
npx vitest run src/scenarios/push-wake-e2e.integration.ts -t 'learned by control-DB replication'
```

`clusterSize` was overridden per run via a temporary `CadreNodeConfig.clusterSize` passthrough in the
scenario's `nodeConfig` helper (since reverted — re-add it if you want to re-measure).

| control `clusterSize` | runs | failures |
|---|---|---|
| **2** (today's default) | 10 | **4** — 2× 30 s convergence timeout, 1× `SyncRetryExhaustedError`, 1× `PartialCommitError` |
| **3** (= party size) | 20 | **0** |
| **8** (well above party size) | 10 | **0** |

A pass takes ~2.7 s of test time at every size — no measurable cost to the wider cohort at this
scale. No `MEMBERSHIP_NOT_ADMITTED` / supermajority refusals appeared at size 8 on a 3-node party,
which answers the standing worry in `cluster-size.ts`'s own doc comment (see "Correct the doc
comment" below).

All three previously-reported failure costumes vanish together, which confirms they were one defect:
a member whose re-read never observes the winner's revision either times out waiting (reader side)
or recomputes the same revision number and loses the write repeatedly (writer side, surfacing as
retry exhaustion and — when the commit sweep had already persisted an earlier tree — as a split
write).

## What to change

Raise the control network's replication breadth so that it covers the whole party. The over-fetch in
`Libp2pKeyPeerNetwork.findCluster` keeps `min(serving peers, clusterSize - 1)` non-self members, so a
`clusterSize` at or above the party's member count makes every cohort the entire party: every write
reaches every member and read repair is never on the critical path.

Two candidate shapes; **prefer (a)** on the evidence above, and only fall back to (b) if you find a
real ceiling.

**(a) A generous constant, well above any realistic party size.** `clusterSize = 8` was measured
green on a 3-node party with no admission refusals, and Optimystic downsizes cohorts it cannot fill
(`allowDownsize: true`, already passed by both `CadreNode` and the harness). So a single constant —
name it for what it means, e.g. `CONTROL_REPLICATION_BREADTH` — replaces `DEFAULT_CLUSTER_SIZE` on
the *control* path. Pick the number from the largest party the product intends to support, and say so
in the doc comment.

**(b) Track the party's member count at runtime.** Semantically the tightest fit — control cohort =
party — but `clusterSize` is a constructor-time `readonly` on `Libp2pKeyPeerNetwork`, so it would
need an Optimystic change (accept `number | (() => number)`) plus a Sereus source for the count (the
authorized `CadrePeer` count that `refreshAuthorizedControlPeers` already maintains). Note the
error direction is safe either way: a node that under-configures admits any cohort at or above its
own number, and the party owner — the writer, and the most-converged node — always has the largest
view.

Keep the *strand* path's sizing decision separate and deliberate. Strand data is application data
where partial replication is a legitimate choice; only the control database's every-member-reads-it
character justifies full replication. `strand-instance-manager.ts` currently shares
`resolveClusterSize`, so splitting the two is part of the work.

### Correct the doc comment while you are there

`cluster-size.ts`'s comment claims a member "refuses to vote on a write when the coordinator's
declared peer set is smaller than the member's own configured size". The refusal in
`../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts` keys on
`ClusterConsensusConfig.assumedClusterSize` (defaulted low by `libp2p-node-base`), **not** on
`clusterSize` — which is why `clusterSize = 8` on a 3-node party committed cleanly. Re-read that gate
and rewrite the comment to match what it actually does; the current wording is what has kept this
default pinned at the minimum.

### Do not

- Do not raise the scenario's 30 s timeout, and do not seed the row locally on the sender. The
  scenario exists to prove a plain member learns a sibling-written fact purely by replication.
- Do not set `clusterSize` only in the test harness. That hides the same defect for every real
  3-node party.
- Do not weaken `packages/integration-tests/src/harness/build-freshness.ts`. It aborts the suite
  while a sibling repo (`../quereus`, `../optimystic`) is mid-edit — deliberate; wait and retry.
  Rebuild `@quereus/quereus`, `@optimystic/db-core`, `@optimystic/db-p2p`,
  `@serfab/quereus-plugin-sereus`, `@serfab/cadre-core`, `@serfab/cadre-host` before running.

## Acceptance

- The command above passes **20 consecutive runs**. Baseline for comparison is 4 failures in 10.
- `packages/integration-tests` full suite still green (the change alters cohort breadth for every
  scenario, so run the whole package, not just this file).
- `docs/cadre-consistency.md` states the control database's replication rule and why it differs from
  strand data.

## Not in scope

- Optimystic's read-repair behaviour at two-member cohorts (single-voter corroboration re-arming the
  lazy window). Once the control network stops configuring two-member cohorts that path is dormant
  for Sereus, but it is still a latent defect for any caller that does configure them — filed as
  `backlog/debt-read-repair-single-voter-corroboration`.
- The commit sweep's non-atomicity across trees, which turned some of these failures into split
  writes. Known structural limitation of single-node commit mode, documented in
  `../optimystic/docs/transactions.md` § "Legacy (single-node) commit is not atomic across trees".
  Amplifier, not cause.

## TODO

- [ ] Decide between shape (a) and (b) above; if (a), pick the constant from the intended maximum
      party size and document the reasoning at the constant.
- [ ] Split the control-network sizing decision from the strand sizing decision in
      `cluster-size.ts` / `cadre-node.ts` / `strand-instance-manager.ts`.
- [ ] Update `packages/integration-tests/src/harness/test-party.ts` so its `clusterSize` still
      matches what `CadreNode` resolves (the comment there already says it must).
- [ ] Re-read Optimystic's cluster-member admission gate and rewrite the stale `resolveClusterSize`
      doc comment to describe `assumedClusterSize`, not `clusterSize`.
- [ ] Consider whether Sereus should also set `clusterPolicy.assumedClusterSize` explicitly rather
      than inheriting Optimystic's low default; record the decision either way.
- [ ] Run the scenario 20× and the full `integration-tests` package; record both results in the
      review handoff.
- [ ] Update `docs/cadre-consistency.md`.
