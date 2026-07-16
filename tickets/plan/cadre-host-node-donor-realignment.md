----
description: cadre-host wrongly acts as the creator/owner of a cadre; realign it to match the intended design where it donates nodes (run as OS services) to an external requesting cadre, the same way cadre-provider donates container nodes.
files: packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-host/src/authority/authority-node-client.ts, packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-cli/src/commands/start.ts, docs/cadre-host.md, docs/architecture.md, packages/integration-tests/src/scenarios/cadre-host-authority-node.integration.ts
difficulty: hard
----

## Problem

cadre-host is currently built around the assumption that the host machine **founds and owns** a cadre. This was confirmed against the code and docs; it is the opposite of the intended design.

Intended design (from the project owner):

> cadre-provider allows a user (usually from a mobile app) to ask for and receive an additional node to add to **their** cadre, by spawning a container. cadre-host is the same — give a requesting cadre authority a node to add to **their** cadre — but instead of containers, via the OS's services mechanism.

In other words: **the requester's device (e.g. the phone) is and remains the cadre's authority. The host contributes capacity; it never holds the authority key for the cadres it serves.**

## Current (wrong) behavior — evidence

- `packages/cadre-host/src/bin/host.ts` (~line 283): the manager spawns an "admin's authority node" with `partyId: cfg.installId` — the party id is minted by the host install itself, not supplied by a requesting user.
- `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts` (`buildAuthorityChildConfig`, ~line 690): the authority child gets `bootstrapNodes: []`; the docstring says "it is the founding node".
- `packages/cadre-cli/src/commands/start.ts` (~lines 261–290): `--authority` runs a **genesis**: derives an authority key from the host's own libp2p identity, inserts it as the founding `AuthorityKey`, and initializes seed-bootstrap so the host node can mint invites and authorize peers.
- `packages/cadre-host/src/auth/trust-circle.ts`: the invite direction is inverted — the **host** issues invites and phones join the **host's** cadre via `acceptPhone`. Intended flow is the reverse: the user's authority adds the host's donated node to the **user's** cadre.
- `docs/cadre-host.md` codifies the wrong model throughout ("self-host persona … wants a cadre node for themselves and a small trust circle", "cadre-host runs on a machine that *does* hold the admin's authority identity"). Docs and code agree with each other; both diverge from the intended design — the drift happened at the design-doc level.

## What already exists and matches the intended design

The provider-parity machinery is largely present but unexposed in cadre-host:

- `HostProcessOrchestrator` implements cadre-provider's `Orchestrator` interface. `createContainer` spawns a generic node with a **caller-supplied** `partyId` + `bootstrapNodes` and returns `seedEndpoint` + `seedToken` — exactly the donate-a-node flow.
- cadre-core has the full requester side: `addDrone` (authorize peer + create seed), the node's authenticated `POST /seed`, and invite-pinned seed trust (`pinnedKeyTrustPolicy`) so a cold node only accepts a seed signed by the requester's authority.
- cadre-provider's HTTP surface (`packages/cadre-provider/src/server/routes.ts`) is the reference shape: `POST /containers` (create with partyId/bootstrapNodes), `GET /containers/:id/peer` (peer id + multiaddrs for the requester's `addDrone`), `PUT /containers/:id/seed` (provider presents the seedToken to the node on the requester's behalf), `DELETE /containers/:id`. Scoped-permission auth per customer.
- But in cadre-host nothing calls this: `packages/cadre-host/src/server/routes/nodes.ts` returns **501 not_implemented** for generic node spawn, and there is no request/grant API for an external cadre authority.

## Required outcome (specification)

1. **Host as node donor.** An external cadre authority (typically a mobile app) can request a node from a cadre-host install; the host spawns/provisions the node; the requester's authority authorizes it (`addDrone`) and delivers the seed; the node joins the **requester's** cadre. The host never learns or holds the requester's authority key.
2. **Provider parity for the grant lifecycle.** Request → provision → peer-info → seed → (later) terminate, mirroring cadre-provider's container lifecycle semantics (including seedToken staying server-side, never crossing to the requester).
3. **OS-services mechanism.** Donated nodes run under the host OS's service manager (systemd / launchd / Windows service) rather than Docker — this is the differentiator vs. provider. Note: today's orchestrator spawns detached child processes, not registered OS services; the installer already has service-host scaffolds (`packages/cadre-host/src/installer/service-host/`). The plan must decide how far to take service registration for donated nodes vs. keeping the detached-child model for v1 (detached children already survive manager restarts; per-node OS services add boot-time autostart).
4. **Grant authorization model.** Provider gates requests with API keys + billing quotas. cadre-host's persona is friends/family — the plan must specify what gates "who may ask this host for a node" and quota per grantee. A natural direction: repurpose the existing trust-circle invite/token machinery as *grant* tokens (host admin issues a grant invite out-of-band; requester redeems it to provision), but this is a design decision to settle in planning.
5. **Reachability of the request API.** Provider's API is a public HTTPS endpoint. The host is a residential machine behind NAT; the management API is deliberately loopback-only. The plan must specify how the requesting phone reaches the request/grant surface (options include: NAT-mapped public port via the existing NatService/DDNS machinery, or carrying the request over libp2p to a host-side node). This is the main genuinely open design question.
6. **Demote or remove the host-as-founder path.** `ensureAuthorityNode` + `cadre-cli start --authority` genesis + host-issued trust-circle membership invites must stop being the core model. Decide their fate explicitly: removed, or retained only as an optional "the host machine's owner also wants their own cadre here" convenience — and if retained, clearly separated from the donor role. Project instruction "no backwards compat yet" applies: prefer removal/rework over compatibility shims.
7. **Docs realigned.** `docs/cadre-host.md` rewritten around the donor model; `docs/architecture.md` checked for the same drift. `docs/STATUS.md` updated.
8. **Tests realigned.** `packages/integration-tests/src/scenarios/cadre-host-authority-node.integration.ts` exercises the founder flow; replace/extend with a scenario where an external authority (a second node acting as the phone) requests a node from cadre-host, seeds it, and the node syncs into the requester's cadre.

## Edge cases & interactions (for downstream implement tickets to carry forward)

- Requester disappears after provision but before seeding (orphaned unseeded node — reap policy).
- Grant token replay / double-redemption.
- Host restart mid-lifecycle: persisted handles must survive across request→seed gap (state-store already persists handles; verify seedToken persistence semantics — provider had a bug here previously, see `tickets/complete/cadre-provider-seed-endpoint-never-populated.md`).
- One host serving multiple distinct cadres concurrently (port allocation, per-party workdirs — orchestrator already keys by containerId; confirm no partyId-uniqueness assumptions).
- Push-credential fan-out: current wiring assumes host's own party; donated storage nodes belong to foreign parties — decide whether the host's FCM/APNs credentials apply to them.
- NAT: donated node must be dialable by the requester's cadre (p2p port mapping per node, not just for the single authority node the NatService currently serves).
