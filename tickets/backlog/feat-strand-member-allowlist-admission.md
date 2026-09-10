----
description: A shared workspace's machines currently refuse machines known to belong to removed people, but admit any stranger by default. Flip the default for invitation-only workspaces: admit only machines positively bound to a current participant.
prereq: strand-node-binds-member-peer
files: packages/cadre-core/src/strand-revocation-enforcer.ts, packages/cadre-core/src/strand-membership-writer.ts, docs/strands.md
tradeoffs: Deny-by-default is unforgiving of replication lag — a legitimate new machine is refused until its binding replicates to the machine it dials, which turns an eventual-consistency delay into a visible connection failure; the current denylist-only posture never locks out a legitimate member.
----

# Closed-strand admission should be an allowlist, not just a denylist

`docs/strands.md` → "Relay willingness" names this as the deferred half of the durable-attestation design: the **revocation** half exists (a strand machine refuses machines whose `Strand.MemberPeer` binding is orphaned by its member's removal — `strand-revocation-enforcer.ts`), but admission is still open — a strand transport peer id that appears with *no* binding at all is served. The only gate on an unknown peer today is the 30-minute in-memory relay delegate grant, which admits a connection and attests nothing.

With `strand-node-binds-member-peer` landed, production closed strands have the data an allowlist needs: every machine of every party writes a signed `MemberPeer(MemberKey, PeerId)` row, joined to a live `Strand.Member` row. This ticket is the flip: at the same hooks the revocation gate already holds (connection, stream, dial, relay-reservation), a **closed** strand refuses a peer id with no live-membered binding, instead of only refusing known-orphaned ones.

Constraints the design must respect, inherited from the revocation work and the schema:

- A `MemberPeer` row alone is not proof of membership — the join to a live `Member` row is mandatory (schema NOTE: bindings outlive members).
- Deny only on evidence held locally, but for an allowlist that inverts the safe direction: a machine that has not yet replicated a *new* machine's binding would refuse a legitimate member. The design has to decide the grace posture for unknown peers (bounded provisional admission like the relay's unauthorized-reservation budget, retry-until-replicated, or hard deny) — this is the core open question.
- A joiner mid-join is a chicken-and-egg case: it must sync the strand to write its own binding, but an allowlist would refuse it before it can. The pending-formation-invitation window needs an explicit admission story. That same window is already a live defect on the *denylist* side — a removed party handed a fresh invitation can never redeem it (`backlog/bug-removed-party-cannot-redeem-its-way-back`, verified end to end). Note that the *first* blocker there is not admission at all but a join loop that has already stopped; the admission dead end is real and sits immediately behind it, which is why the two are worth designing together rather than assuming this hook is the only thing in the way. Design one admission story for "a peer holding a valid unspent invitation" and both cases fall out of it; solving them separately would put two different carve-outs in the same hooks.
- Open strands have no member rows by schema and must keep working unchanged.
