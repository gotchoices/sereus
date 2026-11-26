priority: 1
description: An operator can tell a machine how much disk to lend each network it serves, and a full machine stops accepting new data — but nobody can see which group filled it, a hosting provider cannot bill for what a tenant actually stored, and the figure is per network rather than per machine.
architecture: docs/cadre/node-storage.md#the-storage-allotment
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-provider/src/service, docs/cadre/node-storage.md
tradeoffs: The part that stops a machine filling its disk is already done, and per-strand accounting is only worth building for a deployment that bills for storage or supports an operator asking "what filled this machine" — so a maintainer with neither may reasonably leave all three.
----

# What a storage limit still does not do

The Optimystic 1.30 adoption answered half of this. `CadreNodeConfig.storage.allotmentBytes` is read, reaches the control node and every strand node, and a node above 0.95 of the smaller of that figure and its backend's free space refuses new data — a pushed replica, an announced blob, and a pend its cohort asks it to store. [The storage allotment](../../../docs/cadre/node-storage.md#the-storage-allotment) is what the figure bounds today. Nothing here is blocked on an unbuilt storage ring system any more.

Three things the original ticket asked for are still missing.

## Per-strand usage accounting

Optimystic reports how full a node is per node (`node.storageAccount`, `node.storagePressure`), and Sereus surfaces neither. A machine running a control network and several strands therefore has no answer to "how full is this machine" or "which strand filled it": answering either means summing across the control node and every strand node and keeping the per-strand figures apart. The use case is an operator or an app deciding what to drop, and it is a prerequisite for the next two.

## Usage reported for billing

A hosting provider charges for storage and today has nothing to charge against. `cadre-provider` sets a tenant's limit (the Docker volume is the actual enforcement) but never learns what the tenant stored. What is wanted is a reading the provider can meter, sampled rather than streamed, and a decision about whether the provider reads it from the node's management API or from the volume.

## A machine-wide budget rather than a per-network one

The allotment is per network, not per machine: with N strands running, a machine can hold up to (N+1) times the figure before any one node reports itself full, and on a Node host only the backend's own free-space reading keeps the disk from filling. That is an accepted tradeoff today, recorded in `docs/cadre/node-storage.md`, because a node's allotment is fixed when the node is constructed while the strand count changes as it runs. A machine-wide budget means one account shared across a machine's nodes, which is Optimystic's to offer before Sereus can pass it — so this arm waits on upstream, where the other two do not.
