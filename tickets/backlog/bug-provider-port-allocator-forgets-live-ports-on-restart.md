---
description: After the multi-tenant provider service is restarted, it forgets which network ports the containers it is already hosting are using, and hands the same ports out again to the next container someone creates — which then fails to start.
files: packages/cadre-provider/src/service/docker-orchestrator.ts
repro: static
---

# Restarting the provider loses the record of which ports are in use

`DockerOrchestrator` hands out three host ports per container (health, metrics,
p2p) from a bounded range, tracked by a private `PortAllocator` that lives only
in memory (`packages/cadre-provider/src/service/docker-orchestrator.ts`, the
`PortAllocator` class and the `containerPorts` map beside it).

Containers outlive the provider process: they are created with
`RestartPolicy: unless-stopped`, and the container records are persisted by
`FileStore`. The port bookkeeping is not persisted and is not rebuilt from
Docker at startup.

So after the provider restarts:

- the allocator starts empty and begins again at the bottom of the range, so the
  next container created is offered ports the surviving containers are already
  bound to — Docker refuses the create with "port is already allocated" and the
  provision fails;
- `containerPorts` is likewise empty, so removing one of those older containers
  releases nothing (harmless on its own — the allocator does not think the ports
  are taken either).

Not observed in a running deployment; read off the code. Confirming it needs
only: start the provider, create a container, restart the provider, create a
second container.

## What is wanted

On startup the orchestrator's port bookkeeping should reflect the containers
that already exist. Docker is authoritative and already labels every container
the provider created (`sereus.container-id`) with its published host ports, so a
startup pass can mark those ports used rather than persisting a separate ledger.

Related but deliberately separate: `debt-duplicate-port-allocator-across-orchestrators`
de-duplicates the two copies of the tracker and explicitly excludes persisting
reservations across restarts. Its `markUsed` (which cadre-host's copy has and
the provider's does not) is the natural hook for the startup pass, so landing
that first makes this smaller.
