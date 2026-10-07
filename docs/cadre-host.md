# @serfab/cadre-host

`@serfab/cadre-host` is a self-hosted manager that runs always-on nodes for cadres that live on people's phones. It runs on one always-on machine — the basement PC, the closet NAS, the family server in a spare bedroom — and its one action is **Join a cadre**: it starts a node and shows a QR code, the phone that owns a cadre scans it, and the node becomes a member of that cadre. Your own cadre comes first; a friend's gets a node here when they scan a code you show them. The phone stays the authority for its cadre: the host holds no owner key, admits no one to anything, and never runs a cadre of its own.

`@serfab/cadre-provider` hosts nodes for paying tenants in Docker; cadre-host runs its nodes as OS-managed child processes, for free. It is a sibling of cadre-provider, not a mode of it, and ships its own orchestrator, hosted-node layer, installer, NAT layer and local management UI.

## Who it's for

A technically curious user who is not an operator: they run one always-on box and want the cadre on their phone, and maybe a friend's or a family member's, to have a node that is up when the phones are not, without paying a provider and without learning Docker. They have:

- One always-on machine (desktop, laptop in a dock, mini-PC, NAS). It is *not* a server in the operations sense: no monitoring stack, no firewall they understand, no spare hands at 3am.
- A residential internet connection: probably NAT, possibly carrier-grade NAT (CGNAT), occasionally a dynamic IP.
- A willingness to install one app and answer a few setup questions, but no patience for ongoing maintenance.

Nothing on the host is configured per person. A node belongs to whoever scans its code, or to the cadre whose invitation the admin pastes, so the only decision the admin makes is whom to show a code to.

This persona is the opposite of `@serfab/cadre-provider`'s, a multi-tenant hosting service with API keys, billing, customer isolation and Docker. The two packages share the `Orchestrator` contract and diverge in nearly every operational concern.

## Package boundary

`@serfab/cadre-host` depends on `@serfab/cadre-provider` only for:

- The `Orchestrator` interface and its request/result/stats types. cadre-host implements its own `HostProcessOrchestrator`, which spawns cadre nodes as child processes (no Docker).
- Container lifecycle types (`ContainerStatus`, `ContainerResources`), reused as-is for status and resource accounting, even though "container" here means "managed child process."

Everything else is bespoke to cadre-host:

