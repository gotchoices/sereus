----
description: Strengthen the closed-strand membership end-to-end test so the joining party drives its membership steps against its own copy of the shared database, proving the two nodes truly converge — rather than running everything against the founder's copy.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
----

## Background

The capstone e2e `strand-membership-closed-strand-e2e.integration.ts` proves the
closed-strand membership lifecycle (invite issue/consume, member-peer registration,
authority rotation, signed sApp write) across two real `CadreNode`s. By design, all
of the writer-driven accept/reject cases run against the **founder's** strand DB —
the authoritative DB where the founder bootstrap seated the `Authority`/`Member`/
`Header` rows the deferred constraints (`InviteValid`, `MemberExists`,
`Authority.Authorized`, …) read. The "joiner" is therefore a distinct member keypair
(plus the joiner node's real strand peer id) admitted into the founder's DB, not the
joiner's own DB.

Cross-node replication of the founder's `Strand.*` bootstrap rows to the joiner is
currently observed **best-effort** (logged, not gated) because deferred-constraint-
bearing `Strand.*` rows were flagged as potentially flaky to replicate under the
manual-wire setup. In practice the existing test observes `sync=true` on every run.

## What to build

Once `Strand.*` replication is proven reliable (track against
`optimystic-strand-sync-blind-write-convergence` and the sync behavior this e2e
already observes), deepen the scenario so the membership lifecycle is driven on the
**joiner's own DB**:

- Wait for the founder's bootstrap rows (`Header`/`Member`/founding `Authority`) to
  replicate to the joiner, then have the joiner run `consumeInvite` (for an invite
  the founder issued) against its **own** database and assert the new `Member` +
  `ConsumedInvite` converge back to the founder.
- Assert bidirectional convergence of the lifecycle writes rather than reading them
  only on the DB that authored them.

This turns the best-effort replication observation into a gated assertion and proves
the full closed-strand join genuinely round-trips between two nodes — the natural
next step beyond the current founder-DB-authoritative coverage. It depends on the
platform sync reliability determination, so it is parked as a future concern rather
than active work.
