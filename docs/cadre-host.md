# @serfab/cadre-host

`@serfab/cadre-host` is a self-hosted manager for running cadre nodes on a single always-on machine — the basement PC, the closet NAS, the family server in a spare bedroom. It is a sibling of `@serfab/cadre-provider`, not a mode of it, and ships its own orchestrator, authentication, installer, NAT layer, and local management UI.

This document describes the persona, the package boundary, and the deployment model. Sibling tickets (`cadre-host-process-orchestrator`, `cadre-host-trust-circle`, `cadre-host-nat`, `cadre-host-installer`, `cadre-host-local-ui`) implement the named subsystems.

## Who it's for

The self-host persona is a technically curious, non-operator user who wants a cadre node for themselves and a small trust circle (family, friends, hobby group) without paying a provider and without learning Docker. They have:

- One always-on machine (desktop, laptop in a dock, mini-PC, NAS). It is *not* a server in the operations sense — no monitoring stack, no firewall they understand, no spare hands at 3am.
- A small number of people they trust completely. The trust boundary is social, not cryptographic — these are people who could call them on the phone.
- A residential internet connection: probably NAT, possibly CGNAT, occasionally dynamic IP.
- A willingness to install one app and answer a few setup questions, but no patience for ongoing maintenance.

This persona is the opposite of `@serfab/cadre-provider`'s persona, which is a multi-tenant hosting service with API keys, billing, customer isolation, and Docker. The two packages share the cadre lifecycle model but diverge in nearly every operational concern.

## Package boundary

`@serfab/cadre-host` depends on `@serfab/cadre-provider` only for:

- The `Orchestrator` interface and its request/result/stats types — cadre-host implements its own `HostProcessOrchestrator` that spawns cadre nodes as child processes (no Docker).
- Container lifecycle types (`ContainerStatus`, `ContainerResources`) — reused as-is for status and resource accounting, even though "container" here means "managed child process."

Everything else is bespoke to cadre-host:

| Concern | cadre-provider | cadre-host |
|---|---|---|
| Orchestration | Docker | Native child processes |
| Auth | API keys, JWT | Trust-circle peer identity (libp2p) |
| Tenancy | Multi-tenant with customer isolation | Single household / trust circle |
| Storage | Per-customer billing-aware quotas | Shared volumes on the host filesystem |
| Install | Operator runs Docker | One-shot installer + service-host integration |
| UI | None (API only) | Localhost web UI |
| NAT | Operator's problem | First-class DDNS + UPnP/PCP + relay fallback |

The shared types are too thin to warrant a third package (no `@serfab/cadre-orchestration-core`). If sibling tickets discover a real shared concern, it can be hoisted then.

## Deployment model

One host machine runs the `cadre-host` service. That service manages N cadre nodes as child processes — typically one per member of the trust circle. Friends and family connect to *their* cadre node over libp2p from their phones, laptops, etc. The household admin manages everything through a localhost web UI.

```mermaid
graph TD
    subgraph Host["Host Machine (always-on)"]
        CH["cadre-host service"]
        CH -->|spawns| N1["cadre node (Alice)"]
        CH -->|spawns| N2["cadre node (Bob)"]
        CH -->|spawns| N3["cadre node (Carol)"]
        UI["Local UI<br/>http://localhost:8765"] -.-> CH
    end
    Admin["Household admin<br/>(browser)"] --> UI
    AlicePhone["Alice's phone"] -.->|libp2p<br/>(public, via NAT layer)| N1
    BobLaptop["Bob's laptop"] -.->|libp2p| N2
    Carol["Carol"] -.->|libp2p| N3
```

Two external surfaces:

- **Local UI on `http://localhost:<port>`** — admin-only, no auth beyond "you are on the host." Manage trust circle members, view node status, generate invites.
- **Public libp2p surface** — managed by the NAT layer (DDNS, UPnP/PCP, relay fallback). Each cadre node accepts inbound connections from its corresponding member's other devices, plus connections from peers in the strands those members participate in.

The host process itself is not addressable from the public internet. The NAT layer exposes each cadre node, not the manager.

## Security posture

`cadre-host` is a **trust-circle** system, not a zero-trust one. Two consequences:

1. **Anyone with shell access to the host machine fully controls cadre-host.** This is the same threat model as any desktop application — Spotify, the Steam client, your password manager's desktop app. We do not defend against the household admin's own user account, and we do not pretend to. Disk encryption, OS user accounts, and physical security are the user's responsibility.

2. **Trust-circle members are authenticated cryptographically.** Each member's cadre node has a libp2p peer identity inherited from cadre-core. Joining the circle happens via invite (out-of-band: scan a QR code while sitting on the couch together). No passwords. No API keys. No central account.

The trust-circle invite flow lives in `cadre-host-trust-circle` and reuses the seed bootstrap and invite primitives from cadre-core.

## Trust circle

The trust circle is the set of devices (peers) authorised to participate in the host's cadre. Membership is canonical in cadre-core's `CadrePeer` table on the control network; cadre-host layers two pieces of host-local state on top:

