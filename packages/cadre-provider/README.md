# @serfab/cadre-provider

Reference provider service for hosting Sereus cadre nodes on behalf of users.

## Overview

This package provides a complete provider API that enables:
- **Container Management**: Allocate, monitor, and terminate cadre node containers
- **Billing Integration**: Usage metering, quota enforcement, and payment processor hooks
- **Authentication**: API key and OAuth/JWT authentication
- **Docker Orchestration**: Container lifecycle management via Docker API

## Installation

```bash
npm install @serfab/cadre-provider
```

## Quick Start

### CLI Usage

```bash
# Start the provider service
cadre-provider start -c provider.yaml

# Validate configuration
cadre-provider check -c provider.yaml

# Enable debug logging
cadre-provider start -c provider.yaml --debug
```

### Programmatic Usage

```typescript
import { createProviderServer, loadConfig } from '@serfab/cadre-provider';

const config = loadConfig({ configFile: 'provider.yaml' });
const server = await createProviderServer({ config });
await server.start();
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/status` | Health check |
| POST | `/api/v1/containers` | Create a new container; `join` says how it gets into its cadre ([Joining a cadre: claim or invitation](#joining-a-cadre-claim-or-invitation)) |
| GET | `/api/v1/containers` | List customer's containers, each with its `partyId` and `joinState` |
| GET | `/api/v1/containers/:id` | Get container status (reads the node live and folds its join state into the record) |
| GET | `/api/v1/containers/:id/code` | The node code a phone claims the container with (claim containers only) |
| GET | `/api/v1/containers/:id/peer` | The container's peer id and addresses (seed path) |
| PUT | `/api/v1/containers/:id/seed` | Deliver a seed to the container (seed path) |
| DELETE | `/api/v1/containers/:id` | Terminate container |
| GET | `/api/v1/billing/plans` | List billing plans |
| GET | `/api/v1/billing/status` | Get customer billing status |

## Configuration

Configuration can be provided via YAML/JSON file or environment variables. Both are checked
strictly at start: an unknown or misspelled key, or a wrongly-typed value, stops the provider
(`start` and `check` alike) with an error naming every problem and where it came from, instead
of silently applying the default. A file holding `server: { prot: 3000 }` with
`PROVIDER_AUTH_MODE=apikey` in the environment fails with:

```
Config /etc/cadre-provider.yaml: unknown key server.prot (did you mean 'port'?)
Environment variable PROVIDER_AUTH_MODE: auth.mode must be one of 'none', 'api-key', 'oauth', got "apikey"
```

A block with no children (`server:` on its own) counts as absent. `storage.type: file` needs
`storage.path`. `docker.defaultResources.memoryLimit` must be a size the orchestrator can read
(`512M`, `2G`) and `cpuLimit` a quoted number (`"0.5"`); a create request's own `resources` are
held to the same rule. `docker.portRange.end` must not be below `start`; each container takes four
ports from the range (health, metrics, libp2p TCP, libp2p WebSocket), so the default 10000–20000
serves 2,500 containers. `docker.network` may not be `host`, `none` or `container:<id>`, modes in
which Docker ignores those port bindings. `docker.publicHost` must be a DNS name or IP address with no whitespace
([Phones dial containers at the public host](#phones-dial-containers-at-the-public-host)). Values under `push` and
`billing` are never echoed into an error, and `check` prints the loaded config with every secret
shown as `[redacted]`.

### Example Configuration

```yaml
server:
  host: 0.0.0.0
  port: 3000
  basePath: /api/v1

auth:
  mode: api-key  # none, api-key, or oauth (default: api-key)
  # api-key with no keys configured rejects every privileged call (401).
  # apiKeyHashes: [<sha256-hex>, ...]   # static admin keys, granted '*'
  #
  # mode: none disables auth entirely (every caller becomes a wildcard
  # 'dev-customer'). It is fully open, so it must be acknowledged explicitly:
  # mode: none
  # allowInsecureNoAuth: true

docker:
  socketPath: /var/run/docker.sock
  network: sereus_provider
  image: sereus-cadre-node:latest
  defaultResources:
    memoryLimit: 512M
    cpuLimit: "0.5"

billing:
  enabled: true
  stripeSecretKey: sk_test_...
  usageCollectionIntervalSec: 60

storage:
  type: file
  path: /data/provider
```

### Environment Variables

Each variable overrides one setting on its own; none depends on another being set. A boolean
variable accepts `true`, `false`, `1` or `0`, and a number variable only a number
(`PROVIDER_BILLING_ENABLED=yes` and `PROVIDER_PORT=3000abc` both fail start). An empty value
counts as unset. Unknown `PROVIDER_*` names are ignored, since other software may use the prefix.

| Variable | Setting | Description |
|----------|---------|-------------|
| `PROVIDER_HOST` | `server.host` | Server host |
| `PROVIDER_PORT` | `server.port` | Server port (0 to 65535; 0 picks a free port) |
| `PROVIDER_BASE_PATH` | `server.basePath` | Base path for API routes |
| `PROVIDER_AUTH_MODE` | `auth.mode` | Authentication mode (`none`, `api-key`, `oauth`) |
| `PROVIDER_ALLOW_INSECURE_NO_AUTH` | `auth.allowInsecureNoAuth` | Set to `true` to acknowledge running fully open with `PROVIDER_AUTH_MODE=none` |
| `PROVIDER_JWKS_URI` | `auth.jwksUri` | JWKS endpoint (oauth mode) |
| `PROVIDER_ISSUER` | `auth.issuer` | Expected token issuer (oauth mode) |
| `PROVIDER_AUDIENCE` | `auth.audience` | Expected token audience (oauth mode) |
| `PROVIDER_DOCKER_SOCKET` | `docker.socketPath` | Docker socket path |
| `PROVIDER_DOCKER_IMAGE` | `docker.image` | Container image |
| `PROVIDER_DOCKER_NETWORK` | `docker.network` | Docker network for tenant containers |
| `PROVIDER_DOCKER_PUBLIC_HOST` | `docker.publicHost` | DNS name or IP address at which the published container ports are reachable from outside; containers announce it, and `bootstrapNodes` becomes optional. Read when a container is created, so existing containers keep the host they were created under until recreated |
| `PROVIDER_BILLING_ENABLED` | `billing.enabled` | Enable billing (`true`/`false`) |
| `STRIPE_SECRET_KEY` | `billing.stripeSecretKey` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | `billing.stripeWebhookSecret` | Stripe webhook signing secret |
| `PROVIDER_STORAGE_TYPE` | `storage.type` | `memory` or `file` |
| `PROVIDER_STORAGE_PATH` | `storage.path` | Directory for file storage (required with `file`) |
| `PROVIDER_LOG_LEVEL` | `logging.level` | `debug`, `info`, `warn` or `error` |

## Authentication & permissions

The provider is **closed by default**. The default mode is `api-key`, and with
no keys configured every authenticated route returns `401` — a freshly started
provider is reachable but rejects all privileged calls.

### Insecure no-auth mode

`mode: none` disables authentication and grants every caller a wildcard
identity (`dev-customer` with `['*']`). Because that is fully open, it is **not
reachable implicitly**: the provider refuses to start in `none` mode unless the
insecure setting is explicitly acknowledged.

```yaml
auth:
  mode: none
  allowInsecureNoAuth: true   # required, or the provider refuses to start
```

…or via environment: `PROVIDER_AUTH_MODE=none PROVIDER_ALLOW_INSECURE_NO_AUTH=true`.
Without the acknowledgement, both `cadre-provider start` and `cadre-provider
check` fail with a clear error. Use this only for local/dev.

### Permission scopes

Each authenticated identity carries a `permissions` array. Privileged routes
require a matching scope; a request that authenticates but lacks the scope
returns `403 INSUFFICIENT_SCOPE`. Wildcards are supported: `*` grants
everything, and `<resource>:*` (e.g. `containers:*`) grants every scope under
that resource. Static `apiKeyHashes` admin keys and `none`-mode callers carry
`['*']`, so they pass every check; store/JWT identities can be scoped down.

| Route | Required scope |
|-------|----------------|
| `POST /containers` | `containers:create` |
| `GET /containers` | `containers:read` |
| `GET /containers/:id` | `containers:read` |
| `GET /containers/:id/peer` | `containers:read` |
| `DELETE /containers/:id` | `containers:delete` |
| `PUT /containers/:id/seed` | `containers:seed` |
| `GET /billing/status` | `billing:read` |
| `GET /billing/plans` | none (public listing) |
| `GET /status` | none (skipped by auth) |

Scope enforcement is orthogonal to ownership: per-container routes still verify
that the container belongs to the calling customer regardless of scope.

## Custom Authentication

```typescript
import { createProviderServer, loadConfig, type AuthHooks } from '@serfab/cadre-provider';

const authHooks: AuthHooks = {
  async validateJwt(token) {
    const user = await verifyMyJWT(token);
    return {
      customerId: user.id,
      permissions: user.scopes,
    };
  },
};

const server = await createProviderServer({
  config: loadConfig(),
  authHooks,
});
```

## Custom Billing

```typescript
import { createProviderServer, loadConfig, type BillingHooks } from '@serfab/cadre-provider';

const billingHooks: BillingHooks = {
  async processPayment(customerId, amountCents) {
    const result = await stripe.charges.create({ ... });
    return { success: true, transactionId: result.id };
  },
};

const server = await createProviderServer({
  config: loadConfig(),
  billingHooks,
});
```

## Deployment

### Docker

```bash
docker build -t cadre-provider .
docker run -p 3000:3000 -v /var/run/docker.sock:/var/run/docker.sock cadre-provider
```

### Per-tenant durable state

Each container gets a named Docker volume of its own, `cadre-<containerId>-data`, mounted at `/data`.
The node mints its libp2p identity key into it on first boot (the provider never sees the key) and
keeps its config, bootstrap-peer store and trusted-owner anchor there, so **the container keeps the
same peer id across restarts and image upgrades** — without it, a restarted node is a stranger to the
cadre that authorized it. The volume is created on first provision, re-attached (never recreated) when
a container is recreated under the same id, and deleted along with the container on terminate. Nothing
in `/data` survives termination, by design.

### Joining a cadre: claim or invitation

A rented node gets into the user's cadre the same two ways a cadre-host node does, and the
provider handles no owner key and no seed for it: the app **claims** the container with a
one-time code, or the container **redeems an invitation** at a member of the cadre that is
already online. `POST /containers` takes `join` beside `profile`, `resources`, `strandFilter`
and `tags`:

```json
{ "join": { "kind": "claim" } }
{ "join": { "kind": "invitation", "invitation": "sereus-invite:1.…" } }
```

Without `join` the request is the seed path below (`partyId`, `bootstrapNodes`,
`pinnedOwnerKeys`, then `PUT /containers/:id/seed`), which stays until the two join paths are
proven on the wire and is then retired.

**Claim** — for a cadre whose only member is the phone, which nothing can dial. The container
starts waiting to be claimed (`CADRE_CLAIM_SECRET`, a secret the provider mints per container),
with the placeholder party `unclaimed`. `partyId`, a non-empty `bootstrapNodes` and
`pinnedOwnerKeys` are each refused by name: a container that is claimed takes its party and
owner from the claim. A claim needs `docker.publicHost`, since the phone dials the container;
without it the create is `400 INVALID_REQUEST` naming `docker.publicHost`. The app then:

1. Polls `GET /containers/:id/code`: `503 NOT_AVAILABLE` until the node reports its peer id
   and an announced WebSocket address, then `200 { code, peerId, multiaddrs }`. The code is
   `sereus-join:1.…` (cadre-core's node claim payload, the same code a cadre-host shows as a
   QR code): the node's peer id, its claim secret, and only its `/ws` address at `publicHost`,
   ending in `/p2p/<peerId>`, since a phone can dial neither TCP nor an in-container address.
   `409 NOT_CLAIMABLE` for a seed-path or invitation container, `409 ALREADY_CLAIMED` once a
   live read says the node has an owner, `409 CONTAINER_GONE` for a stopped or failed one.
2. Hands the code to `CadreNode.claimNode` (after `decodeNodeClaimPayload`). The node verifies
   the proof, records the claim, and restarts in-process into the phone's cadre; `/status` is
   briefly `unhealthy` while it does.
3. Reads `GET /containers/:id`: the provider folds the node's report into the record as
   `joinState: { kind: 'claim', state: 'claimed', ownerKey, partyId }` and replaces the record's
   `partyId` and `ownerKey`. Before the claim it reads `joinState: { kind: 'claim', state: 'awaiting' }`.

**Invitation** — for a cadre with an always-on member the container can reach; the phone can
close as soon as the create returns. The bundle is the text the owner's app encodes
(`encodeCadreInvitation`), checked for shape at create (prefix `sereus-invite:1.`, base64url
JSON, version 1, a party, the invitation key, the signed row, at least one owner key, and at
least one member address naming the member it reaches; a `sereus-join-request:1.` text is
refused as "a join request, not an invitation"). The error never echoes the bundle, which
carries the invitation's private key. `partyId` comes from the bundle and a body `partyId`
that disagrees is refused; `bootstrapNodes` and `pinnedOwnerKeys` are refused, since the
bundle names the members to dial and carries the owner keys the node pins itself.
`docker.publicHost` is not required: the container dials out and holds its connections (a
phone cannot dial it directly later without one). `GET /containers/:id` reads
`joinState: { kind: 'invitation', state: 'pending' }`, then `accepted` with the `memberPeerId`
that admitted it, or `failed` with `error` and `retryable`. An invitation spent or expired
before the node redeemed it reports `failed` with `invite-spent` in the error and
`retryable: false`, and the container keeps running with nothing to do: delete it and rent
again with a fresh invitation. There is no retry route.

**What the API shows.** A container's `join` is returned as `{ kind }` only: the claim secret
leaves the provider in `GET /containers/:id/code` and nowhere else, and the invitation bundle
never. The secret is returned to the authenticated owner of the container over whatever TLS
the deployment puts in front of the API, so put TLS in front of it. `GET /containers` carries
each container's `partyId` and `joinState` from the record, with no live read per row;
`GET /containers/:id` always reads the node live and folds what it reports. A claim
container's `partyId` is `unclaimed` until the claim is folded, so a client that picks
containers out of the list by party misses it; find it by `joinState` instead. An unclaimed container is never reaped: it is
billed like any other running container until the customer deletes it.

**On the host.** The record holds the secret or the bundle (the file store's `containers.json`
with `storage.type: file`), as it holds the seed token, so a provider restart reproduces the
container's environment; and `docker inspect` on the host shows `CADRE_CLAIM_SECRET` or
`CADRE_INVITATION` in the container's environment, as it shows `CADRE_SEED_TOKEN` today. A
container restarted by Docker (`unless-stopped`) replays the same environment: a claimed node
starts from its `claim.json` and, with the secret still set, answers a rival claimant
`already-claimed`.

### Seed trust: pin the tenant's owner key at create time

Delivering a seed (`PUT /containers/:id/seed`) is authenticated by a per-container
bearer token, but whether the node *honours* the seed is a separate decision made
against its own trusted-owner anchor — empty on a fresh container, and not fillable
from replicated state. So `POST /containers` accepts `pinnedOwnerKeys`: the base64url
ed25519 owner public key(s) of the tenant's own cadre, which the orchestrator passes
to the node as `CADRE_OWNER_KEYS`.

```bash
curl -X POST $URL/api/v1/containers \
  -H 'Authorization: Bearer ...' \
  -d '{"partyId":"...","bootstrapNodes":["..."],"pinnedOwnerKeys":["<owner-b64url>"]}'
```

The keys flow only from a tenant's own create request into that tenant's own
container; there is **no provider-level default**, because a provider-wide pin would
let one tenant's owner seed another tenant's node.

Each entry is validated on the way in: it must be base64url and decode to exactly 32
bytes — the same rule the node applies to `CADRE_OWNER_KEYS` — so anything accepted
here is something the container can start with. A malformed entry (including a blank
one) is answered `400 INVALID_REQUEST` with a message naming the offending value, and
nothing is provisioned; previously such a request got a `201` and the container then
failed to boot, which the caller could only discover from container status. Curve
membership is deliberately *not* checked: a well-formed key naming the wrong signer
fails at seed time like any other wrong key. Omitting the field entirely stays valid
— that is how a caller says "trust no seed signer" — and the created container simply
refuses every seed (the omission is logged). Accepted values are stored trimmed and
deduplicated, so the container record shows exactly the pins the node got. The first
accepted seed anchors the key in `/data`, so later seeds from the same owner need no
pin and survive restarts.

### Bootstrap addresses are checked at create time

`bootstrapNodes` is the list of control-network addresses the new container dials to
find the tenant's cadre. It is forwarded verbatim into the container as
`CADRE_BOOTSTRAP_NODES`, so a typo is invisible to the caller unless the create call
rejects it. The container opens the first connection, so the node these addresses name
must be reachable from it; [docs/architecture.md → Which Side Dials](../../docs/architecture.md#which-side-dials-the-add-a-node-flows-compared)
compares this with the other ways to add a machine to a cadre.

The field may be left out, or be `[]`, only when `docker.publicHost` is set: the
container then has no bootstrap peers and waits for the requester to dial it
([Phones dial containers at the public host](#phones-dial-containers-at-the-public-host)).
Without `publicHost` nothing outside the provider's machine can reach a container, so
an absent or empty list is `400 INVALID_REQUEST` (`bootstrapNodes is required: …
docker.publicHost is unset …`). Each entry must:

- be a string that parses as a multiaddr,
- carry a `/p2p/<peerId>` component whose peer id decodes,
- and name where that peer is — an address of nothing but peer ids
  (`/p2p/<peerId>`) is refused.

```bash
curl -X POST $URL/api/v1/containers   -H 'Authorization: Bearer ...'   -d '{"partyId":"party-1",
       "bootstrapNodes":["/dns4/cadre.example/tcp/443/wss/p2p/12D3KooW..."],
       "pinnedOwnerKeys":["<owner-b64url>"]}'
```

Anything else is `400 INVALID_REQUEST` naming the offending entry, with nothing
provisioned. Each clause is a different failure the tenant would otherwise only meet
as a broken container: an unparsable address makes libp2p construction throw and the
node never starts; an address with no `/p2p/` is dropped by `@libp2p/bootstrap`, so
the node comes up healthy-looking with **zero** bootstrap peers and never joins; a
truncated peer id throws inside the child; and an address with no location leaves the
node holding a peer it can never dial. Reachability is *not* checked — a good address
for a peer that is down looks the same from here.

The rest of the body is checked at the same boundary: `partyId` must be a non-blank
string (it is stored trimmed), `profile` must be `storage` or `transaction`,
`strandFilter` a string, `resources` an object with string `memoryLimit`/`cpuLimit`
and a numeric `storageQuotaBytes`, and `tags` an object of strings. Limit *formats*
(`"512M"`, `"0.5"`) are still the orchestrator's to parse.

### Phones dial containers at the public host

Every container listens for libp2p on TCP (port 4001 inside the container) and on
WebSocket (4002), and the provider publishes both on host ports from
`docker.portRange`, on all interfaces. A phone has no TCP transport and listens on
nothing, so it reaches a container only by dialing that WebSocket port, at an address
someone gave it.

`docker.publicHost` supplies the address: the DNS name or IP address at which this
machine's published ports are reachable from outside. When it is set, each container
announces `/dns4/<publicHost>/tcp/<TCP host port>` and
`/dns4/<publicHost>/tcp/<WebSocket host port>/ws` (`/ip4` or `/ip6` for an IP address)
besides its in-container addresses, and `GET /containers/:id/peer` returns all of them,
each ending in `/p2p/<peerId>`. A phone then rents a node like this:

1. `POST /containers` with `pinnedOwnerKeys` and no `bootstrapNodes`.
2. `GET /containers/:id/peer`, and `CadreNode.addDrone` with those addresses.
3. `PUT /containers/:id/seed`.
4. The phone dials the container (`reconcileControlCohort()`).

[docs/architecture.md → Enrollment Flow: Phone Adds Provider Drone](../../docs/architecture.md#enrollment-flow-phone-adds-provider-drone)
describes the flow.

- **In-container addresses are still returned**, so containers on one Docker network
  reach each other directly. A phone's dial to them fails and libp2p tries the next.
- **The host is fixed when a container is created.** It is part of the container's
  environment, so a changed `publicHost` reaches only containers created afterwards.
- **Until the phone's rows arrive, the container admits any peer.** A node with no
  authorized members admits every connection and stream (cadre-core's cold-start rule),
  and a container with no bootstrap peers stays that way until the phone dials, usually
  right after step 3.
- **No TLS proxy.** A provider that fronts containers with `/wss` on 443 would announce
  the proxy's address instead and needs a per-container path or port there; the
  provider does not do this.
- **A claim needs the host, an invitation does not.** `join.kind: 'claim'` is refused
  without `publicHost`, since the phone dials the container to claim it;
  `join.kind: 'invitation'` is allowed, since the container dials the member, but a phone
  cannot dial such a container directly later ([Joining a cadre: claim or invitation](#joining-a-cadre-claim-or-invitation)).

### Kubernetes

For Kubernetes deployments, implement a custom orchestrator or use the Docker orchestrator with Docker-in-Docker.
A custom orchestrator **must** give each container durable per-tenant storage at `/data` (a PVC, say) and
delete it on terminate — see the volume contract above.

### One-shot mode

Both `POST /containers` and `DELETE /containers/:id` accept a
`shutdownAfter: true` flag. When set, the provider responds normally,
then gracefully exits the process after the response flushes. This is
intended for batch jobs, CI tasks, and managed orchestrators (e.g.
Kubernetes Jobs) that provision a single container and exit.

Shutdown only fires when the operation actually succeeds: quota errors,
authentication failures, ownership mismatches, and orchestrator errors
all return their normal error response and the process stays up.

```bash
# Provision then exit
curl -X POST $URL/api/v1/containers \
  -H 'Authorization: Bearer ...' \
  -d '{"partyId":"...","bootstrapNodes":["..."],"shutdownAfter":true}'

# Terminate then exit (body form)
curl -X DELETE $URL/api/v1/containers/$ID \
  -H 'Authorization: Bearer ...' \
  -d '{"shutdownAfter":true}'

# Terminate then exit (query form, for clients that avoid DELETE bodies)
curl -X DELETE "$URL/api/v1/containers/$ID?shutdownAfter=true" \
  -H 'Authorization: Bearer ...'
```

On success the response body carries `"shutdownInitiated": true` so the
caller can confirm the flag was honored (the actual shutdown is
observed by the connection closing).

For supervised one-shot runs use the unit files under
[`service/`](./service):

- Linux: [`cadre-provider.service`](./service/cadre-provider.service) (systemd, `RestartPreventExitStatus=0`)
- macOS: [`com.serfab.cadre-provider.plist`](./service/com.serfab.cadre-provider.plist) (launchd, `SuccessfulExit=false`)
- Windows: [`install-service.ps1`](./service/install-service.ps1) (NSSM, `AppExit 0 Exit`)

All three are configured so a clean exit (code 0) is final — the host
won't restart the provider after it gracefully shuts down.

## License

MIT

