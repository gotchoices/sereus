----
description: We noticed the storage library uses one setting for two different jobs and defaults it to a value no small deployment can meet. This ticket only asked that someone raise it with the library; that has been done.
----

# Complete: raised upstream

Resolved 2026-07-29 by filing it in the linked workspace as
`../optimystic/tickets/plan/3-clustersize-conflates-replication-factor-and-admission-yardstick.md`
(commit `8124cf6` there). This ticket asked for nothing else — no code change was ever in scope
here.

The upstream ticket carries the full finding: `clusterSize` is simultaneously the replication
factor (which you want high) and the yardstick a member uses to judge whether an inbound write
comes from a legitimately-sized group (which must not exceed the number of nodes that exist), so
one number cannot satisfy both. It also carries the concrete cost to us — we lowered our
replication factor from 3 to 2 purely to make writes work, which is now its own product decision
in `blocked/replication-breadth-two-signoff` — and the observation that the `?? 10` default
leaves any embedder who never configured it unable to commit at all, with an error that reads
like a peer problem rather than a local setting.

Three consolidation options are laid out there with tradeoffs, plus a request that the error
message name the configured value. The choice is the upstream maintainers' to make; nothing here
is waiting on it.

---

# Original ticket


# Upstream (Optimystic): one number does two jobs, and its default is 10

Not work in this repo. This is a note for a human to decide whether to raise upstream in
`../optimystic`. Found while fixing `bug-cluster-size-exceeds-cadre-size` (see
`tickets/implement/0.5-bug-cluster-size-exceeds-cadre-size.md` for the full mechanics).

## What we found

Optimystic takes a single `clusterSize` option, meaning "how many nodes should hold a copy
of each block". Since the 0.16.x membership-admission work it is *also* the yardstick a node
uses to decide whether a write it is asked to co-sign comes from a legitimately-sized group:
when a node cannot confidently estimate the network's size, it refuses any write whose
declared group is smaller than its own configured `clusterSize`.

Two consequences:

**1. You cannot ask for more copies than you have nodes.** Wanting three replicas *once the
network grows* and running two nodes *today* is not expressible — asking for three makes
today's two-node writes fail. The desired replication factor and the minimum acceptable
group size are genuinely different quantities, and they share one field.

**2. The default is 10.** `libp2p-node-base.ts:649` defaults `clusterSize` to 10 when the
embedder does not set one. Any consumer that never configured it is measured against a
ten-node reference and, without a confident network-size estimate, will refuse writes on any
smaller network. That is a silent breaking change for existing embedders on upgrade.

A related smaller gap: the documented escape hatch for knowingly running below the safe
floor, `allowUnvalidatedSmallCluster`, exists on the internal config but is not reachable
through `createLibp2pNode`'s public options — only via the in-repo test harness.

## What a fix might look like (upstream's call, not ours)

Separate the two meanings — e.g. keep `clusterSize` as the replication target and add a
distinct minimum-group-size setting for the admission gate — or expose
`allowUnvalidatedSmallCluster` on the public option surface so a small deployment can opt
in explicitly.

## Why this is parked

Sereus does not need it: we work around it by declaring a small cluster size (2) on our
side. Nothing here blocks our own tickets. It is filed so the observation is not lost, and
because whether to open an upstream issue is a human decision.
