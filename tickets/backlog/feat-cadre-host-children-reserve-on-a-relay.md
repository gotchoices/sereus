---
description: A home machine running cadre-host behind carrier-grade NAT, or a router that refuses port mapping, cannot be reached from the internet, because cadre-host has no way to point the nodes it runs at a relay. The underlying node program already supports relays; cadre-host just never passes one through.
architecture: docs/cadre-host.md#nat-and-ddns
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/address-resolver.ts, packages/cadre-cli/src/config/env.ts, docs/cadre-host.md
tradeoffs: UPnP, a manual port forward or IPv6 already cover most home networks, and a relay puts a third-party (or self-run) server on the data path with a per-reservation byte limit, so this may wait until a real CGNAT user needs it.
----

# cadre-host's nodes cannot reserve on a relay

## What is missing

cadre-host runs its owner node and every donated node as `cadre-cli` child processes. `cadre-cli` can already hold a relay reservation (`network.relayAddrs`, env `CADRE_RELAY_ADDRS`), which gives a node behind NAT a `/p2p-circuit` address other machines can dial. cadre-host never uses it:

- host configuration (`host.config.json`, `nat.json`) has no field for relay addresses;
- the child spawn in `host-process-orchestrator.ts` removes every `CADRE_*` variable inherited from the manager (`scrubbedParentEnv`) and sets only the fixed per-child variables, none of which is `CADRE_RELAY_ADDRS`.

So when UPnP fails and the operator cannot forward a port (the CGNAT case the host already detects as `cgnatDetected`), the host has no fallback. `docs/cadre-host.md` lists a relay as one of its three NAT layers and marks it "not wired".

## Expected behaviour

- The operator can name one or more relay dial addresses (`<addr>/p2p/<relayPeerId>`) in host settings, from the CLI (`cadre-host nat settings` or similar) and the local UI.
- The owner node is started with those relays. Whether donated nodes also get them is part of the design (a donated node is reached by its recipient's devices, so it has the same reachability need).
- A relay that is down must not stop the owner node from starting: the host is an always-on manager, so it needs the fail-soft posture (`requireRelay: false`), which `cadre-cli` does not currently expose at all (`grep -rn requireRelay packages/cadre-cli/src` is empty), so a cadre-cli node with `relayAddrs` fails `start()` when its relay is down.
- Invite addresses (`NatService.getInviteAddresses`) include the relayed address when the host is not directly reachable; `buildInviteAddresses` already falls through to the node's reported addresses in that case, so check that the relayed address reaches it.
- Status reporting (`/nat/*`, the UI) shows whether a reservation is held.

## Not this

Deploying relays (regions, dnsaddr discovery, abuse limits) is `4-relay-bootstrap-infrastructure` in `backlog/later/`. This ticket only lets cadre-host use a relay someone already runs, such as the `ops/docker/libp2p-infra` container.

## Docs that change when this lands

The `cadre-host` row of `docs/architecture.md` → "Which nodes can be reached through a relay" (and the sentence under that table naming cadre-host), item 2 of `docs/cadre-host.md` → "NAT and DDNS" plus the other "not wired yet" mentions in that file (the comparison table, the public-surface bullet, item 1, the invite address resolver's third bullet), the matching comment in `packages/cadre-host/src/nat/address-resolver.ts`, and the `NOTE:` in the child env block of `host-process-orchestrator.ts` that says children hold no relay reservation.

## Note from planning `cadre-host-node-reachability`

`cadre-host-nat-per-node-mappings` removes `NatService.getInviteAddresses` and the invite-address push. Each hosted node instead gets its public addresses at spawn as `CADRE_APPEND_ANNOUNCE_ADDRS` (`cadre-host-nodes-announce-public-addresses`), computed by `buildPublicAddresses` in `address-resolver.ts`, and status reports a per-node verdict with a CGNAT reason that points here. So the "invite addresses include the relayed address" bullet above becomes: a node holding a reservation publishes its `/p2p-circuit` address through cadre-core's own `collectSelfAddrs` (no host involvement), and the per-node verdict in `/nat/status` counts a held reservation as reachable.
