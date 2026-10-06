description: Every node cadre-host runs must be reachable from outside the home network, through an automatic router port mapping or a port the user forwards by hand, and must advertise those public addresses; otherwise it cannot serve as an always-on member of a cadre.
files: packages/cadre-host/src/nat/nat-service.ts, packages/cadre-host/src/nat/port-mapper.ts, packages/cadre-host/src/nat/address-resolver.ts, packages/cadre-host/src/nat/nat-store.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/server/routes/nat.ts, docs/cadre-host.md
difficulty: medium
----

# Per-node reachability for cadre-host

## Why

A node in your basement is only useful to your cadre if your phone and other devices can dial it from anywhere. Today `NatService` maps one TCP port, for the founder owner node only. Nodes joined to another cadre get no mapping, and nothing maps the `/ws` port a phone dials (a phone has no TCP transport). `/nat/*` is unmounted outside founder mode, and the founder role is being removed (`cadre-host-join-a-cadre`), so NAT handling has to be rebuilt around hosted nodes.

This absorbs the per-node half of the retired `feat-cadre-host-wan-grant-reachability`.

## What to build

- `NatService` always runs and manages one set of mappings per running node, keyed by node id: TCP **and** WebSocket ports through UPnP/NAT-PMP.
- **Manual mode**: when UPnP is off or fails, the user can state the external port they forwarded for each of a node's ports (settings, CLI, UI). The host shows which internal port each node needs forwarded, since that is what the user types into the router. Respawn reuses ports (docs/cadre-host.md → "A respawned node keeps its addresses"), so a forward stays valid.
- Public address resolution per node: external IP or DDNS name plus the mapped (or manually stated) port, for TCP and `/ws`. These go in the join QR (`cadre-host-join-a-cadre`) and are announced by the node so its `CadrePeer` row carries dialable addresses. Pass them to the child as announce addresses (add a cadre-cli `announceAddrs` setting if none exists).
- Status per node: mapped / manual / unreachable, with the existing CGNAT detection. The UI says plainly when a node cannot be reached from outside and what to do about it.
- The relay fallback for CGNAT stays separate (`backlog/feat-cadre-host-children-reserve-on-a-relay`).

## Edge cases & interactions

- Lease renewal for N mappings. A router that caps the mapping count: report failure per node, don't fail all of them. (Test against the fake port mapper.)
- External IP change: re-resolve and get the new announce addresses to running nodes. Choose between a restart and a live update, and document the choice.
- NAT-PMP assigns an external port different from the internal one: advertise the external port.
- A node stopped or removed has its mappings deleted. On host restart, mappings are re-established for nodes that are re-attached.

## TODO

- Generalize `NatService`/`port-mapper` to many mappings; mount `/nat/*` in every role.
- Manual-forward settings, CLI and UI.
- Child announce addresses.
- Update docs/cadre-host.md → NAT and DDNS.