- **Labels** — human-readable display names (`"Mom's phone"`, `"My laptop"`) assigned by the host admin. Display-only; loss just shows the bare peer ID.
- **Pending invites** — tokens that have been issued but not yet redeemed. Operational state; lives on the issuing node only.

Both live in `<rootDir>/trust-circle.json`, written atomically (write-then-rename). If a future ticket wants cross-device label replication, a new `CadreMemberLabel` table can be added to the control schema; for now labels stay local.

### Lifecycle

1. **Issue** — `cadre-host invite "Mom's phone"` (or the management API's `POST /auth/invites`) generates a base64url token, asks cadre-core to mint a `CadreInvite` carrying the host's dialable addresses, persists a pending row, and prints the encoded invite. Default TTL is 24 h; override with `--ttl 7d`.
2. **Deliver** — the encoded invite is shipped out-of-band (QR code rendered by the local UI, copy/paste, etc.).
3. **Redeem** — the recipient's cadre node dials in via cadre-core's `dialInvite`/`acceptPhone` flow. Cadre-host's `redeemInvite` validates the token against the pending row, calls `acceptPhone` (which authorizes the peer in `CadrePeer`), then atomically consumes the pending row and writes a labelled member row. One-time use is enforced by removing the pending row on first redemption.
4. **Revoke / remove** — `cadre-host trust revoke <token>` deletes a pending invite before it's redeemed; `cadre-host trust revoke <peerId>` removes an authorised member (deletes the `CadrePeer` row via a signed delete, then the local label).

In v1 the management-API surface is localhost-only (`127.0.0.1`), so redemption assumes the recipient is on the same machine as the host or on the LAN reaching it. Cross-WAN redemption via the management API requires a future cadre-host-over-P2P ticket.

## NAT and DDNS

Cadre-host runs on machines that are typically behind NAT. To be dialable from the open internet it composes three layers, each fail-safe and independent:

1. **UPnP / NAT-PMP port mapping.** The default is to punch a forward through the upstream router via `@achingbrain/nat-port-mapper`. If the router refuses or doesn't expose UPnP, port mode flips to `failed` and the user is prompted to either set up a manual port forward or fall back to a relay (next bullet). The mapping is refreshed periodically; lease expiry surfaces as `mappingLeaseExpiresAt` in the status snapshot.
2. **Circuit-relay client (deferred).** When the host is unreachable directly (CGNAT or stubborn router) it will eventually consume a libp2p circuit relay so phones can still dial in. The relay-server side already exists in cadre-core (`network.enableRelay`); the client side that *reserves* through a relay is parked in [`backlog/4-relay-bootstrap-infrastructure`](../tickets/backlog/) and will be wired in once that ticket lands. Until then, hosts behind CGNAT will need either IPv6 or manual port forwarding.
3. **Dynamic DNS.** When a stable hostname is desired, cadre-host pushes the current external IP to a DDNS provider. v1 ships **DuckDNS** only; additional providers (Cloudflare, No-IP, Dynu, …) are filed as backlog work and drop into `nat/ddns/` as one file each plus a registry entry.

### External IP detection

Cadre-host queries its external IP from two independent sources and compares them:

- **Router-side** — the WAN IP that the UPnP/NAT-PMP gateway reports for itself.
- **Public side** — an HTTPS GET to one of `api.ipify.org`, `ifconfig.me`, or `icanhazip.com`, first success wins.

When both succeed and disagree, cadre-host flags `cgnatDetected: true` — the textbook signature of CGNAT, where the router thinks it has a public address that's really private to the carrier. The verdict is informational, not enforced; the heuristic can also misfire on dual-stack networks, sliced VPNs, or flapping IPs.

### Reachability verdict

The `directReachability` field in the status snapshot is best-effort:

| Conditions                                | Verdict        |
|-------------------------------------------|----------------|
| `cgnatDetected: true`                     | `cgnat`        |
| `portMode: auto-upnp` / `auto-natpmp`     | `reachable`    |
| `portMode: failed`                        | `unreachable`  |
| manual config / `upnpEnabled: false`      | `unknown`      |

This is a heuristic, not a real dial-back. A future ticket will enable libp2p's AutoNAT service in `@optimystic/db-p2p`'s `libp2p-node-base.ts` and use its verdict here.

### DuckDNS setup

1. Register a subdomain at <https://www.duckdns.org/>. Note the token shown after sign-in.
2. With cadre-host running, configure the provider:
   ```sh
   cadre-host nat ddns set duckdns --hostname foo.duckdns.org --token <token>
   ```
   The token is sent over loopback to the management API and persisted via the OS keychain (or a 0600 fallback file — see below). The update loop runs immediately and then every five minutes; unchanged IPs are *not* re-pushed (DuckDNS appreciates this).
3. To inspect: `cadre-host nat status` shows the configured hostname, the last update result, and any error.

If you'd rather manage DNS yourself (e.g. via the router's built-in DuckDNS client), tell cadre-host *not* to update the record:

