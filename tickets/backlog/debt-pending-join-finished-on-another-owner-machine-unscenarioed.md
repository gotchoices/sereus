description: No test covers a closed-strand join that one of the party's machines finishes in the background while a different machine of the party is the one that opens the strand. Add one real-network test for it, so a break in handing the join's membership invitation between the party's machines fails a test.
architecture: docs/strands.md#joining-while-the-inviter-is-offline
files: packages/cadre-core/src/cadre-node.ts (stageMembershipInvitesFromPendingJoins, adoptFormationMembershipInvite), packages/cadre-core/src/pending-join-runner.ts (membershipInvitesToStage, observeRows), packages/cadre-core/src/strand-membership-reconciler.ts, packages/integration-tests/src/scenarios/pending-join-survives-restart.integration.ts (harness to copy: a host with a closed strand and a bound invitation, a joiner that calls requestJoin), packages/integration-tests/src/scenarios/strand-always-on-replica-hosts-cross-party-join.integration.ts (a two-machine party)
tradeoffs: a two-owner-machine real-network scenario adds about a minute to the integration tier, and the staging function itself is a short filter over rows.
----
# A join finished on one owner machine and launched on another has no test

Part of gotchoices/sereus#25. Found in review of `pending-join-retry-loop`.

## The gap

When a party joins a closed strand, the inviter's approval carries a single-use membership invitation that seats the joining party as a `Strand.Member`. `formStrand` keeps that invitation in the memory of the machine that ran the formation. With `requestJoin`, the formation may run on any owner machine of the joining party (an always-on node, say), while the strand is first launched on another (typically the phone). For that case the finishing machine writes the invitation into the replicated `PendingJoin` row, and every owner machine's retry-loop pass stages it from there (`stageMembershipInvitesFromPendingJoins`), so whichever machine launches the strand redeems it.

The only scenario, `pending-join-survives-restart`, finishes and launches the join on the same machine, so the invitation is staged by `formStrand` itself and the row-to-staging path never runs. A regression there (the row not replicating before the other machine launches, the staging skipping a live invitation, or two machines both redeeming and neither writing its `MemberPeer` binding) would pass every existing test.

## Expected behaviour to pin

One real-network scenario:

- Inviting party: one owner machine that founds a closed strand and publishes a single-use invitation bound to it.
- Joining party: two owner machines, enrolled and converged on their control network.
- Machine A of the joining party calls `requestJoin` and records `joined`. Machine B never runs a formation.
- Machine B reads the `joined` row, is offered the strand through `strand:discovered`, claims it, and the joining party becomes a `Strand.Member` through the staged invitation.
