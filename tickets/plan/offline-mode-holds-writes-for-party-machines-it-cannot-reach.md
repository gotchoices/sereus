description: A phone in offline mode promises not to save a change "alone" while it knows of other machines it cannot reach, but it does not count its own cadre's always-on nodes as known until it has connected to them once. So a save made before then, or whenever a node's workspace port is blocked, goes through as if the phone were the only machine, and the app cannot tell.
architecture: docs/strands.md#offline-mode
files: packages/cadre-core/src/cadre-node.ts (`resolveCohortSeed` ~7523, `refreshStrandPeerAddrs` ~7812), packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/src/strand-offline.ts, packages/cadre-core/src/strand-peer-redial.ts, docs/strands.md (Offline mode, A commit's durability), ../optimystic/packages/db-p2p/src/libp2p-key-network.ts (`absentCohortMembers`, `servingPeersOutside`, `rememberedServing`, read only), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (`soloCohortOf`, read only), ../optimystic/tickets/backlog/feat-declared-membership-feeds-cohort-assembly.md (read only)
prereq: strand-addr-retry-waits-a-minute-after-a-node-claim
repro: verified
----
# A party's own machines do not count as known members of a strand (gotchoices/sereus#56)

## The gap

`docs/strands.md` → Offline mode promises a queued transaction is "not committed by this machine alone while it knows of members it cannot reach". The reporter's run shows what "knows of" means today: with a node listed in the cadre and its strand not connected, the coordinator logs `commit:solo-cohort { cohortSize: 1, soleIsSelf: true, quorum: 'local', knownAbsent: 0 }`, offline mode does not hold the write, and `commitDurability` reports cohort 1 with `heldElsewhere: false` and nobody owed.

Optimystic's `absentCohortMembers` draws only on `rememberedServing`: peers this strand node has itself identified as serving the network, restored across restarts. A sibling it has never met is not among them, whatever the control database says.

The reporter gave two ways to reach this state:

- **The window after a claim.** `strand-addr-retry-waits-a-minute-after-a-node-claim` shortens it but does not close it.
- **Control reachable, strand not.** A firewall or port forward covers only the control port. The reporter saw a whole phone session of solo commits this way, with the node listed in the cadre. The retry ticket does not help here, and nothing ends this state until the port opens.

## Why it matters

The user's first saves after adding a node sit on the phone alone, and a solo commit with nothing known absent looks the same as a cadre of one. In offline mode that breaks a stated promise. Outside offline mode the write is allowed by design (`docs/strands.md` → "Writable does not mean connected"), but the durability report's `unconfirmed` is meant to name who is owed, and here it names nobody.

## What the plan has to settle

- **Which machines count.** A `CadrePeer` row does not mean the machine holds this strand: nodes differ by profile and `strandFilter`, and a strand may run on a subset of the party. Counting a machine that will never hold the strand would hold writes forever, the same trap as a too-high declaration on the read path (`docs/architecture.md` → Replication cluster size). Find what evidence says a machine holds the strand, such as a strand-address answer, a `Member` row or a saved record.
- **How to name them.** A sibling's strand peer id derives from its private identity key (`strandTransportKey`), so a control row cannot name it and only an answered strand-address ask can. Before any answer there is no id to report as absent, so the first-contact window may need a different signal from "these peers are absent".
- **The seam into Optimystic.** Sereus cannot add to `rememberedServing`. Upstream's backlog holds `feat-declared-membership-feeds-cohort-assembly`, and an accepted-tradeoff note in `libp2p-key-network.ts` names it as the remedy for a related case. The commit-time question may be narrower than that ticket. Sibling repos are read-only here (`tickets/rules/sibling-repos.md`), so an upstream need goes in a `blocked/` ticket with the proposed interface.
- **What a held write costs.** A phone whose node is gone for good must not queue forever without being told, and removing the machine from the cadre has to release the hold.
- **Scope outside offline mode.** Whether the durability report also names these machines as owed on an online commit. That needs no hold and may be separable.

If the specification cannot settle which machines count, route to `blocked/` with proposed wording.

## How to confirm

The issue's script, `strand-unconnected-repro.mjs`, shows `knownAbsent: 0` on the solo commits. The port-only variant needs the node's control port reachable and its strand listener not; the plan should say how a scenario gets that shape on loopback.
