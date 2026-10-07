description: No test runs the main case multi-machine invitations exist for: the inviting phone is off, and a stranger joins through the party's always-on machine. Add one real-network test for it, so a break anywhere along that path fails a test.
architecture: docs/architecture.md#which-machines-an-invitation-names
files: packages/integration-tests/src/scenarios/strand-formation-cross-party-seed.integration.ts (harness to copy: a host that founds a strand and publishes a bound invitation), packages/integration-tests/src/scenarios/strand-always-on-replica-hosts-cross-party-join.integration.ts (a two-machine party with an always-on storage node), packages/cadre-core/src/cadre-node.ts (createOpenInvitation, siblingInvitationAddrs, admitInboundControlConnection check 6), packages/cadre-core/src/strand-formation-protocol.ts (dialFormationByMachine), packages/cadre-core/src/control-formation-recorder.ts
tradeoffs: another multi-node real-network scenario adds a minute or more to the integration tier, and each part of the path already has its own narrower test.
----
# Joining through a sibling machine has no end-to-end test

Part of gotchoices/sereus#25. Found in review of `invitation-names-every-party-machine`.

## The gap

Since `invitation-names-every-party-machine`, `CadreNode.createOpenInvitation` lists the minting machine and up to three other machines of its party, and the joiner tries each in turn. The case this exists for is: the phone that minted the invitation is offline, and the party's always-on machine answers the join.

Each part of that path has a narrower test, and nothing joins them up:

- the sibling's addresses come from its signed `CadrePeer` record (no test; a sort and two caps);
- the joiner walks the machines (`strand-solicitation.spec.ts` uses a peer id nobody runs plus one responder; `strand-formation-manager.spec.ts` uses in-memory responders);
- the sibling's connection gate admits the stranger because the published `FormationInvite` row has replicated to it (`admitInboundControlConnection`, check 6), and its responder checks the token against its own control database (`formation-responder-installed-at-start`'s tests).

A regression in how these fit together (for example, a sibling whose record carries no address the joiner can reach, or a gate that reads only the in-memory mint registry) would pass every existing test.

## Expected behaviour to pin

One real-network scenario:

- Inviting party: an owner machine (stands in for the phone) and an always-on storage machine, enrolled and converged on the control network, both with fresh self records.
- The owner founds a strand, mints an invitation with `createOpenInvitation`, publishes its `FormationInvite`, and waits until that row and the strand row have replicated to the always-on machine. Assert the invitation's bootstrap list names both machines.
- Stop the owner machine.
- A second party's node calls `formStrand` with the invitation. It succeeds, the result comes from the always-on machine, and the `FormationUsage` row is on the always-on machine's control database.

An open (unbound) invite keeps this off the closed-strand path, where the sibling would also need to run the host strand.

**Note (2026-10-07):** once `implement/stranger-connections-admitted-provisionally` lands, the sibling admits the stranger's connection whether or not the `FormationInvite` row has replicated. The replicated row then only decides whether the connection is kept past the provisional deadline and whether the responder accepts the token.
