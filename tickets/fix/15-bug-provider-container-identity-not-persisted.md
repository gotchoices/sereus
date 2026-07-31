---
description: On the multi-tenant hosting service, a customer's node invents a brand-new network identity every time its container restarts, so the customer's group stops recognising it — and containers there are configured to restart automatically.
files: packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-cli/src/commands/start.ts
---

# Provider-hosted nodes lose their identity on container restart

## What is wrong

`DockerOrchestrator.createContainer` (`packages/cadre-provider/src/service/docker-orchestrator.ts`)
configures a tenant's node entirely through environment variables — party id, bootstrap nodes,
profile, ports, seed token, push credentials — and passes **no identity**: no
`CADRE_IDENTITY_PROTOBUF`, no key material, and no volume for the node to keep anything in.
`CadreNode` therefore generates a fresh libp2p keypair on every start, so the tenant's cadre,
which approved the previous peer id, sees a stranger after a restart.

It also has no durable node-local stores for the same reason cadre-host's donated nodes did
not: `cadre-cli start` opens them relative to a configured identity key path, and there is none.

This is not a rare path. The container is created with
`RestartPolicy: { Name: 'unless-stopped' }` — Docker restarting the container is the *designed*
behaviour on crash and on daemon restart, and every one of those restarts re-keys the node.

This is the same defect class as `tickets/fix/1-donated-nodes-lose-restart-state.md` was for
cadre-host, in a different package. It was noticed while fixing that one and is filed
separately because the mechanism differs — container filesystem and volume lifecycle rather
than a host workdir — and it needs its own reproduction against a real Docker daemon.

## Expected behaviour

A tenant's node keeps the same network identity, and the addresses it was told to dial, across
container restarts, so its cadre keeps recognising it and a node that could not reach the cadre
on its first try keeps retrying. Removing the tenant's container removes that state with it.

## Open questions for whoever plans this

- Where does the state live: the container filesystem (survives `restart`, lost on recreate —
  and image upgrades recreate) or a named volume bound to the container's lifetime?
- Who mints the key — the provider at create time, or the node itself on first start into a
  mounted directory?
- Does the identity need to be visible to the provider (surfaced in the container record) so a
  tenant can be told which peer id is theirs?
- Related, worth checking while in this code: `OrchestratorCreateRequest.pinnedOwnerKeys` is
  threaded by cadre-host but dropped entirely by this orchestrator — is that a gap or simply
  unused on the provider path?