```sh
cadre-host nat ddns external --hostname foo.duckdns.org
```

cadre-host then surfaces the hostname in invites and status but never makes an update request.

### Invite address resolver

The host's NAT layer hooks into cadre-core through the `network.inviteAddressResolver` option on `CadreNodeConfig`. Cadre-core's `SeedBootstrapService.createInvite` consults this resolver first; cadre-host's `NatService.getInviteAddresses()` returns:

- `/dns4/<hostname>/tcp/<externalPort>/p2p/<peerId>` when DDNS is configured and reachability is `reachable`,
- `/ip4/<externalIp>/tcp/<externalPort>/p2p/<peerId>` when only the raw IP is known,
- the libp2p multiaddrs otherwise (including any `/p2p-circuit/` addresses once the relay-client work lands).

### Credential storage

DDNS tokens are stored in the OS keychain via `keytar` (service: `sereus-cadre-host`, account: `ddns:<providerId>:<field>`). When `keytar` is unavailable (missing native build tooling, no DBus secret service on a headless Linux box, etc.) cadre-host falls back to a plain JSON file at `<rootDir>/nat-secrets.json` with mode `0600`. The fallback is logged on every write:

```
[cadre-host] DDNS credentials will be stored UNENCRYPTED at <rootDir>/nat-secrets.json (keytar not installed). Install keytar's native dependencies for OS keychain protection.
```

On Windows POSIX permission bits don't apply, so the file is readable by any account on the same machine — install keytar's native dependency to avoid that.

### Process integration

`NatService` is constructed and owned by `cadre-host-local-ui` (same pattern as `TrustCircleService`). The local-ui ticket:

1. Constructs `new NatService({ rootDir, cadreNode })` where `cadreNode` exposes `getPeerId()` and `getMultiaddrs()`.
2. Calls `await service.start()` after the libp2p node is up.
3. Mounts `createNatHandlers(service)` on Fastify under `/nat/*` (`GET /nat/status`, `POST /nat/test`, `PUT /nat/ddns`, `PUT /nat/settings`).
4. Calls `await service.stop()` on shutdown to release the UPnP lease.
5. Wires `service.getInviteAddresses.bind(service)` as `network.inviteAddressResolver` on the cadre-core `CadreNodeConfig`.

## Architecture sketch

```mermaid
graph TD
    UI["Local UI<br/>(fastify on 127.0.0.1)"]
    Mgmt["Management API"]
    Orch["HostProcessOrchestrator"]
    TC["TrustCircleAuth"]
    NAT["NAT layer<br/>(DDNS · UPnP/PCP · relay)"]
    Install["Installer + service-host"]
    UI --> Mgmt
    Mgmt --> Orch
    Mgmt --> TC
    Mgmt --> NAT
    Orch --> N1["cadre node (child process)"]
    Orch --> N2["cadre node (child process)"]
    Orch --> NN["..."]
    Install -.-> Mgmt
```

The five named subsystems are each owned by a sibling ticket. This package establishes the surface they plug into — empty stubs in v0.x foundation, real implementations as each ticket lands.

## Status

**v0.x foundation.** This release contains:

- Workspace package skeleton (`packages/cadre-host/`).
- `HostProcessOrchestrator` — runs cadre nodes as native child processes.
- `TrustCircleService` + `TrustCircleStore` — invite issuance/redemption/revocation and the local labels file.
- `NatService` + `NatStore` — UPnP/NAT-PMP port mapping, external-IP detection w/ CGNAT flag, DuckDNS dynamic DNS, secrets storage (keytar + 0600 fallback), and an `inviteAddressResolver` hook into cadre-core's invite flow.
- CLI: `invite <label>` (real), `trust list`, `trust revoke`, `nat status`, `nat test`, `nat ddns set`, `nat ddns external`, `nat settings`; `install` / `uninstall` / `status` run the installer (`6.4.1`) — wizard, identity persistence, `host.config.json`, and service-host registration (systemd/launchd/NSSM). `start` loads config + identity and waits on SIGTERM as a placeholder for the local UI HTTP listener.
- Re-exports of the `Orchestrator` and container lifecycle types from `@serfab/cadre-provider` so consumers have a single import surface.

The local UI HTTP server is forthcoming in the `cadre-host-local-ui-server` ticket (`6.5.1`). Until it lands, `cadre-host start` keeps the service-host unit alive but does not yet expose `/auth/*` or `/nat/*` routes — `NatService` and `TrustCircleService` are libraries waiting for that server to construct and host them. The installer's "first enrollment invite" step degrades silently in the meantime.

## See also

- [architecture.md](architecture.md) — overall cadre architecture, control network, and strand lifecycle.
- [@serfab/cadre-provider](../packages/cadre-provider/README.md) — the multi-tenant sibling.
- [@serfab/cadre-core](../packages/cadre-core/README.md) — the underlying cadre node library.
