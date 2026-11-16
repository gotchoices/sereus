description: Some strands, such as a public vote with very many phones, should let a phone take part without storing or signing the strand's data. Optimystic, the storage layer, cannot run a node that stays out of every storage group yet, so Sereus cannot offer the setting until it does.
prereq: node-roles-in-cadre-core
architecture: docs/architecture.md#node-classes
files: ../optimystic/tickets/plan/client-only-node.md, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts (selfServes, assembleServingCohort), packages/cadre-core/src/node-roles.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/peer-join-backfill.ts, docs/architecture.md, docs/strands.md
----

**Blocked: dependency outside this repo.** Unblocked when `@optimystic/db-p2p` ships `NodeOptions.servesBlocks: false`, a client-only node. That work is filed as `../optimystic/tickets/plan/client-only-node.md`.

## What Sereus wants

`NodeRoles.strandCohortMember` (added by `node-roles-in-cadre-core`, default `true` for both node classes) set to `false` means: this node runs the strand (reads, writes, membership, notifications) but never holds the strand's blocks and never signs its commits. Its writes and reads go to the strand's serving machines. The control network is unaffected: it always replicates to every party member, because a phone must read its own party's state offline.

The use case is scale: a strand with tens of thousands of phone participants, where making each phone a potential storage-group member puts sleeping, metered devices on the critical path of other people's commits.

## Why Sereus cannot do it alone

Optimystic decides who holds a block in `findCluster`: the peers nearest the block's ring position that advertise the network's `cluster`/`repo` protocol and pass `isNetworkMember`. It already applies the same test to the node itself (`selfServes()`). So a node that does not register those protocols drops out of every cohort, including its own, and other parties' machines leave it out based on its identify protocol list, with no new wire data. What is missing is a supported option to run such a node, plus a decision for each subsystem that assumes local blocks (rebalance, drain, catch-up, reactivity origination). The Optimystic ticket covers both.

A Sereus-only predicate would not work. In a cross-party strand the other parties' nodes choose cohorts too, and a node is always a member of its own cohorts while it registers the protocols.

## Sereus work once it lands

- Lift the `strandCohortMember: false` refusal; pass `servesBlocks: roles.strandCohortMember` on strand nodes only.
- Refuse `strandCohortMember: false` together with `hostUnclaimedStrands: true` (a storage replica that stores nothing).
- **Founding.** `StrandDatabase` founds with the founder writing the strand header. A non-serving founder needs a serving machine reachable at founding; decide between refusing and waiting, matching how a joiner waits for its cohort.
- **Offline writes.** A non-serving phone has no local copy to commit against. Confirm how the offline queue (`strand-offline-queue-survives-restart`) behaves and document it; the app sees writes as pending until a serving machine is reachable.
- **Closed-strand membership.** `Strand.MemberPeer` bindings and the revoked-peer gate are about who may participate, not who serves; a non-serving machine still seats its binding.
- **Serving count.** `backlog/feat-strand-yardstick-from-serving-machines` must count only serving machines.
- Docs: `docs/architecture.md` § Node Classes and `docs/strands.md`.

## If nothing is done

Every phone in a strand stays a potential storage-group member. Correct, and the intended default, but it limits how large a phone-heavy strand can grow before commits routinely wait on sleeping devices.
