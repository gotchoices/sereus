description: Once Optimystic ships its network-membership predicate, control nodes must pass the cadre's authorized-member snapshot to it, so a connected non-member can no longer be chosen for a control cohort or receive control block pushes.
architecture: docs/architecture.md#per-stream-protocol-guard
files: packages/cadre-core/src/cadre-node.ts (buildControlNodeOptions, authorizeInboundControlStream, refreshMembershipGate), tickets/blocked/stranger-joins-the-control-cohort-by-advertising-protocols.md
----
**Unblocked:** optimystic main 1b352916 (the release candidate, linked here) carries the membership predicate. Build against the linked tree; the floor bump comes with the release.

# Control nodes pass the membership predicate

- Read the released API in `../optimystic` (the `NodeOptions` predicate and any "reclassify this peer" hook) before planning.
- Control node: pass a synchronous predicate over the same materialized authorized-peer snapshot `authorizeInboundControlStream` uses, minus the protocol argument. On every membership change `refreshMembershipGate` must trigger whatever re-evaluation the release provides, so a newly admitted member is not refused.
- Strand nodes pass nothing (their peers are cross-party).
- Test: extend `control-stream-authz` step 5 so that after the outsider opens a stream on every members-only protocol, `findCluster` for a control block key on the owner no longer includes it, and the owner sends it no cluster request on its next control write.
- The FRET half (`feat-fret-honours-the-network-membership-predicate`, optimystic backlog) is not needed for this; when it ships, re-check that FRET no longer marks the outsider `member`.
- When done, move `stranger-joins-the-control-cohort-by-advertising-protocols` to `complete/` with a pointer here.