| Concern | cadre-provider | cadre-host |
|---|---|---|
| Orchestration | Docker | Native child processes |
| Auth | API keys, JWT | None on the loopback management surface; admission to a cadre is a claim or an invitation, checked by the cadre's own nodes, never by anything the host holds |
| Tenancy | Multi-tenant with customer isolation | One household's machine; each node belongs to the cadre that claimed or admitted it |
| Storage | Per-customer billing-aware quotas | Shared volumes on the host filesystem |
| Install | Operator runs Docker | One-shot installer + service-host integration |
| UI | None (API only) | Localhost web UI |
| NAT | Operator's problem | First-class DDNS + UPnP mapping of every hosted node's ports, with manual forwards; relay fallback not wired yet (see [NAT and DDNS](#nat-and-ddns)) |

The shared types are too thin to warrant a third package (no `@serfab/cadre-orchestration-core`). A real shared concern can be hoisted when one appears.

## Deployment model

One host machine runs the `cadre-host` service. That service is a **management plane only**: a loopback REST API and web UI, with a CLI that is a client of the same API. It joins no cadre control network and holds no in-process `CadreNode`. It *spawns cadre nodes as child processes* and follows them over their own `/status` endpoints, as `@serfab/cadre-provider` spawns Docker drones and drives them over its REST API (see [architecture.md → Provider Integration](architecture.md#provider-integration)).

**The host holds no owner key and never founds a cadre.** Owner signing happens only on devices people hold (phones, hardware keys), never on a server, because a server holding an owner key could act as the user without the user present (`feat-owner-keys-only-on-user-devices`). Every node the host runs is a member of a cadre whose owner is a phone; the host is, like a provider, a place where nodes run, and "never has access to user keys."

**One kind of node: the hosted node.** Each [Join a cadre](#join-a-cadre) starts one `cadre-cli` child in the `storage` profile, which belongs to the cadre that claims it, or that admits it by invitation. The host runs as many as the admin joins, each in its own working directory with its own identity, ports and cadre ([Hosted nodes](#hosted-nodes)).

```mermaid
graph LR
    subgraph Host["Host machine"]
        Mgr["cadre-host manager<br/>(loopback UI + API, NAT layer)"]
        N1["hosted node hn_a<br/>(member of cadre A)"]
        N2["hosted node hn_b<br/>(member of cadre B)"]
    end
    Admin["Admin's browser or shell<br/>(same machine, or an SSH forward)"] -->|"loopback HTTP"| Mgr
    Mgr -->|"spawns, reads /status"| N1
    Mgr -->|"spawns, reads /status"| N2
    PA["Phone that owns cadre A"] -->|"dials, claims, syncs"| N1
    PB["Friend's phone, owns cadre B"] -->|"dials, claims, syncs"| N2
```

The phones dial the nodes, never the reverse: a phone listens on nothing. At home a phone dials a node's LAN address; away from home it dials the public address the NAT layer maps through the router ([Reachability from outside](#reachability-from-outside)).

### Control-plane separation

There are two distinct planes, and conflating them is the mistake this section exists to prevent:

- **Management plane** — how you talk *to* cadre-host: the loopback HTTP API, the Svelte UI and the `cadre-host` CLI. It is *not* a cadre control network. It carries no owner key and admits no one to a cadre; it is same-machine admin access (see [Security posture](#security-posture)).
- **Cadre control network** — the party's private Optimystic network (`CadreControl` schema), which only cadre nodes join. Each hosted node joins the control network of the cadre that claimed or admitted it, and only the hosted nodes do: the manager joins none. Owner operations (minting an invitation, `authorizePeer`, `removePeer`) are signed on the owner's devices. A hosted node writes only what a member without an owner key may: its own addresses, and rows that an owner-signed invitation or a joiner's consent authorizes.

Two external surfaces:

- **Local UI on `http://localhost:<port>`** — admin-only, no auth beyond "you are on the host." Join a cadre, follow each node's status and connectivity, and remove or reset a node.
- **Public libp2p surface** — each hosted node's TCP and WebSocket ports, mapped by the NAT layer (UPnP or manual port forwards, with DDNS; a relay fallback is not wired yet). Each node accepts connections from the devices of its cadre and from peers in that party's strands.

The manager process itself is not addressable from the public internet. The NAT layer exposes each hosted node, not the manager.

## Join a cadre

The host's one action: the **Join a cadre** button on the local UI's Join page, `cadre-host join`, or `POST /api/hosted-nodes`. There are two ways in, and they differ in which machine dials:

- **By QR code** (claim). The phone that owns the cadre dials the new node and claims it. Works for any cadre, including one whose only member is that phone.
- **By invitation.** The new node dials a member of the cadre and redeems an invitation the owner's app minted. Works only when a member is reachable from this machine, so not for a cadre's first always-on node.

[architecture.md → Which Side Dials](architecture.md#which-side-dials-the-add-a-node-flows-compared) compares both with the other ways to add a machine to a cadre.

### Join by QR code

1. **Start.** `POST /api/hosted-nodes` (empty body) writes the record as `spawning`, spawns the child with a fresh one-time claim secret (32 random bytes) in its environment as `CADRE_CLAIM_SECRET`, and answers `201 { node }` once the child is up, the record now `unclaimed`. The child's config names the placeholder party `unclaimed`; it joins nothing until claimed.
2. **Show the code.** `GET /api/hosted-nodes/:id/claim` reads the child's `/status` and answers `{ payload, peerId, multiaddrs, reachability }`. The payload is cadre-core's `encodeNodeClaimPayload`: text of the form `sereus-join:1.<base64url of JSON naming the peer id, the addresses and the secret>`, which `decodeNodeClaimPayload` reads back and refuses unless every address names that peer id as its destination. The address list is the node's public addresses from the NAT layer (TCP, then WebSocket, each with `/p2p/<peerId>` appended) followed by the node's own non-loopback LAN addresses. The route answers `503 node_unavailable` until the child reports an address, so clients poll it. The CLI prints the payload as a QR code and as text; the Join page shows both, with a copy button.
3. **Scan and claim.** The owner's phone scans the code (or pastes the text), dials an address from it, and presents the secret with `CadreNode.claimNode`. The claim names the cadre: the claim seed carries the claimant's party and owner key, and the node records the claim in its workdir (`claim.json`) and restarts in-process into that party. The rows that authorize the owner arrive over the connection the claim opened; the host takes no part in that.
4. **Joined.** The host polls each unclaimed node's `/status` every 2 seconds. When it reports `claim: 'claimed'` and the claimed party, the record becomes `joined` with `partyId` (from the claim) and `ownerKey` (`/status.node.claimedBy`). A joined node is polled every 15 seconds for `connected` (whether it holds a control connection).

The live states the UI and CLI show follow those reads: waiting for a phone to claim the node, claimed by owner `<first 8 characters of the owner key>` into cadre `<partyId>`, then connected to the cadre.

**A respawn keeps the code valid.** A crash respawns the node from its record with the same party, claim secret, identity key and ports ([Respawn](#respawn-keeping-a-hosted-node-up)), so a code shown before the crash still names a node that answers, and a claimed node comes back as the same peer at the same addresses. Keeping the secret after the claim is deliberate: `cadre-cli` honours `claim.json`, and with the secret still set it answers a rival claimant `already-claimed`.

The orchestrator's own handle list (`/api/nodes`) keeps a node's `partyId` at the placeholder `unclaimed` until its first respawn after the claim; the hosted-node record carries the real party.

### Join by invitation

The owner's app mints a cadre invitation and copies it, and the host starts a node that redeems it at a member of the cadre ([architecture.md → Enrollment Flow: Invitation Redeemed at Any Member](architecture.md#enrollment-flow-invitation-redeemed-at-any-member)). `POST /api/hosted-nodes` with `{ invitation }` (the Join page's paste field, or `cadre-host join --invitation <encoded>`) decodes the bundle with cadre-core's `decodeCadreInvitation` and answers `400 invalid_request` with the decoder's reason before anything is written or spawned. Otherwise it writes the record under the invitation's party, spawns the child with the bundle in its environment as `CADRE_INVITATION`, and answers `201 { node }` with the record `joining`. `cadre-cli start` redeems right after the node is up and reports the outcome as `/status.node.invitation`; the host polls a `joining` node every 2 seconds, as it polls an unclaimed one.

- **Accepted.** The record becomes `joined`, with `memberPeerId` (the member that admitted the node) and `ownerKey` set to the invitation's issuer key, which the bundle carries. The member wrote the node's rows on the owner's behalf, and they reach the node's own control database over the connection the redemption opened.
- **Refused or unreachable.** The record becomes `error` with the reason and `retryable`, and the child is stopped but kept, workdir and all. A member's refusal keeps its code in the reason (`… (invite-spent)` for an expired, withdrawn or used-up invitation; `invite-invalid` for one made for another device): `retryable: false`, final. `retryable: true` means no member named in the bundle answered.
- **When it does not work.** The bundle names the issuer's own addresses and up to three other members, so redemption needs one of those reachable from this machine. A cadre's first always-on node is the usual case where none is: its only members are phones, which nothing can dial. The CLI and the UI then say to join with the QR code instead, where the phone dials the node.
- **Retry.** `POST /api/hosted-nodes/:id/retry` (**Retry** in the UI, `cadre-host node retry <id>`) takes an `error` record with `retryable: true` back to `joining` and respawns it with its invitation, without spending a respawn attempt; anything else answers `409 invalid_state`. The supervisor never respawns an `error` record on its own, so a node whose member was offline waits for this.
- **Respawn.** A `joining` node is respawned with its invitation, and the member's redemption is idempotent for a node that already got in. A `joined` invitation node is respawned without it: it is a member, its rows are in its own control database, and an invitation that expired meanwhile must not turn a healthy member's restart into a refusal. The child that redeemed the invitation keeps reporting it on `/status` while it runs; the host reads that report only on a `joining` record.

### Claimed by someone else

Anyone who scans the code claims the node: the secret is the only check, so show the code only to the person it is for. A node someone else claimed first reads `joined` with an owner fingerprint the admin does not recognise, and the intended owner's phone is refused `already-claimed`. **Reset** on the node's page (`cadre-host node reset <id>`) removes that node and starts a fresh one with a new code; the other cadre keeps a row for a node that no longer answers.

### Remove, reset and a lost host

- **Remove.** `cadre-host node remove <id>` (`DELETE /api/hosted-nodes/:id`) deletes the record first, then stops the child and deletes its working directory, identity key and node-local stores included. The cadre keeps the node's row until its owner removes it there.
- **Reset.** `cadre-host node reset <id>` (`POST /api/hosted-nodes/:id/reset`) removes the node and starts a fresh one waiting to be claimed, with a new id and a new code: for a node someone else claimed, or one that failed. Reset on an invitation node also starts a node waiting to be claimed, since the invitation may be spent; the UI offers Remove there instead, after which the admin joins again with a fresh invitation or the code.
- **A host lost for good.** A dead disk or a replaced machine takes the nodes' identity keys with it, and nothing on another machine can come back as those peers. The owner removes the old node from the cadre (`CadreNode.removePeer`; no reference app offers this yet, `remove-a-device-or-app-from-a-cadre`) and joins a node on the replacement machine.

### Where the credentials go

The claim secret is in four places: the record in `hosted-nodes.json`, which every respawn replays; the child's environment (`CADRE_CLAIM_SECRET`, set by the orchestrator, never passed as an argument and never written to the orchestrator's `state.json`); the claim route's payload; and the `cadre-host join` output that prints that payload. An invitation is a credential too (it carries the invitation's private key): it is in the record, which a `joining` respawn replays, and in the child's environment (`CADRE_INVITATION`), and nowhere the host sends it. The record on the wire (`HostedNodeView`: `id`, `join: { kind: 'claim' | 'invitation' }`, `partyId`, `profile`, `status`, `dockerId?`, `statusEndpoint?`, `peerId?`, `ownerKey?`, `memberPeerId?`, `connected?`, `respawn?`, `createdAt`, `updatedAt`, `error?`, `retryable?`) carries neither, so `GET /api/hosted-nodes`, the node list and the event stream can be shown freely. The node checks a presented secret against the one it was started with, and the owner's device signs nothing on the host.

### Reachability from outside

The claim details carry the NAT layer's verdict for the node (`reachability`: its `NodeReachability` entry, or `null` before the NAT layer has one; see [Reachability verdict](#reachability-verdict)), and the CLI and the Join page warn when it reads `unreachable`.

- **At home the code still works.** Every hosted node listens on its WebSocket port on all interfaces, and the code carries the LAN addresses, so a phone on the host's network claims an unreachable node.
- **Away from home** a phone reaches the node only through its public addresses, which the NAT layer maps through the router over UPnP or the user forwards by hand ([NAT and DDNS](#nat-and-ddns)). Whether those addresses answer is up to the router: the verdict is a heuristic, not a dial-back.
- **Behind CGNAT** neither a mapping nor a forward helps; the node needs a relay reservation, which cadre-host does not give its nodes yet (`feat-cadre-host-children-reserve-on-a-relay`).

### From the CLI

The CLI is a client of the `/api/hosted-nodes` routes ([API surface](#api-surface)), like `nat`.

- `cadre-host join [--no-qr] [--no-wait]` POSTs, polls the claim route (503 until the child answers, up to 60 s), prints the QR code and the reachability warning on stderr and the payload text alone on stdout, then unless `--no-wait` polls the node every 2 s and prints `✓ Claimed by owner <first 8 characters of the owner key> into cadre <partyId>`. Ctrl-C leaves the node waiting.
- `cadre-host join --invitation <encoded> [--no-wait]` POSTs the invitation and prints `Joining cadre <partyId> through the invitation…`, then unless `--no-wait` polls the node every 2 s and prints `✓ Joined cadre <partyId> at member <peerId>`, or `✗ Could not join: <reason>` (exit 1) followed, when the failure is retryable, by the first-node hint and the retry command.
- `cadre-host node list` prints id, status, cadre, owner fingerprint and connected; `cadre-host node remove <id>`, `cadre-host node reset <id> [--no-qr] [--no-wait]` and `cadre-host node retry <id> [--no-wait]` call the remove, reset and retry routes.

### In the local UI

The SPA reads the records into a hosted-nodes slice (`GET /api/hosted-nodes`) and re-reads it, with the node list and the NAT snapshot, on every `hosted-nodes-changed` event; a `node-state-changed` event re-reads it too, since a respawn drops `connected` until the host reads the new child.

- **Join page** (`#/join`). The **Join a cadre** button POSTs and the page shows the new node: the QR code and the payload text with a copy button, the instruction to scan it with the Sereus app on the phone that owns the cadre, the node's reachability entry with its forwarding form, a warning when the verdict is `unreachable`, and **Cancel**, which removes the node. A live line follows the record through the states of [Join by QR code](#join-by-qr-code); after the claim the code is replaced by a link to the node's page. The page lists every node waiting to be claimed, so a reload or a closed tab loses none.
- **Paste an invitation.** Below the button, **Or paste a cadre invitation** takes the text the owner's app copied; **Join** POSTs it and clears the field once the node has started. The node's card follows it: joining cadre `<partyId>`, then joined at member `<peerId>`, or the reason it could not join. When no member could be reached the card adds the first-node hint (use the code instead) and **Retry**. Joining nodes are listed with the waiting ones.
- **Reading the code.** Each waiting node's code is fetched from the claim route on demand, retried every second while it answers 503 for up to 60 s as the CLI does (then the server's reason is shown with **Try again**), and fetched again when the node's public addresses in the NAT snapshot change, so a mapping that completes after the node starts reaches the QR code. The payload carries the claim secret, so it is held only in the component that shows it, never in the shared state or browser storage, and dropped once the node leaves `unclaimed`.
- **Nodes list.** One row per hosted-node record joined by id with the orchestrator handles: the record's status, its cadre (the claimed party, not the handle's placeholder), the owner fingerprint, connected, and a badge when the node has no process or it is stopped. A record with no handle and a handle with no record both get a row.
- **Node page.** A **Cadre** card with the status line, cadre, owner fingerprint and connected. A waiting node shows its code and **Cancel**, and a joining node **Cancel**; a joined node offers **Reset** and **Remove**, each behind a confirmation (an invitation node **Remove** only); a failed node shows its error and offers **Retry** (a reset) and **Remove**. A failed invitation node offers **Retry** (the retry route, no confirmation, since it deletes nothing) with the first-node hint only when no member could be reached, and **Remove**. A reset moves the page to the fresh node, which has a new id. A handle no record names offers **Remove** alone. No page offers Stop: the supervisor would bring a stopped node straight back.
- **Home and Connectivity.** The Home tile counts joined and waiting nodes (waiting includes joining; failed ones are counted when there are any) and links to the Join page; the Connectivity page labels each node "hosted node for cadre `<partyId>`", "waiting to be claimed" or "joining cadre `<partyId>`".

## Hosted nodes

Every node the host runs is a hosted node: a `cadre-cli` child in the `storage` profile, started by one join. It keeps a storage replica of every strand its party publishes, with no quota yet, so its disk use grows with that party's shared data (see [architecture.md → Strand Filtering](architecture.md#strand-filtering)).

### Records and statuses

Records live in `<dataDir>/hosted-nodes.json` (`HostedNodeStore`). A record's id, `hn_<base64url of 12 random bytes>`, is also its orchestrator container id and the name of its working directory.

| Status | Meaning |
|---|---|
| `spawning` | The record is written and the child not yet spawned. A record stuck here past 5 minutes is reaped to `error` ([The stuck-`spawning` reap](#the-stuck-spawning-reap)). |
| `unclaimed` | The child is up with a claim secret, waiting. It waits indefinitely: nobody can claim it without the secret. |
| `joining` | The child is up with an invitation, its redemption not yet settled ([Join by invitation](#join-by-invitation)). |
| `joined` | In its cadre: claimed (the record carries the claimant's party and owner key), or admitted by a member (the invitation's party, issuer key and the admitting member). |
| `error` | The supervisor gave up on it, the stuck-`spawning` reap found it, or its invitation was refused or reached no member (`retryable` says which). The working directory (the identity key) is kept until the node is removed or reset. |

Removal deletes the record; there is no terminal "removed" status.

### Identity and node-local state

**Each node has its own identity, in its own workdir.** Every node the orchestrator spawns is written its own `identity.key` in `<rootDir>/<containerId>/` (generated on first spawn, reused on every later one) and launched with `--identity-file` pointing at it; its `cadre.json` is written into that same workdir, so cadre-cli's node-state directory (`ResolvedConfig.nodeStateDir`, which defaults to the directory holding the config file) coincides with its identity. That directory holds the claim record (`claim.json`), the node-local trusted-owner anchor (`trusted-owners.<partyId>.json`, see [architecture.md → Seed Delivery Protocol](architecture.md#seed-delivery-protocol)) and the node-local bootstrap-peer store (`bootstrap-peers.<partyId>.json`). The per-node identity is required for two reasons: the owner's cadre claimed a specific peer id, so a per-process keypair would make the node a stranger to it after any restart; and without a stable node-state directory a node would lose its claim and the dial addresses it holds on every restart. Removing a node deletes the workdir (`removeContainer`), and everything the node knew goes with it.

**A child's configuration comes only from its own config file and the variables the orchestrator sets for it.** `cadre-cli` treats `CADRE_*` environment variables as config overrides that *beat* the config file, and children would otherwise inherit the manager's whole environment, so one `CADRE_PARTY_ID` (or `CADRE_STORAGE_PATH`, …) set on the `cadre-host` process would silently reconfigure every node it spawns. `HostProcessOrchestrator` therefore strips **all** `CADRE_`-prefixed keys from the inherited environment before adding the per-child ones (startup and seed tokens, health and metrics ports, listen addresses, node-state dir, announced public addresses, the claim secret or the invitation). Everything else (`PATH`, `NODE_OPTIONS`, proxy and TLS settings) passes through untouched. A new `CADRE_*` variable added to `cadre-cli` is covered automatically; there is no list to keep in sync.

### Ports

Every node holds four ports from the orchestrator's range (default 10000–20000): health, metrics, libp2p TCP and WebSocket, all bound on every interface. Only the TCP and WebSocket ports are mapped through the router ([Port mapping](#port-mapping)); the WebSocket port is the one a phone dials. A respawn keeps them ([Respawn](#respawn-keeping-a-hosted-node-up)).

### Push

Every hosted node is a storage node and gets the `push` block in its `cadre.json` when push credentials are configured ([Push credentials](#push-credentials-fcmapns)).

### Strand formation on a hosted node

Every hosted node answers strand formation for its party ([architecture.md → Who answers formation](architecture.md#who-answers-formation)). It checks a joiner's token against the party's replicated invitation rows, so an invitation can be redeemed there while the owner's phone is offline, and it needs no owner key to do so: the rows it writes are authorized by the joiner's own consent.

- **Reachability.** A joiner dials only the addresses the invitation carries, and an invitation carries the addresses of the machine that minted it.
- **Closed strands.** An invitation bound to a closed strand also needs that strand running on the answering node, which a `storage`-profile node has.

### Respawn (keeping a hosted node up)

A hosted node is a child process on someone's home PC: it can crash, get OOM-killed, or die in a reboot. The **`HostedNodeSupervisor`** owns the invariant *an `unclaimed`, `joining` or `joined` node is expected to be running.* It supervises every record in one of those statuses **and** that already has an orchestrator handle (`dockerId`); a record still mid-join is left alone, since the join itself owns the child until it writes that handle. The supervisor never touches a `spawning` record, and never respawns an `error` one. An `unclaimed` node is never reaped: it waits indefinitely, and nobody can claim it without the secret.

Three triggers run the same reconcile pass, on the service's respawn queue (`HostedNodeService.serializeRespawns`), which Retry shares, so no two respawns of one id ever overlap:

- **host startup** — one pass right after the orchestrator initializes, catching every node that died while the host was down;
- **child exit** — the orchestrator's exit event, so a crash is noticed in milliseconds;
- **periodic sweep** — a 1-minute backstop for deaths no exit event covered.

A crash respawn replays the record's party and claim secret (or, while `joining`, its invitation) through `HostedNodeService.respawn`, gets a fresh `dockerId`, and leaves the record's status untouched: a `joined` node is still joined, an `unclaimed` node still waits, a `joining` one redeems again. Attempts back off exponentially, 10 s before the first retry and doubling each time, so the wait before the fifth and last attempt is 80 s (the code also carries a 5-minute ceiling, which a 5-attempt budget never reaches), and give up after 5 consecutive attempts. **Every attempt counts, whether its spawn failed or succeeded:** a node that spawns and then dies at once (a crash on boot, a port clash) never makes the spawn call fail, so the supervisor also gives up when a pass finds the node down with 5 attempts already recorded. On give-up the record moves to `error` and the child is stopped but not removed, so the workdir and the identity key inside it survive for a later `remove` or `reset`. A node that stays up for 10 minutes after a respawn has its attempt budget refilled, so the next crash starts from a clean slate. A handle the orchestrator holds that no record names is logged at startup and left running; `cadre-host node remove <id>` reclaims it.

**An address restart is not a crash.** A running node restarted because its public addresses changed ([Public addresses reach the node](#public-addresses-reach-the-node)) goes through `HostedNodeSupervisor.restart`, on the same serialized queue. It leaves the attempt count and the record's `updatedAt` alone, so it does not spend the give-up budget. A restart whose respawn fails leaves the node down, and the next pass takes it over as an ordinary crash, with counting.

**"Running" means the child is alive, not that it has finished starting.** The orchestrator answers from the `ChildProcess` it spawned (no exit seen, pid still alive), which is exact from the moment of spawn. Only a handle re-attached from `state.json` after a host restart falls back to the pid plus the `.startup-token` file, which tells the child apart from an unrelated process that inherited its pid; `cadre-cli start` writes that file as its very first step, before it binds any port. A node can take many seconds to start, and a node read as dead during that time would be re-spawned over itself: the second child dies on the ports the first still holds, and the record is left naming the dead child. As a second line of defence, a spawn refuses to re-spawn a container whose previous child is still alive (or, for a re-attached handle with a live but unverified pid, whose ports are still bound), before releasing anything; the attempt fails and counts toward the give-up budget, and the record keeps its old handle.

**A respawned node keeps its addresses.** Its identity key survives in the working directory, so its peer id is unchanged, and the orchestrator hands the re-spawn the very ports the previous handle held rather than the lowest free ones. The phone that claimed the node knows it by the addresses in the code it scanned, so a moved port would strand a cadre whose only other device is that phone, and a code shown before the crash would name a node that no longer answers. The ports come from the previous handle as recorded in the orchestrator's `state.json`, so a respawn with no surviving handle (that file lost) gets fresh ports, and such a cadre then cannot find its node again.

**A respawn attempt that fails leaves the host exactly as it found it.** Spawning starts by dropping the orchestrator's leftover handle for that node and freeing its ports (which stops repeated respawns from leaking ports; the launch then takes those same ports straight back). If the launch then throws, that drop is undone: the previous handle goes back, still owning its ports, so the record's `dockerId` still resolves and a later `remove` still stops the child and deletes its working directory. If instead the child started but writing the record failed, the record is updated to name the child that actually exists. Either way nothing is left on disk that no id can reach. A *first* join that fails to launch has no prior handle to restore, so it unwinds the other way: the working directory that spawn brought into existence is deleted again. The test is whether the directory was already there when the spawn started: a re-spawn finds one and never touches it, because that directory (identity key, node-local stores) is what makes the node come back as the same peer. The last gap, a host that dies mid-spawn before any handle exists to unwind, is closed by the stuck-`spawning` reap and by `remove`, both of which fall back to reclaiming that directory by container name when the record names no handle.

### The stuck-`spawning` reap

A `spawning` record can be left with no in-flight join to advance it: the host crashed or was killed between writing the row and finishing the spawn. `cadre-host start` sweeps once at startup and every 5 minutes (`HostedNodeService.reapStuckSpawning`); a record `spawning` for more than 5 minutes becomes `error`, and whatever the orchestrator can still find for it is stopped and reclaimed, or, with no handle, its working directory is reclaimed by container name.

### An ending that lands mid-operation wins

This is a rule of the whole hosted-node surface. Spawning a child takes seconds, and a `remove` can land inside that window. `hosted-nodes.json` is written a whole row at a time, so any operation that holds a copy of the record across such a wait and then writes that copy back would silently undo the ending, resurrecting a node the admin just removed. Every long operation therefore **re-reads the record after the wait, decides against what is actually stored, and merges forward only the fields it itself produced**:

- **respawn** — if the record is no longer `unclaimed`, `joining` or `joined`, the spawn is abandoned: the terminal record stands exactly as the ending wrote it, and the brand-new child is stopped **and reclaimed**, because the ending's own cleanup already ran against the previous handle, which the in-flight spawn had dropped, so the new child is the only thing still holding that node's ports and workdir. The one exception is a record that went `error`: both spawns share one workdir, so reclaiming there would delete the identity key the give-up path deliberately keeps; the new child is stopped only, and the record is pointed at it, so a later `remove` reclaims its ports. (A give-up cannot land there, being on the respawn queue; the host's write of a failed invitation can, when a poll of the old child answers while the new one starts.) An abandoned respawn is not a failed attempt: nothing throws, so no attempt is recorded.
- **join** (step 1 of [Join by QR code](#join-by-qr-code)) — if the record is no longer `spawning`, the request fails with 409 (or 404) and the just-spawned child is **reclaimed**. This is the one case where the ending cleaned up *nothing*: the record had no `dockerId` yet when the `DELETE` ran, so `remove` had nothing to stop. A failing spawn is likewise only allowed to mark the record `error` while it is still `spawning`: a host fault must never overwrite the admin's own ending, and a deleted row must never be recreated.
- **the stuck-`spawning` reap** — it collects its candidates in one pass, then re-reads each record immediately before writing it `error`, so a join in this same process that advances the record past `spawning` in the meantime is not clobbered by the sweep's stale snapshot.

## Security posture

`cadre-host` is a household system, not a zero-trust one. Two consequences:

1. **Anyone with shell access to the host machine fully controls cadre-host.** This is the same threat model as any desktop application — Spotify, the Steam client, your password manager's desktop app. We do not defend against the household admin's own user account, and we do not pretend to. Disk encryption, OS user accounts, and physical security are the user's responsibility.

2. **Admission to a cadre is checked by the cadre's nodes, never by the host.** Each device has a libp2p peer identity inherited from cadre-core. A phone claims a hosted node by proving it holds the node's claim secret, which the node checks; a hosted node joins by invitation by presenting an owner-signed invitation, which a member of the cadre checks. No passwords. No API keys. No central account. The host authenticates no one itself; its management surface is same-machine admin access.

## NAT and DDNS

Cadre-host runs on machines that are typically behind NAT. For the nodes it runs to be dialable from the open internet it composes three layers, each fail-safe and independent:

1. **Port mapping per hosted node.** `NatService` keeps one mapping table keyed by node id (the hosted node's id) with a route per port: the node's libp2p TCP port and its WebSocket port, the one a phone dials. Health and metrics ports are never mapped. See [Port mapping](#port-mapping) for the rules.
2. **Circuit-relay reservation (not wired).** When the host is unreachable directly (CGNAT or stubborn router), a relay reservation would give its nodes a `/p2p-circuit` address phones can still dial. The pieces exist below cadre-host: cadre-core runs relay servers (`network.enableRelay`) and can reserve on a relay (`network.relayAddrs`), and cadre-cli exposes the reservation as `CADRE_RELAY_ADDRS`. What is missing is in cadre-host itself: host settings have no field for a relay address, and the spawn removes every `CADRE_*` variable from the environment its nodes inherit, then never sets `CADRE_RELAY_ADDRS`. So no node cadre-host runs is reachable through a relay (see [architecture.md → Which nodes can be reached through a relay](architecture.md#which-nodes-can-be-reached-through-a-relay)), and a host behind CGNAT cannot make its nodes reachable from outside its network (`feat-cadre-host-children-reserve-on-a-relay`). Nodes listen and announce on IPv4 only, so IPv6 is no way around it either.
3. **Dynamic DNS.** When a stable hostname is desired, cadre-host pushes the current external IP to a DDNS provider. It ships **DuckDNS** only; another provider (Cloudflare, No-IP, Dynu, …) is one file in `nat/ddns/` plus a registry entry.

### Port mapping

- **UPnP by default.** The service asks the router (`@achingbrain/nat-port-mapper`) for the same external port as the internal one; the router may grant another, and the port it returns is the one recorded and advertised. NAT-PMP is not implemented (`backlog/feat-cadre-host-nat-pmp-mapping`).
- **Manual wins.** A user who forwarded ports by hand enters them ([Manual port forwarding](#manual-port-forwarding); persisted as `forwards` in `nat.json`); a port with a manual forward is not requested over UPnP, and a port that became manual releases its UPnP mapping.
- **Each mapping fails alone.** A router that refuses one port, or caps the number of mappings, records an error on that port only; every other route is untouched.
- **Leases and renewal.** Leases are one hour, renewed by cadre-host itself every 30 minutes in one pass over every mapping, each renewal isolated; the library's auto-refresh is off so lease expiry and per-port failures stay visible. A renewal that fails keeps the route until the lease runs out, with the error recorded.
- **Which nodes.** The table follows the orchestrator's node list on every state change and on a 1-minute timer: a running node is mapped; a node stopped for longer than 3 minutes (longer than the hosted-node supervisor's whole respawn backoff, so a crash-and-respawn keeps its mapping) is unmapped; a removed node is unmapped at once and its manual forward deleted.
- **Host shutdown unmaps nothing.** Hosted children keep running across a host restart, so their mappings must outlive the process; they expire within the lease if the host stays down, and the next start re-maps the re-attached nodes (re-mapping the same internal port is idempotent on the router).
- **Turning UPnP off** releases every UPnP route and keeps the manual ones.
- **Strand nodes are not mapped.** The strand nodes inside each child bind OS-assigned ports and are reached through relays by design (`cadre-core/src/strand-network-config.ts`).

### UPnP gateway

Discovery listens 10 s for the first IPv4 gateway to answer the SSDP search; none within that time means UPnP is unavailable (`gateway.found: false` with the reason; manual forwards still work). It runs at start, on a UPnP toggle, on `nat test`, and, while UPnP is on and no router has answered, on the 5-minute probe timer, so a host that boots before its network finds the router without a restart and maps its running nodes at once. The library searches for `InternetGatewayDevice:2` only; a router that implements only version 1 of the UPnP gateway profile reads as not found. Mappings point at the local IPv4 address whose subnet contains the router — not every local address, which would leave stray mappings for VPN and container interfaces — and that address is reported as `gateway.lanAddress`, since it is the one a user forwards to. Two limits of the library: it deletes only mappings this process made, so after a host restart the previous process's mappings expire with their lease rather than being deleted; and its delete names the internal port as the external one, so a mapping the router granted on another external port also expires rather than being deleted.

### External IP detection

Cadre-host queries its external IP from two independent sources and compares them:

- **Router-side** — the WAN IP that the UPnP gateway reports for itself.
- **Public side** — an HTTPS GET to one of `api.ipify.org`, `ifconfig.me`, or `icanhazip.com`, first success wins.

When both succeed and disagree, cadre-host flags `cgnatDetected: true` — the textbook signature of CGNAT, where the router thinks it has a public address that's really private to the carrier. The verdict is informational, not enforced; the heuristic can also misfire on dual-stack networks, sliced VPNs, or flapping IPs. The IP is re-detected every 5 minutes; a detection that finds nothing, or that lost the public probe's answer and has only the router's, keeps the previous result, so one failed probe neither drops every node's public address nor flips the CGNAT flag. Only a public IPv4 is used in addresses.

### Reachability verdict

Each node in the status snapshot (`nodes: NodeReachability[]`, with a `PortRoute` for `tcp` and for `ws`) gets a verdict:

| Conditions | Verdict |
|---|---|
| either port has no route, or the host part is unknown (no DDNS hostname and no public IPv4), or the node's routes are UPnP routes under CGNAT | `unreachable` |
| otherwise, either port forwarded by hand | `manual` |
| otherwise | `mapped` |

An `unreachable` node carries a plain-language `reason` naming the failing port, its internal port, the LAN address and what to do: forward it, or turn UPnP on, or, under CGNAT, whatever else failed the port, that neither UPnP nor a forward will help and a relay is needed (relay support is `backlog/feat-cadre-host-children-reserve-on-a-relay`). The host-level `directReachability` rolls the running nodes up:

| Conditions | Verdict |
|---|---|
| CGNAT detected and no node is reachable through a manual route | `cgnat` |
| no running nodes | `unknown` |
| every running node is `mapped` or `manual` | `reachable` |
| otherwise | `unreachable` |

This is a heuristic, not a real dial-back. A future ticket will enable libp2p's AutoNAT service in `@optimystic/db-p2p`'s `libp2p-node-base.ts` and use its verdict here.

### Manual port forwarding

When the router does not map a node's ports (UPnP is off, no UPnP router answered, or the router refused), the user forwards them on the router by hand and tells cadre-host which external ports they chose. `cadre-host nat status` and the Connectivity page show, for each `unreachable` node, exactly what to forward.

- **Which ports.** Each node needs its libp2p TCP port and its WebSocket port, the one a phone dials (a node from an older build has no WebSocket port). Port numbers differ per node, so the instruction lists only the node's ports that have no route.
- **Forwarded to.** `gateway.lanAddress`, this machine's address on the router's subnet, on the same internal port. With no router found the instruction says "this machine's LAN address", because cadre-host cannot tell which of its local addresses the router sees. The external port is the user's choice; the simplest is the same number as the internal port.
- **Telling cadre-host.** `cadre-host nat forward <nodeId> --tcp <port> --ws <port>` (`--clear-tcp`, `--clear-ws` and `--clear` remove a forward), the "I forwarded these ports" form on the node's entry on the Connectivity page or on its node page, or `PUT /nat/nodes/:nodeId/forward { tcp?, ws? }` with `null` clearing a port. Both clients refuse a port outside 1–65535 before sending; the route refuses it too (`400 invalid_config`), and a node id the host does not run is `404 unknown_node`.
- **The node restarts.** A forward that changes the node's public addresses restarts the node so it announces them, at most once per node per 10 minutes ([Public addresses reach the node](#public-addresses-reach-the-node)). A forward that matches the port the router already granted changes no address and restarts nothing.
- **A forward outlives a respawn.** A node respawned after a crash, a host restart or an address restart keeps its ports ([A respawned node keeps its addresses](#respawn-keeping-a-hosted-node-up)), so the router rule still points at it. Removing a node deletes its forward, since a replacement gets other ports.
- **Not verified.** The verdict trusts the ports it is told: a node with every port forwarded by hand reads `manual` whether or not the router rule exists.
- **Behind CGNAT** a router forward does not help, and both clients say so; the form and the command stay available because the CGNAT check can misfire ([External IP detection](#external-ip-detection)).

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

cadre-host then uses the hostname in every node's public addresses and shows it in status, but never makes an update request.

### Public addresses per node

`NatService.publicAddressesFor(nodeId, ports)` builds, from cached state, the multiaddrs through which one node is reachable from outside; the same list is `publicAddrs` on the node's status entry:

- The host part is `/dns4/<hostname>` when a DDNS hostname is configured (externally managed included), else `/ip4/<externalIp>` when the detected IP is a public IPv4, else there is none and the list is empty.
- A DDNS hostname must be a DNS name (dot-separated letters, digits and inner hyphens). Settings refuse any other value, and one already in a hand-edited `nat.json` is ignored here, because a single malformed address would stop every hosted node from starting ([Public addresses reach the node](#public-addresses-reach-the-node)).
- A hostname given for a DDNS provider is stored as that provider's full name, so DuckDNS's bare `foo` is stored as `foo.duckdns.org`: the node announces the stored name, which has to resolve on its own.
- One address per port that has a route: `<host>/tcp/<externalPort>` and `<host>/tcp/<externalPort>/ws`, with the external port the router granted or the user entered. No `/p2p/` suffix: the node appends its own.
- Under CGNAT, UPnP routes produce nothing (the router's mapping is on a carrier-private address); manual routes still do, since the user asserted the forward.
- The node's own LAN addresses are not here; libp2p reports those itself.
- A port with no route yet is predicted to land on the identity mapping (external = internal) when UPnP is on and a gateway was found, so a caller at spawn time gets the addresses a brand-new node will most likely have; a port whose mapping attempt failed is not predicted.

[Public addresses reach the node](#public-addresses-reach-the-node) describes how a node gets them.

### Public addresses reach the node

A node learns its public addresses once, at start, and is restarted when they change.

- **At spawn.** The orchestrator asks `publicAddressesFor` for every node it starts and passes the list to the child as `CADRE_APPEND_ANNOUNCE_ADDRS`. libp2p adds those addresses to the ones it reports for its listen addresses, so the node's own `CadrePeer` row and the invitations it mints (cadre-core `collectSelfAddrs`) carry both. The append form is deliberate: `CADRE_ANNOUNCE_ADDRS` would replace the reported set and drop the LAN addresses a phone at home dials. An empty list sets nothing, and a failure computing it starts the node without public addresses rather than not at all.
- **Recorded.** The list is kept on the node's handle as `announcedAddrs`, persisted in the orchestrator's `state.json` and shown in `/api/nodes`, so a node re-attached after a host restart is compared against what it was actually started with.
- **Compared.** After every NAT pass and every settings write, `NatService` compares each running node's `announcedAddrs` with `publicAddressesFor` for it, as sets. They differ when a mapping lands on a port other than the one predicted at spawn, when a mapping fails or comes back, when a forward is set or cleared, when UPnP is toggled, when the DDNS hostname is set or cleared, when the CGNAT flag flips, or when the external IP changes while no DDNS hostname is set.
- **Restarted.** A difference restarts that node, which comes back with the same peer id and ports ([A respawned node keeps its addresses](#respawn-keeping-a-hosted-node-up)) and the current addresses. The restart goes through `HostedNodeSupervisor.restart`, which stops and respawns the node on the supervisor's serialized queue without spending its respawn budget. A node that is not running is left to the crash path.
- **Rate-limited.** At most one address restart per node per 10 minutes (`NAT_ADDRESS_RESTART_MIN_INTERVAL_MS`). A difference found inside that window is acted on by the first pass after it (the 1-minute reconcile timer at the latest), so a flapping router costs each node at most one restart per window.
- **Use DDNS.** With a DDNS hostname the addresses name the hostname rather than the IP, so a change of the home's external IP changes no announced address and restarts nothing. Without one, every IP change restarts every node that has a public address.

**Why a restart and not a live update.** libp2p can add address mappings at runtime, but reaching a running child would need a management channel to every hosted node, which none has today, a new cadre-core API and a new cadre-cli route. A restart reuses the respawn machinery and costs a few seconds of downtime on an event that is rare on a residential line.

### Credential storage

DDNS tokens are stored in the OS keychain via `keytar` (service: `sereus-cadre-host`, account: `ddns:<providerId>:<field>`). When `keytar` is unavailable (missing native build tooling, no DBus secret service on a headless Linux box, etc.) cadre-host falls back to a plain JSON file at `<rootDir>/nat-secrets.json` with mode `0600`. The fallback is logged on every write:

```
[cadre-host] DDNS credentials will be stored UNENCRYPTED at <rootDir>/nat-secrets.json (keytar not installed). Install keytar's native dependencies for OS keychain protection.
```

On Windows POSIX permission bits don't apply, so the file is readable by any account on the same machine — install keytar's native dependency to avoid that.

### Process integration

`NatService` is constructed and owned by the manager process (`cadre-host start`). Its node source is the orchestrator (`listNodes()` plus `onStateChange`); it holds no node client. The wiring:

1. Constructs `new NatService({ rootDir, nodeSource: orchestrator })` right after `orchestrator.init()`, before anything is spawned, and awaits `service.start()` — which awaits only gateway discovery (bounded at 10 s) and external-IP detection, then maps the re-attached running nodes in the background — so the first spawns see a discovered gateway. A start failure is logged; the management API comes up regardless.
2. Mounts `createNatHandlers(service)` on Fastify under `/nat/*`, and wires `service.onChange` to publish `connectivity-changed`, so the UI follows a mapping that completes after a spawn.
3. Calls `await service.stop()` on shutdown, which clears timers and releases nothing on the router.

## Push credentials (FCM/APNs)

To wake a suspended mobile app — one whose OS has frozen its process so a control-network dial can't reach it — an always-on storage node delivers a `strand-wake` data message over the platform push channel (FCM for Android, APNs for iOS). cadre-core's push fan-out (`PushFanoutService` + `PushNotifier`) does the delivery; it is constructed **only when** the spawned node's `cadre.json` carries a `push` block (`CadreNodeConfig.push`). This section covers how cadre-host gets the FCM/APNs credentials into that block. Push is **opt-in**: with no credentials configured, no `push` block is written and the node wakes phones by control-network push-wake only.

### Out-of-agent infra steps (do these first)

Creating the cloud credentials is a one-time human/infra task — cadre-host stores and injects them but cannot mint them:

1. **FCM (Android / Firebase).** In the [Firebase console](https://console.firebase.google.com), create (or open) the project that backs your app, then **Project settings → Service accounts → Generate new private key**. The downloaded JSON contains `project_id`, `client_email`, and `private_key` — the three fields cadre-host needs.
2. **APNs (Apple).** In the [Apple Developer portal](https://developer.apple.com/account), **Certificates, Identifiers & Profiles → Keys → +**, enable **Apple Push Notifications service (APNs)**, and download the `.p8` auth key. Note the **Key ID**, your **Team ID**, and the app's **Bundle ID**. A development/TestFlight build talks to the **sandbox** APNs host; an App Store build talks to **production** — they are separate and a token minted for one is rejected by the other.

### Storing the credentials

Use the `cadre-host push` subcommands (they write directly to the data dir's secret store + `host.config.json`; no running server required):

```
cadre-host push fcm  --project-id <id> --client-email <email> --private-key-file ./fcm-key.pem
cadre-host push apns --key-id <kid> --team-id <team> --bundle-id <bundle> --private-key-file ./AuthKey.p8 [--production]
cadre-host push options [--cooldown-ms <ms>] [--debounce-ms <ms>]
cadre-host push status            # show configured platforms (no secret material)
cadre-host push clear <fcm|apns|all>
```

Secret hygiene mirrors the DDNS-token precedent:

- The **private keys** (and the FCM `project_id` / `client_email`, APNs `key_id` / `team_id`) live in the OS keychain via `keytar` (service `sereus-cadre-host`, accounts `push:fcm` / `push:apns`), or the same `0600` `<rootDir>/nat-secrets.json` fallback when keytar is unavailable. They are **never** written to `host.config.json`.
- The **non-secret** bits — APNs `bundleId`, the sandbox/production toggle, and the `cooldownMs` / `debounceMs` tuning — live in `host.config.json` under `push`.
- Credentials are **re-resolved from the secret store on every node (re-)spawn**, so a key rotation takes effect on a node's next spawn and nothing raw is ever persisted in the orchestrator's `state.json`. They are never logged — debug lines record only platform presence (`fcm=true apns=false`), not key material.

### Injection into the spawned node

At spawn time `HostProcessOrchestrator` calls its `pushResolver` (wired in `cadre-host start`), which reads the secret store + `host.config.json` and validates the result. The resolved `PushCredentials` are written into the child's `cadre.json` under `push` for every **storage**-profile node, which is every hosted node; a transaction-only node would get no block.

**These are the operator's app credentials.** An FCM service account or an APNs key belongs to one app's publisher and wakes only that app's installs, and every hosted node gets the same set. Configure them only when the hosted nodes serve cadres of that app's users. Without them a node falls back to control-network push-wake.

A *partial* set (a present platform missing required fields, e.g. an APNs key with no `bundleId`) is rejected: the resolver logs the error and spawns the node **without** push rather than failing the spawn, so the node stays reachable.

> **On-device validation is still a human prerequisite.** Once creds are provisioned, push-wake is end-to-end at the server, but confirming a real device actually wakes (correct bundle id, sandbox-vs-production match for the build under test, a registered `DeviceToken`) must be verified on a physical device — it is out-of-agent.

## Updates

cadre-host fetches a signed manifest from `https://releases.serfab.io/cadre-host/latest.json` once on `start` and every 24 h thereafter. The manifest is an Ed25519-signed envelope `{ manifest, sig }` where the inner manifest carries `version`, `publishedAt`, an `npm.{ package, tag }` hint, and an optional `minPreviousVersion` step gate. The release public key is embedded in the binary; `CADRE_HOST_UPDATE_DEV_KEY` overrides it for CI / local signing.

**Notify-by-default.** A successfully verified manifest with `version > current` writes an `available` record into `<dataDir>/update-state.json`; the local UI surfaces it as a banner with an explicit "Apply now" action. Auto-apply is opt-in (`updates.autoApply: true` in `host.config.json`, settable from the UI's settings page). Signature failures are recorded as `lastError` so the UI can warn; network failures stay silent.

**Apply flow.** Re-fetch + re-verify the manifest, record `applyInProgress`, run `npm install -g <pkg>@<version>` (5-minute timeout), then ask the platform's `ServiceHost.restart(...)` to pick up the new binary (`systemctl --user restart`, `launchctl kickstart`, or `nssm restart`). On install failure the previous version is reinstalled and the error is surfaced; the still-running old binary continues to serve. Restart failures are non-fatal — the binary swap already succeeded, so the user can restart manually.

`UpdateService` lives in `src/update/` and exposes `createUpdateHandlers(service)` for the local-UI HTTP routes (`GET /update`, `POST /update/apply`, `GET/PUT /update/settings`); `cadre-host start` constructs the service so the daily timer and `update-state.json` are populated regardless of whether the UI has bound its routes yet.

### Release signing & key management

**Two keys, opposite directions — don't conflate them.** cadre-host holds two unrelated Ed25519 keypairs:

| | Release-signing key | Per-node identity key |
| --- | --- | --- |
| Source | `PROD_KEY_BASE64` in `src/update/release-key.ts` | `<dataDir>/orchestrator/<containerId>/identity.key` from `src/orchestrator/node-identity.ts` |
| Direction | publisher → **every** install | this node → the network / its cadre |
| Lifecycle | one global keypair; minted **once, offline** by the release operator; public half pinned into every binary at build time | a fresh keypair generated on a node's **first spawn**, mode 0600, never leaves the box, deleted with the node's workdir |
| Answers | "did this update instruction genuinely come from Serfab?" | "who is this node?" (libp2p peer identity) |

An identity key is node-specific by design; the release key **cannot** be. It is a one-signer/many-verifiers relationship — the publisher signs `latest.json` once and every install must verify against the *same* public key, obtained from somewhere it already trusts (the binary it installed). There is nothing a freshly-minted local key could verify the publisher's signature with, so the public half must be embedded at build time. This section is about that release key.

**Why sign at all, when updates come from npm?** `npm install -g` already guarantees the *bytes* of a named `package@version` (registry TLS, integrity hashes, optional provenance). But the signed manifest decides **which** package and version a node auto-moves to — `manifest.channels.npm.package`, `manifest.version`, and the `minPreviousVersion` step gate all ride inside the signature. Without it, anyone who controls or MITMs the static `releases.serfab.io` host could forge a manifest that redirects `autoApply` nodes to a typosquatted package or force-downgrades them to a known-vulnerable version, and npm would faithfully install whatever it was told. npm authenticates the bytes; the manifest authenticates the *choice*.

Manifests are verified against an Ed25519 public key embedded in source (`PROD_KEY_BASE64` in `src/update/release-key.ts`). Public keys are not secret, so the *public* half is committed; the private half is the release-signing secret and is custodied **offline by the release operator — never committed**. The real public key is embedded (as of the 0.8.1 release); before an operator embeds one the source ships an all-zeros placeholder, and a build/publish guard refuses to ship such a build (see below).

The repo provides the full pipeline; the operator runs a couple of mechanical commands:

1. **Generate the keypair (offline, once).** On a trusted machine, from a checkout:

   ```sh
   node packages/cadre-host/scripts/release-keygen.mjs --write-source
   ```

   This writes the PKCS#8 PEM private key to `./cadre-host-release.key` (mode `0600`, refuses to overwrite) and — with `--write-source` — atomically rewrites `PROD_KEY_BASE64` with the new public key. Omit `--write-source` to print the public key and embed it by hand. **Move the private key to offline custody and never commit it.** Commit the `PROD_KEY_BASE64` change.

2. **Sign `latest.json` (offline, per release).** With the private key present and the package built (`yarn build:server`):

   ```sh
   node packages/cadre-host/scripts/sign-manifest.mjs \
     --key ./cadre-host-release.key \
     --version 0.7.0 --package @serfab/cadre-host --tag latest \
     --published-at 2026-05-15T18:00:00.000Z \
     --out latest.json
   ```

   The signer reuses the exact field-validation the verifier applies (`buildManifest`) and **self-verifies** the signature against the key derived from the private key before emitting, so it can never produce a manifest the client would later reject. Fields may instead come from `--manifest <file.json>`.

3. **Publish `latest.json`.** Upload the signed envelope to the static host so it is served at `https://releases.serfab.io/cadre-host/latest.json`. This is plain static-file hosting — no code in this repo.

4. **Publish the binary.** `scripts/publish-package.mjs cadre-host` builds then **aborts if the embedded key is still the placeholder** — it reads `PROD_KEY_BASE64` straight from source (the byte string the build compiles verbatim into the binary) and deliberately ignores `CADRE_HOST_UPDATE_DEV_KEY`, since that override never ships and so cannot make a placeholder build safe. This means a real release can never silently ship the dead key. Internal/test publishes that intentionally keep the placeholder set `CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1` to bypass.

**Rotation** is the same loop: re-run keygen (`--write-source`), commit the new public key, re-sign and re-publish `latest.json`, publish a new binary. Clients that already trust the old key will see `signature_invalid` until they upgrade to the binary carrying the new public key — so rotate by shipping the new public key in a release *before* signing manifests with the new private key.

**`CADRE_HOST_UPDATE_DEV_KEY`** overrides the embedded key for **development / CI / staging only** — it lets tests and smoke runs sign with an ephemeral keypair without touching source. It is never the production verification path and must not be set on deployed nodes. The signing tools live under `packages/cadre-host/scripts/` and are intentionally **not** part of the published package (the binary never carries signing code or the private key).

## Local UI server

The local-UI server is the long-lived HTTP listener `cadre-host start` binds. It serves the management API, which the CLI and the SPA both use, and the Svelte 5 SPA itself from `<package>/dist/ui/`: Home, Connectivity, Nodes with a page per node, Join, and Settings, hash-routed so the server needs no fallback rewrite, and live through the event stream below. The SPA's hosted-node pages are described under [In the local UI](#in-the-local-ui).

### Binding & origin policy

- Bound to **`127.0.0.1`** only — never `0.0.0.0`. The OS firewall does not see this socket from another machine.
- An **origin guard** rejects any request whose `Host` header isn't `127.0.0.1[:port]`, `localhost[:port]`, or IPv6 loopback `[::1][:port]`/`::1[:port]` (case-insensitive), and any request whose `Origin` header (when present) doesn't match one of those origins. This defeats DNS-rebind from a malicious page that resolves its own hostname to `127.0.0.1`.
- **Port collision**: if the configured `uiPort` is in use, the server tries `uiPort+1..uiPort+9`. On total failure it exits non-zero with a clear message naming every port attempted. Re-configure `uiPort` in `host.config.json` and reinstall the service.

### No login

cadre-host is a same-machine management surface. Any local process running as the cadre-host user can already read identity files, start or remove hosted nodes, install global npm packages, and (with root) restart the service. A web-form password adds no real defence — it would protect the *non-existent* threat model "attacker is on this machine but can't run code as the cadre-host user". Don't add auth here; harden the host OS instead.

### API surface

| Path | Method | Purpose | Errors |
|---|---|---|---|
| `/api/hosted-nodes` | GET | Every hosted node, credentials stripped → `{ nodes }` ([Join a cadre](#join-a-cadre)) | — |
| `/api/hosted-nodes` | POST | Start a node waiting to be claimed (empty body), or one that redeems `{ invitation }` → 201 `{ node }` | 400 invalid_request for an invitation that does not decode; 500 orchestrator_error / storage_error |
| `/api/hosted-nodes/:id` | GET | One hosted node → `{ node }` | 404 not_found |
| `/api/hosted-nodes/:id/claim` | GET | The QR payload → `{ payload, peerId, multiaddrs, reachability }` | 404 not_found; 409 invalid_state unless `unclaimed`; 503 node_unavailable until the child answers |
| `/api/hosted-nodes/:id` | DELETE | Remove the node: its record, child and working directory → 204 | 404 not_found |
| `/api/hosted-nodes/:id/reset` | POST | Remove the node and start a fresh one with a new code → 201 `{ node }` | 404 not_found |
| `/api/hosted-nodes/:id/retry` | POST | Start an invitation node again after no member could be reached → `{ node }` | 404 not_found; 409 invalid_state unless `error` with `retryable` |
| `/api/status` | GET | Dashboard snapshot: service name, version and uptime, a summary per orchestrator handle (`id`, `partyId`, `status`, `profile`), `connectivity` (the NAT snapshot), and the update state | — |
| `/api/nodes` | GET | Every orchestrator handle (one per running or stopped child). Read-only: a node's lifecycle belongs to `/api/hosted-nodes`, whose supervisor would undo at once a stop issued anywhere else | — |
| `/api/nodes/:id` | GET | One handle's detail + stats | 404 unknown |
| `/api/nodes/:id/logs?lines=N` | GET | Tail of `node.log` (default 200, max 2000) | 404 unknown |
| `/api/settings` | GET/PUT | `host.config.json` passthrough (PUT is whitelisted, below) | 400 invalid_setting |
| `/api/events` | GET | Server-Sent Events stream | — |
| `/nat/*` | various | NAT/DDNS (matches CLI) — `GET /nat/status`, `POST /nat/test`, `GET /nat/providers`, `PUT /nat/ddns`, `PUT /nat/settings` | mapped from `NatError.code` |
| `/nat/nodes/:nodeId/forward` | PUT | Record the external ports forwarded by hand for one node — `{ tcp?, ws? }`, `null` clears a port, both cleared removes the entry → the NAT snapshot ([Manual port forwarding](#manual-port-forwarding)) | 404 unknown_node for a node the host does not run; 400 invalid_config for a body that is not an object or a port outside 1–65535 |
| `/update/*` | various | Update flow — `GET /update`, `POST /update/apply`, `GET/PUT /update/settings` | mapped from `UpdateErrorException.code` |
| `/` (any GET) | — | SPA bundle (or placeholder HTML when `dist/ui/` is absent) | — |

Error payloads use the same envelope as cadre-provider: `{ ok: false, error: { code, message } }`. Status mapping is encoded in `src/server/error-handler.ts`; for `/api/hosted-nodes` it maps the `HostedNodeError` codes: `invalid_request` 400, `not_found` 404, `invalid_state` 409, `node_unavailable` 503, `orchestrator_error` and `storage_error` 500.

**An empty JSON body counts as no body.** A request that declares `content-type: application/json` but sends nothing reaches its route with no body, instead of Fastify's default `400 FST_ERR_CTP_EMPTY_JSON_BODY` (`buildFastify` in `src/server/server.ts`). A body-less `POST /api/hosted-nodes` and a body-less `DELETE /api/hosted-nodes/:id` are the norm, and sending the JSON content type on every request is a common client habit, so a request refused here would be a node left running or never started. Routes read `request.body ?? {}`, so one that needs a field still answers its own `400 invalid_request` naming it. A non-empty body goes through Fastify's own parser, so malformed JSON and prototype-poisoning payloads are still `400 FST_ERR_CTP_INVALID_JSON_BODY`.

### Server-Sent Events

`GET /api/events` returns `text/event-stream` and pushes:

| Event | When |
|---|---|
| `node-state-changed` | A managed node transitions running ↔ stopped |
| `hosted-nodes-changed` | A hosted node was started by a join (`kind: 'added'`), claimed as the watcher noticed (`'claimed'`), admitted by a member on its invitation (`'joined'`), removed (`'removed'`), or respawned, changed liveness, had its invitation refused, was retried or was given up on (`'changed'`); carries `nodeId`. The service reports every change through one listener, so a change the routes, the watcher or the supervisor made reaches the SPA the same way |
| `connectivity-changed` | NAT settings or a manual forward changed, reachability re-tested, server boot, and any change to the NAT snapshot the NAT layer notices on its own (a hosted node starting, stopping or being removed, a mapping completing after a spawn, the external IP or CGNAT flag changing, a lease the router dropped). Carries `directReachability` only; the SPA re-reads `/nat/status`, which is how its per-node entries follow a node's restart for new addresses |
| `update-available` | A new release version is observed |

A `: heartbeat` comment is sent every 15 s so corporate proxies don't time out idle connections; the wire format also includes a `retry: 5000` hint. Listeners are cleaned up on client disconnect — `bus.listenerCount()` drops back to zero.

### Write-whitelist for `/api/settings`

The SPA's settings page reads the full `host.config.json` (so it can show read-only fields) but only accepts these PUT keys:

| Key | Accepted? | Notes |
|---|---|---|
| `upnpEnabled` | yes | Propagated to `NatService.putSettings` immediately |
| `updates.autoApply` | yes | Propagated to `UpdateService.putSettings` |
| `updates.manifestUrl` | yes | Propagated to `UpdateService.putSettings` (env var still wins) |
| `uiPort`, `dataDir`, `installId`, `installedAt`, `installerVersion`, `version` | **no** | Structural — edit at install time or directly in `host.config.json` and restart. |

Unknown keys → 400 `invalid_setting`.

The file is `version: 3` (`installer/config.ts`): `version`, `installId`, `installedAt`, `installerVersion`, `dataDir`, `uiPort`, `upnpEnabled`, `updates`, and `push` when push settings are stored. A file of any other version is refused on read, never migrated.

### Honest gaps

- **No component tests for the SPA** (`debt-cadre-host-ui-component-tests`). The pages' template branches are checked by reading them; the routes they call are covered by the server's route tests and the integration scenarios.
- **An unbuilt checkout serves a placeholder.** When `dist/ui/` is absent (a source checkout without `yarn build`), `/` answers a placeholder page pointing at the build instructions; the API still answers.

## Architecture sketch

```mermaid
graph TD
    subgraph MP["Manager process (management plane; joins no control network)"]
        UI["Local UI server + management API<br/>(Fastify on 127.0.0.1)"]
        HNS["HostedNodeService<br/>(join, claim details, remove, reset, retry, respawn, reap)"]
        W["Status watcher<br/>(polls each child's /status)"]
        Sup["HostedNodeSupervisor"]
        Orch["HostProcessOrchestrator"]
        NAT["NatService<br/>(UPnP, manual forwards, DDNS)"]
        Upd["UpdateService<br/>(signed manifest)"]
        Install["Installer + service host"]
    end
    UI --> HNS
    UI --> NAT
    UI --> Upd
    HNS --> W
    Sup -->|respawn, restart| HNS
    HNS -->|spawn, stop, remove| Orch
    NAT -. "public addresses at spawn" .-> Orch
    NAT -. "addresses changed" .-> Sup
    Orch -->|spawns| NN["hosted nodes<br/>(cadre-cli children, each a member of its own cadre)"]
    W -. "GET /status" .-> NN
    NAT -. "maps each node's TCP + WebSocket ports on the router" .-> NN
    Upd -. "npm install -g + ServiceHost.restart" .-> Install
    Phone["Owner's phone"] -->|"dials, claims, syncs"| NN
```

Only the hosted nodes (`NN`) join control networks. The dotted line from `NAT` to the nodes is a router mapping, not a channel: the NAT layer talks to the router and to the orchestrator's node list, never to a node.

## Status

- **Hosted nodes.** Join by QR code and by invitation, the `/status` watcher, the supervisor and its respawn rules, the stuck-`spawning` reap, the `/api/hosted-nodes` routes, the `hosted-nodes-changed` event and the `join` / `node` CLI. Proven end-to-end against a real `cadre-cli` child by `cadre-host-join-by-qr.integration.ts` (a phone-shaped claimant, a respawn on the same ports, removal) and `cadre-host-join-by-invitation.integration.ts` (admission, an unreachable member then Retry, an expired invitation).
- **Local UI.** The SPA (about 45 KB gzipped) drives the same routes; it has no component tests (see [Honest gaps](#honest-gaps)).
- **NAT.** Per-node UPnP mapping with manual forwards, external-IP detection with the CGNAT flag, per-node reachability verdicts, DuckDNS, and nodes that announce their public addresses and restart when they change. Not yet: a relay reservation for nodes behind CGNAT (`feat-cadre-host-children-reserve-on-a-relay`), NAT-PMP (`feat-cadre-host-nat-pmp-mapping`), and a real dial-back test of reachability.
- **Install and updates.** The installer wizard, `host.config.json` version 3 and service-host registration (`systemd --user`, LaunchAgent, NSSM; `install --no-service` skips it); the signed-manifest update service with npm apply, rollback and service restart.
- **CLI.** `install`, `uninstall`, `status`, `start`, `ui`; `join [--invitation]`; `node list|remove|reset|retry`; `nat status|test|settings|forward|ddns set|ddns external`; `push fcm|apns|options|clear|status`. The [package README](../packages/cadre-host/README.md#cli-reference) documents each command.
- **Not yet.** The phone side of the scan flow in the React Native reference app (`rn-app-joins-host-node-by-qr`); strand reactivity on hosted nodes (`feat-cadre-host-and-provider-nodes-carry-strand-reactivity`); a storage quota per node.

## See also

- [architecture.md](architecture.md) — overall cadre architecture, control network, and strand lifecycle.
- [@serfab/cadre-host README](../packages/cadre-host/README.md) — install, walkthrough and CLI reference.
- [@serfab/cadre-provider](../packages/cadre-provider/README.md) — the multi-tenant sibling.
- [@serfab/cadre-core](../packages/cadre-core/README.md) — the underlying cadre node library.
