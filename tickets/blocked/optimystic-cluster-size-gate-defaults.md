----
description: The storage library we build on uses one setting for two different jobs — how many copies of data to keep, and how small a group of nodes it will accept a write from — and its default for that setting is far larger than any small deployment. Someone should raise this with the library.
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (lines 639-650), ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts (lines 865-945)
----

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
