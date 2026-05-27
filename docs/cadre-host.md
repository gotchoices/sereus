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

One host machine runs the `cadre-host` service. That service is a **management plane only** — a loopback REST/UI control surface. It does **not** itself join any cadre control network and holds no in-process `CadreNode`. Instead it *spawns cadre nodes as child processes* and drives them over a local management channel, exactly as `@serfab/cadre-provider` spawns Docker drones and drives them over its REST API (see [architecture.md § Provider Integration](architecture.md#provider-integration)). The household admin manages everything through a localhost web UI; friends and family connect to the cadre over libp2p from their phones, laptops, etc.

### Control-plane separation (load-bearing principle)

There are two distinct planes, and conflating them is the mistake this section exists to prevent:

- **Management plane** — how you talk *to* cadre-host: the loopback HTTP API + Svelte UI (and the `cadre-host` CLI, which is a thin HTTP client of that same API). This is *not* a cadre control network. It carries no authority keys on the wire and grants no cadre membership; it is same-machine admin access (see [Security posture](#security-posture)).
- **Cadre control network** — the party's private Optimystic network (`CadreControl` schema) that only *cadre nodes* join. Authority operations (mint invite, `authorizePeer`, `removePeer`, report multiaddrs) happen **inside a cadre node**, never inside the manager process.

cadre-host runs on a machine that *does* hold the admin's authority identity (unlike a provider, which never holds keys — architecture.md line 524). The consequence is **not** that the manager joins the control network; it is that one of the cadre nodes the manager spawns — the admin's **authority node** — carries that identity, and the manager delegates authority operations to it over the management channel.

**Topology: a single household authority node.** cadre-host spawns exactly one cadre node — the admin's **authority node**, which founds/joins the party's control network and carries the host identity. Trust-circle members are *not* separate hosted nodes; they are `CadrePeer` rows (devices that dial in over libp2p), consistent with architecture.md's definition of a cadre as a single party's nodes sharing one control network. (Additional non-authority nodes can still be spawned via the orchestrator for scaling, but the manager only spawns and delegates to the one authority node.)

```mermaid
graph TD
    subgraph Host["Host Machine (always-on)"]
        CH["cadre-host service<br/>(management plane — no control network)"]
        AN["authority cadre node<br/>(child process — joins control network)"]
        CH -->|spawns + delegates over loopback admin channel| AN
        UI["Local UI<br/>http://localhost:8765"] -.-> CH
    end
    Admin["Household admin<br/>(browser)"] --> UI
    AlicePhone["Alice's phone"] -.->|libp2p<br/>(public, via NAT layer)| AN
    BobLaptop["Bob's laptop"] -.->|libp2p| AN
    Carol["Carol's devices"] -.->|libp2p| AN
```

Two external surfaces:

- **Local UI on `http://localhost:<port>`** — admin-only, no auth beyond "you are on the host." Manage trust circle members, view node status, generate invites.
- **Public libp2p surface** — managed by the NAT layer (DDNS, UPnP/PCP, relay fallback). Each cadre node accepts inbound connections from its corresponding member's other devices, plus connections from peers in the strands those members participate in.

The host process itself is not addressable from the public internet. The NAT layer exposes each cadre node, not the manager.

### Node admin channel (management-channel transport)

The management channel between the manager and its authority node is a **loopback HTTP admin surface** exposed by the spawned `cadre-cli start` child, not an in-process `CadreNode`. This is what lets the node carry the authority identity while the manager stays out of the control plane (and survives an orchestrator restart — a `127.0.0.1` port re-attaches where a stdio pipe could not).

An ordinary node becomes the authority node via two `cadre-cli start` flags (no separate entrypoint):

- `--authority` — after `node.start()`, bridges the node's libp2p Ed25519 identity into the base64url authority keypair (`authorityKeyFromLibp2p`), performs an **idempotent genesis** `AuthorityKey` insert on a fresh party (skipped when one already exists), and initializes seed-bootstrap so the node can mint invites and authorize peers. The node's peer identity and its authority key are the *same* keypair.
- `--admin-port <port>` (or `CADRE_ADMIN_PORT`) — binds the admin listener on `127.0.0.1:<port>`. It refuses to bind without `CADRE_STARTUP_TOKEN`, which doubles as the `Authorization: Bearer <token>` secret (constant-time compared).

The node is given its identity via the child config's `identity.protobufKeyFile` (the installer's protobuf `identity.key`) or the `--identity-protobuf <path>` flag.

Routes (all under `/admin`, provider-style `{ ok, data }` / `{ ok:false, error:{ code, message } }` envelope; error codes `not_authorized` → 401, `not_ready` → 503, `bad_request` → 400, `internal` → 500):

| Method & path | Purpose |
|---|---|
| `GET /admin/identity` | `{ peerId, partyId }` |
| `GET /admin/multiaddrs` | observed libp2p addrs |
| `GET /admin/members` | `CadrePeer` enumeration (replaces handing a `ControlDatabase` to the manager) |
| `GET /admin/members/:peerId` | membership probe |
| `POST /admin/invites` | mint a `CadreInvite` → `{ invite, encodedInvite }` |
| `POST /admin/accept-phone` | authorize a redeeming peer |
| `DELETE /admin/members/:peerId` | signed `CadrePeer` delete |
| `PUT /admin/invite-addresses` | push NAT-resolved invite addresses (resolver transport) |

`encodeInvite` needs no route: the mint route already returns `encodedInvite`. Invite addresses use a **push** model — the manager `PUT`s NAT-resolved addresses at spawn and on every NAT change; the node holds the latest set and embeds them in subsequent invites, falling back to `libp2pNode.getMultiaddrs()` when none have been pushed. Push (host→node) is chosen over a callback so the control-network node never needs to know or dial the manager's address.

This node-side surface is established by `cadre-node-admin-channel`; `cadre-host-delegated-authority-node` (6.7) builds the manager-side adapters that spawn the node and consume these routes, and finalizes the topology reconciliation noted above (single household authority node, members as `CadrePeer` rows).

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

Authority operations (steps 1, 3, 4) are **delegated to the host's authority cadre node** over the management channel — the manager generates/validates the token and owns the pending/label state, but the `CadreInvite` mint, `acceptPhone`, and signed `CadrePeer` delete all execute inside the node, against its control-network DB. The manager never opens the control DB itself.

1. **Issue** — `cadre-host invite "Mom's phone"` (or the management API's `POST /auth/invites`) generates a base64url token, asks the authority node to mint a `CadreInvite` carrying the host's dialable addresses, persists a pending row, and prints the encoded invite. Default TTL is 24 h; override with `--ttl 7d`.
2. **Deliver** — the encoded invite is shipped out-of-band (QR code rendered by the local UI, copy/paste, etc.).
3. **Redeem** — the recipient's cadre node dials in via cadre-core's `dialInvite`/`acceptPhone` flow. Cadre-host's `redeemInvite` validates the token against the pending row, asks the authority node to run `acceptPhone` (which authorizes the peer in `CadrePeer`), then atomically consumes the pending row and writes a labelled member row. One-time use is enforced by removing the pending row on first redemption.
4. **Revoke / remove** — `cadre-host trust revoke <token>` deletes a pending invite before it's redeemed; `cadre-host trust revoke <peerId>` removes an authorised member (the authority node deletes the `CadrePeer` row via a signed delete, then the manager drops the local label).

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

`NatService` is constructed and owned by the manager process (`cadre-host start`), same pattern as `TrustCircleService`. Its `cadreNode` dependency is a **management-channel adapter to the spawned authority node**, not an in-process libp2p node — `getPeerId()` / `getMultiaddrs()` query the node over that channel. The wiring:

1. Constructs `new NatService({ rootDir, cadreNode })` where `cadreNode` proxies `getPeerId()` and `getMultiaddrs()` to the authority node.
2. Calls `await service.start()` once the authority node is up and reporting addresses.
3. Mounts `createNatHandlers(service)` on Fastify under `/nat/*` (`GET /nat/status`, `POST /nat/test`, `PUT /nat/ddns`, `PUT /nat/settings`).
4. Calls `await service.stop()` on shutdown to release the UPnP lease.
5. Installs `service.getInviteAddresses` as the authority node's `network.inviteAddressResolver` — set in the `CadreNodeConfig` the orchestrator passes when it spawns that node, so cadre-core's `SeedBootstrapService.createInvite` consults the host's NAT-resolved addresses. (Because the resolver lives in the manager while the node runs in a child, this is the one cross-plane hook the realignment ticket must design a transport for — e.g. resolved addresses pushed to the node at spawn/refresh time rather than a synchronous in-process callback.)

## Updates

cadre-host fetches a signed manifest from `https://releases.serfab.io/cadre-host/latest.json` once on `start` and every 24 h thereafter. The manifest is an Ed25519-signed envelope `{ manifest, sig }` where the inner manifest carries `version`, `publishedAt`, an `npm.{ package, tag }` hint, and an optional `minPreviousVersion` step gate. The release public key is embedded in the binary; `CADRE_HOST_UPDATE_DEV_KEY` overrides it for CI / local signing.

**Notify-by-default.** A successfully verified manifest with `version > current` writes an `available` record into `<dataDir>/update-state.json`; the local UI surfaces it as a banner with an explicit "Apply now" action. Auto-apply is opt-in (`updates.autoApply: true` in `host.config.json`, settable from the UI's settings page). Signature failures are recorded as `lastError` so the UI can warn; network failures stay silent.

**Apply flow.** Re-fetch + re-verify the manifest, record `applyInProgress`, run `npm install -g <pkg>@<version>` (5-minute timeout), then ask the platform's `ServiceHost.restart(...)` to pick up the new binary (`systemctl --user restart`, `launchctl kickstart`, or `nssm restart`). On install failure the previous version is reinstalled and the error is surfaced; the still-running old binary continues to serve. Restart failures are non-fatal — the binary swap already succeeded, so the user can restart manually.

`UpdateService` lives in `src/update/` and exposes `createUpdateHandlers(service)` for the local-UI HTTP routes (`GET /update`, `POST /update/apply`, `GET/PUT /update/settings`); `cadre-host start` constructs the service so the daily timer and `update-state.json` are populated regardless of whether the UI has bound its routes yet.

## Local UI server

The local-UI server (`6.5.1-cadre-host-local-ui-server`) is the long-lived HTTP listener launched by `cadre-host start`. The Svelte SPA that consumes it ships in `6.5.2-cadre-host-local-ui-spa`.

### Binding & origin policy

- Bound to **`127.0.0.1`** only — never `0.0.0.0`. The OS firewall does not see this socket from another machine.
- An **origin guard** rejects any request whose `Host` header isn't `127.0.0.1[:port]` or `localhost[:port]` (case-insensitive), and any request whose `Origin` header (when present) doesn't match one of those origins. This defeats DNS-rebind from a malicious page that resolves its own hostname to `127.0.0.1`.
- **Port collision**: if the configured `uiPort` is in use, the server tries `uiPort+1..uiPort+9`. On total failure it exits non-zero with a clear message naming every port attempted. Re-configure `uiPort` in `host.config.json` and reinstall the service.

### No login

cadre-host is a same-machine management surface. Any local process running as the cadre-host user can already read identity files, mutate the trust circle, install global npm packages, and (with root) restart the service. A web-form password adds no real defence — it would protect the *non-existent* threat model "attacker is on this machine but can't run code as the cadre-host user". Don't add auth here; harden the host OS instead.

### API surface

| Path | Method | Purpose | Errors |
|---|---|---|---|
| `/api/status` | GET | Aggregated dashboard snapshot | — |
| `/api/nodes` | GET | List managed cadre nodes (orchestrator handles) | — |
| `/api/nodes/:id` | GET | One node's detail + stats | 404 unknown |
| `/api/nodes/:id/logs?lines=N` | GET | Tail of `node.log` (default 200, max 2000) | 404 unknown |
| `/api/nodes/:id/stop` | POST | Stop a running node | 404 unknown |
| `/api/nodes/:id/{start,restart}` | POST | Lifecycle stub — v1 has no auto-spawn path (see honest-gap below) | 501 not_implemented |
| `/api/settings` | GET/PUT | `host.config.json` passthrough (PUT is whitelisted) | 400 invalid_setting |
| `/api/events` | GET | Server-Sent Events stream | — |
| `/auth/*` | various | Trust-circle (matches CLI) — `POST /auth/invites`, `GET /auth/trust-circle`, `DELETE /auth/invites/:token`, `DELETE /auth/members/:peerId` | mapped from `TrustCircleError.code` |
| `/nat/*` | various | NAT/DDNS (matches CLI) — `GET /nat/status`, `POST /nat/test`, `GET /nat/providers`, `PUT /nat/ddns`, `PUT /nat/settings` | mapped from `NatError.code` |
| `/update/*` | various | Update flow — `GET /update`, `POST /update/apply`, `GET/PUT /update/settings` | mapped from `UpdateErrorException.code` |
| `/` (any GET) | — | SPA bundle (or placeholder HTML when `dist/ui/` is absent) | — |

Error payloads use the same envelope as cadre-provider: `{ ok: false, error: { code, message } }`. Status mapping is encoded in `src/server/error-handler.ts`.

### Server-Sent Events

`GET /api/events` returns `text/event-stream` and pushes:

| Event | When |
|---|---|
| `node-state-changed` | A managed node transitions running ↔ stopped |
| `trust-circle-changed` | An invite is issued / redeemed / revoked, or a member is removed |
| `connectivity-changed` | NAT settings change, reachability re-tested, server boot |
| `update-available` | A new release version is observed |

A `: heartbeat` comment is sent every 15 s so corporate proxies don't time out idle connections; the wire format also includes a `retry: 5000` hint. Listeners are cleaned up on client disconnect — `bus.listenerCount()` drops back to zero.

### Write-whitelist for `/api/settings`

The SPA's settings page reads the full `host.config.json` (so it can show read-only fields) but only accepts these PUT keys:

| Key | Accepted? | Notes |
|---|---|---|
| `upnpEnabled` | yes | Propagated to `NatService.putSettings` immediately |
| `updates.autoApply` | yes | Propagated to `UpdateService.putSettings` |
| `updates.manifestUrl` | yes | Propagated to `UpdateService.putSettings` (env var still wins) |
| `uiPort`, `libp2pPort`, `dataDir`, `identityPath`, `installId`, `installedAt`, `installerVersion`, `version` | **no** | Edit at install time or directly in `host.config.json` and restart |

Unknown keys → 400 `invalid_setting`.

### Honest gaps

- `/api/nodes/:id/{start,restart}` are real **for the authority node** — they re-spawn it from the persisted `AuthoritySpawnConfig`. Generic per-member node spawn-from-saved-config is out of scope and returns **501 not_implemented**; unknown ids 404. Stop on any running node works.
- **Signed `CadrePeer` delete is blocked upstream.** `removeMember` / `DELETE /admin/members/:peerId` reaches the authority node, but the node-side delete currently throws a Quereus deferred-constraint error ("No row context found for column PeerId"). Tracked by the fix ticket `quereus-cadrepeer-delete-no-row-context`; the cadre-host integration test for the remove cycle is `it.skip`'d until it lands. Invite issuance/redemption, membership listing, and invite-address push all work.
- The SPA is shipped by `6.5.2-cadre-host-local-ui-spa`. It ships into `<package>/dist/ui/` and is mounted by the static handler. When `dist/ui/` is absent (e.g. running from a source checkout without `yarn build`), `/` returns a placeholder HTML pointing at the build instructions; the API continues to answer.

## Architecture sketch

```mermaid
graph TD
    subgraph MP["Management plane (manager process — no control network)"]
        UI["Local UI<br/>(fastify on 127.0.0.1)"]
        Mgmt["Management API"]
        Orch["HostProcessOrchestrator"]
        TC["TrustCircleService<br/>(token + label/pending state)"]
        NAT["NAT layer<br/>(DDNS · UPnP/PCP · relay)"]
        Upd["UpdateService<br/>(signed manifest)"]
        Install["Installer + service-host"]
    end
    UI --> Mgmt
    Mgmt --> Orch
    Mgmt --> TC
    Mgmt --> NAT
    Mgmt --> Upd
    Upd -. "npm install -g + ServiceHost.restart" .-> Install
    Orch -->|spawns| AN["authority cadre node<br/>(child process — joins control network)"]
    Orch --> NN["other cadre node(s)<br/>(child processes)"]
    TC -. "delegate: createInvite / acceptPhone / removePeer<br/>(management channel)" .-> AN
    NAT -. "getPeerId / getMultiaddrs · inviteAddressResolver" .-> AN
    Install -.-> Mgmt
```

The dotted lines from `TC`/`NAT` to the authority node are the **management channel** (local IPC / loopback), *not* the control network — only the spawned cadre nodes (`AN`, `NN`) join control networks. The five named subsystems are each owned by a sibling ticket; this package establishes the surface they plug into. The trust-circle/NAT → authority-node delegation is the subject of the realignment work tracked in `tickets/` (`cadre-host-delegated-authority-node`).

## Status

**v0.x foundation.** This release contains:

- Workspace package skeleton (`packages/cadre-host/`).
- `HostProcessOrchestrator` — runs cadre nodes as native child processes.
- `TrustCircleService` + `TrustCircleStore` — invite issuance/redemption/revocation and the local labels file.
- `NatService` + `NatStore` — UPnP/NAT-PMP port mapping, external-IP detection w/ CGNAT flag, DuckDNS dynamic DNS, secrets storage (keytar + 0600 fallback), and an `inviteAddressResolver` hook into cadre-core's invite flow.
- CLI: `invite <label>`, `trust list`, `trust revoke`, `nat status`, `nat test`, `nat ddns set`, `nat ddns external`, `nat settings`; `install` / `uninstall` / `status` run the installer (`6.4.1`) — wizard, identity persistence, `host.config.json`, and service-host registration (systemd/launchd/NSSM). `start` loads config + identity, **spawns the admin's authority node as a managed child and delegates authority operations to it over the loopback admin channel** (`6.6`/`6.7`), brings up the trust-circle / NAT / update services, and binds the Fastify management server on `127.0.0.1:<uiPort>` (`6.5.1`). `ui` prints + opens the local-UI URL.
- Authority-node delegation (`6.7`): `AuthorityNodeClient` (`src/authority/`) is an HTTP client of the node's loopback admin channel implementing the trust-circle + NAT `CadreNodeLike` shapes plus `pushInviteAddresses`. `TrustCircleService` and `NatService` hold this client instead of an in-process `ControlDatabase`; the manager never joins the control network. Unreachable-node failures surface as `node_unavailable` (→ 503), and trust-circle listing degrades to the local labels file.
- `UpdateService` + `UpdateStateStore` — signed-manifest fetch/verify (Ed25519), `<dataDir>/update-state.json`, `npm install -g` with rollback, and a `ServiceHost.restart(...)` hook for picking up the new binary.
- Local UI server (`6.5.1`) — Fastify on 127.0.0.1 with origin guard, error envelope, SSE bus at `/api/events`, status / nodes / settings routes, and a static SPA mount. See the [Local UI server](#local-ui-server) section above.
- Local UI SPA (`6.5.2`) — Svelte 5 single-page app (Home / Trust Circle / Connectivity / Nodes + per-node detail / Settings) hosted by the same Fastify instance. Built via `yarn workspace @serfab/cadre-host build` into `<package>/dist/ui/`. EventSource-driven live updates; hash-routed so the server needs no SPA-fallback rewrite. ≈ 43 KB gzipped.
- Re-exports of the `Orchestrator` and container lifecycle types from `@serfab/cadre-provider` so consumers have a single import surface.

**Control-plane realignment landed (`6.6`/`6.7`).** The manager spawns the admin's authority cadre node via `HostProcessOrchestrator` and delegates authority/membership/identity operations to it over the node's loopback admin channel (`AuthorityNodeClient`). The earlier throwing stubs (`missingCadreNodeStub` / `missingNatNodeStub`) are gone, and the manager holds no in-process `ControlDatabase` — it is purely a management plane (see [Control-plane separation](#control-plane-separation-load-bearing-principle)). The one remaining gap is the upstream Quereus `CadrePeer` delete bug (see [Honest gaps](#honest-gaps)).

## See also

- [architecture.md](architecture.md) — overall cadre architecture, control network, and strand lifecycle.
- [@serfab/cadre-provider](../packages/cadre-provider/README.md) — the multi-tenant sibling.
- [@serfab/cadre-core](../packages/cadre-core/README.md) — the underlying cadre node library.
