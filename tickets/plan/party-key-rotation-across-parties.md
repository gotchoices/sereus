description: When a machine is removed, the cadre replaces its membership key in each private workspace it manages, but in a workspace another party manages it cannot seat the new key itself. Design how the other party's manager admits the replacement key and how the old one is retired, so those workspaces stop serving the removed machine too.
prereq: machine-removal-rotates-party-member-key
architecture: docs/strands.md#who-may-administer-a-closed-strand
files: packages/cadre-core/src/strand-party-key-rotation.ts, packages/cadre-core/src/strand-membership-reconciler.ts (`ensureMembership`, the staged-invitation redemption), packages/cadre-core/src/cadre-node.ts (`adoptFormationMembershipInvite` ~11263, `issueStrandMembershipInvite` ~11367, `formStrand`), packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-membership-writer.ts (`addMemberByManager`, `leaveStrand`), docs/strands.md (Inviting Parties; Closed-Strand Member Key Handling; What removal still does not do), docs/architecture.md (Strand Formation)
difficulty: hard
----
# Rotating the party key in a strand another party manages

`machine-removal-rotates-party-member-key` stops at step 2 of its driver when the party's current key holds no `Strand.Manager` row: the pending key stays in `PendingStrandPartyKey`, the app hears `needs-another-party`, and the removed machine keeps being served in that strand. This ticket designs the rest.

## What is already settled

- **The old key can retire itself.** `leaveStrand` is self-signed, so once the new key K' is a member and the party's machines are bound under it, the driver's steps 3, 5 (leave only, no resign) and 6 run unchanged. Only seating K' needs the other party.
- **Two admission paths exist on the strand side.** A manager admits a key directly (`addMemberByManager`, needs K' public key out of band), or issues a single-use `Strand.Invite` that the bearer consumes under its own key. Formation already carries such an invitation back to a re-joining party (`FormationProvisionResult.membershipInvite`), and a re-formation re-arms the joiner's reconciler.
- **The reconciler must redeem under the pending key.** Today `consumeInvite` runs under the current party key. With a pending row present, a staged invitation must be consumed under K' instead, or the re-formation re-seats the old key. The reconciler reads the pending row through the seam the driver uses.

## What the plan has to settle

- **How the manager party is asked.** Options: (a) the rotating party re-joins through a fresh formation invitation the host publishes, which is a human act on the host side today; (b) a strand-side request row the rotating party writes (signed by its current key, which is still a member) that the host's node answers automatically by admitting the named public key, with a policy for whether that is automatic or confirmed by a person; (c) nothing automatic, and the app shows the public key for the host's owner to admit by hand. Weigh (b) against `feat-strand-invitee-bound-invites` and the allowlist backlog ticket, since a request row is a new strand-schema table and a new thing managers answer.
- **What the host is told and shown.** A removed machine of another party is that party's business; the host's app may only need "party X replaced its key" after the fact, or may need to approve.
- **The old key's removal when the party cannot leave.** If the host swaps nothing and the rotating party's driver never reaches step 5 (the party lost its machines), the host's manager has to revoke the old key by hand. Say what the app offers.
- **A strand the party joined but never seated** (no `StrandPartyKey` row) is skipped by the driver; confirm that is right.
- **Reporting.** The pending row persists; the app lists it under the strand with "needs the other party's manager" until the swap. Decide whether a pending row that is never resolved is ever withdrawn, and by whom.

## Acceptance

Alongside `scenario-machine-removal-rotates-party-key`: party A with two machines joins party B's closed strand through formation; A removes one machine; after the chosen admission path, the removed machine is denied by B and by A's other machine, and A's remaining machine is bound under A's new key with no owner action on it.
