# @serfab/cadre-provider

A reference service for renting out always-on Sereus cadre nodes. It exposes an HTTP API through which a customer's app creates a node, runs each node as a Docker container of the `@serfab/cadre-cli` image, and never holds a customer's owner key.

This README covers running and configuring the service and its HTTP reference. How a rented node joins a cadre, what the provider can see, and how an app rents a node through cadre-core are described in [Provider-hosted nodes](https://github.com/gotchoices/sereus/blob/master/docs/hosting/provider.md).

## Prerequisites

- **Node.js 20 or later.**
- **Docker Engine on the same machine**, with the user that runs the provider allowed to use the Docker socket (`docker.socketPath`, default `/var/run/docker.sock`).
- **The node image on that Docker host**, under the name in `docker.image` (default `sereus-cadre-node:latest`). No image is published; [First run](#first-run) builds it from the repository. With the default `pullPolicy` the provider does not pull, so an image that is absent makes every create end in `error`.
- **A Docker network** with the name in `docker.network` (default `sereus_provider`). The provider does not create it.
- **For customers on phones: a DNS name or IP address** at which this machine's `docker.portRange` (default 10000–20000) is reachable from the internet, set as `docker.publicHost`. Without it only the invitation join is accepted ([Joining a cadre: claim or invitation](#joining-a-cadre-claim-or-invitation)).
- **TLS in front of the API** for anything but a local test. The API hands out bearer tokens and node claim secrets; the provider itself serves plain HTTP.

## Install

```bash
npm install -g @serfab/cadre-provider
```

This installs the `cadre-provider` command. To embed the server in your own process instead, see [Programmatic use](#programmatic-use).

## First run

These steps start a provider on one machine and create a container that waits to be claimed.

1. Build the node image from a checkout of the repository. The build context is the repository root.

	```bash
	git clone https://github.com/gotchoices/sereus.git
	cd sereus
	docker build -f packages/cadre-cli/docker/Dockerfile -t sereus-cadre-node:latest .
	```

2. Create the Docker network.

	```bash
	docker network create sereus_provider
	```

3. Create an API key. The provider stores only the SHA-256 hash of a key.

	```bash
	KEY=$(openssl rand -hex 32)
	printf '%s' "$KEY" | sha256sum | cut -d' ' -f1    # on macOS: shasum -a 256
	```

4. Write `provider.yaml` with the hash. `publicHost: localhost` lets one machine exercise the claim join; a real deployment uses its public name.

	```yaml
	auth:
	  mode: api-key
	  apiKeyHashes:
	    - <the hash printed in step 3>
	docker:
	  publicHost: localhost
	storage:
	  type: file
	  path: ./provider-data
	```

5. Check the configuration, then start.

	```bash
	cadre-provider check -c provider.yaml
	cadre-provider start -c provider.yaml
	# Cadre Provider API listening at http://0.0.0.0:3000/api/v1
	```

6. Confirm the API answers. This route needs no key.

	```bash
	curl http://localhost:3000/api/v1/status
	# {"ok":true,"service":"cadre-provider","version":"<package version>"}
	```

7. Create a container.

	```bash
	curl -X POST http://localhost:3000/api/v1/containers \
	  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
	  -d '{"join":{"kind":"claim"}}'
	```

	The answer is `201` with the new record. Its `status` is `pending` or `creating`:

	```json
	{
	  "ok": true,
	  "data": {
	    "container": {
	      "id": "ctr_V1StGXR8_Z5jdHi6",
	      "customerId": "admin",
	      "partyId": "unclaimed",
	      "profile": "storage",
	      "status": "pending",
	      "resources": {},
	      "tags": {},
	      "createdAt": "2026-11-16T10:00:00.000Z",
	      "updatedAt": "2026-11-16T10:00:00.000Z",
	      "join": { "kind": "claim" }
	    }
	  }
	}
	```

8. Read the container until its `status` is `running`, then ask for its node code.

	```bash
	curl -H "Authorization: Bearer $KEY" http://localhost:3000/api/v1/containers/ctr_V1StGXR8_Z5jdHi6
	curl -H "Authorization: Bearer $KEY" http://localhost:3000/api/v1/containers/ctr_V1StGXR8_Z5jdHi6/code
	# {"ok":true,"data":{"code":"sereus-join:1.…","peerId":"12D3Koo…","multiaddrs":["/dns4/localhost/tcp/<port>/ws/p2p/12D3Koo…"]}}
	```

	A `status` of `error` carries the reason in `error`; a missing image or network appears there as Docker's own message.

9. Remove the container.

	```bash
	curl -X DELETE -H "Authorization: Bearer $KEY" http://localhost:3000/api/v1/containers/ctr_V1StGXR8_Z5jdHi6
	# {"ok":true,"message":"Container terminated"}
	```

## Commands

| Command | What it does |
|---|---|
| `cadre-provider start` | Loads the configuration and starts the API server. `SIGINT` or `SIGTERM` shuts it down and exits 0. |
| `cadre-provider check` | Loads and validates the configuration, prints it with every secret shown as `[redacted]`, and says when there is no `provider` block for `GET /descriptor` to serve. Exits 1 on an invalid configuration. |
| `cadre-provider --version` | Prints the package version. |

| Flag | Commands | Meaning |
|---|---|---|
| `-c, --config <path>` | `start`, `check` | Configuration file, `.yaml`, `.yml` or `.json`. Without it the defaults and the environment apply. |
| `-p, --port <port>` | `start` | Port to listen on, a whole number from 0 to 65535. Overrides the file and `PROVIDER_PORT`. |
| `-d, --debug` | `start` | Enables the `cadre:*` and `sereus:*` debug log namespaces. |

## Configuration

Configuration is read from the file, then from environment variables, which override the file one setting at a time. The result is checked strictly at `start` and at `check`: an unknown or misspelled key, or a value of the wrong type, stops the provider with one error that names every problem and where it came from. A file holding `server: { prot: 3000 }` with `PROVIDER_AUTH_MODE=apikey` in the environment fails with:

```
Config /etc/cadre-provider.yaml: unknown key server.prot (did you mean 'port'?)
Environment variable PROVIDER_AUTH_MODE: auth.mode must be one of 'none', 'api-key', 'oauth', got "apikey"
```

A block with no children (`server:` on its own line) counts as absent. Values under `push` and `billing` are never echoed into an error. A commented example is in the repository, not in the npm package: [`example.provider.yaml`](https://github.com/gotchoices/sereus/blob/master/packages/cadre-provider/example.provider.yaml). The option types are in [`src/config/types.ts`](./src/config/types.ts).

### Settings

| Key | Default | Meaning |
|---|---|---|
| `server.host` | `0.0.0.0` | Address the API binds. |
| `server.port` | `3000` | API port; `0` asks the OS for a free port. |
| `server.basePath` | `/api/v1` | Prefix of every route. |
| `server.cors.origin`, `server.cors.credentials` | `true`, `true` | CORS policy: an origin string, a list of them, or `true`/`false`. |
| `auth.*` | `mode: api-key` | See [Authentication and permissions](#authentication-and-permissions) and [Sign-in from apps](#sign-in-from-apps-oauth-2-with-pkce). |
| `docker.socketPath` | `/var/run/docker.sock` | Docker Engine socket. |
| `docker.network` | `sereus_provider` | Network containers attach to. Not `host`, `none` or `container:<id>`, in which Docker ignores port bindings. |
| `docker.image` | `sereus-cadre-node:latest` | Node image. |
| `docker.pullPolicy` | `if-not-present` | `always` pulls the image before every create. `if-not-present` and `never` do not pull; the image must already be on the host. |
| `docker.defaultResources.memoryLimit` | `512M` | Memory limit: a size such as `512M` or `2G`. |
| `docker.defaultResources.cpuLimit` | `"0.5"` | CPU count as a quoted string. |
| `docker.defaultResources.storageQuotaBytes` | 10 GB | Passed to the node as its storage quota. |
| `docker.portRange.start`, `.end` | `10000`, `20000` | Host ports for containers, four each, so the default range holds 2,500 containers. |
| `docker.publicHost` | unset | DNS name or IP address at which the port range is reachable from outside ([Phones dial containers at the public host](#phones-dial-containers-at-the-public-host)). |
| `billing.enabled` | `false` | Turns on the quota check and the billing tick ([Billing](#billing)). |
| `billing.defaultPlanId` | `starter` | Plan of a billing record created without one. |
| `billing.usageCollectionIntervalSec` | `60` | Seconds between billing ticks. |
| `storage.type` | `memory` | `memory` or `file`. `memory` loses every record at restart while the containers keep running in Docker; use `file` for anything but a test. |
| `storage.path` | unset | Directory for the file store; required with `file` ([Files the provider writes](#files-the-provider-writes)). |
| `logging.level` | `info` | `debug` turns on the HTTP server's request log. Other diagnostics use the `debug` package (`--debug`, or `DEBUG=cadre:provider:*`). |
| `push` | unset | Push credentials given to customers' nodes ([Push credentials](#push-credentials)). |
| `provider` | unset | What `GET /descriptor` publishes ([Provider descriptor](#provider-descriptor)). |

A create request's own `resources` are held to the same rules as `docker.defaultResources`, and replace it as a whole: a request that sets only `memoryLimit` runs with no CPU limit.

`billing.stripeSecretKey` and `billing.stripeWebhookSecret` are accepted and redacted, and `auth.jwksUri`, `auth.issuer` and `auth.audience` are accepted, but the provider does not read any of the five. They are in the loaded configuration for your own hooks and webhook handler to use.

### Environment variables

Each variable overrides one setting. A boolean variable accepts `true`, `false`, `1` or `0`, and a number variable only a number; anything else fails the start. An empty value counts as unset. Unknown `PROVIDER_*` names are ignored, because other software may use the prefix.

| Variable | Setting |
|---|---|
| `PROVIDER_HOST` | `server.host` |
| `PROVIDER_PORT` | `server.port` |
| `PROVIDER_BASE_PATH` | `server.basePath` |
| `PROVIDER_AUTH_MODE` | `auth.mode` |
| `PROVIDER_ALLOW_INSECURE_NO_AUTH` | `auth.allowInsecureNoAuth` |
| `PROVIDER_JWKS_URI` | `auth.jwksUri` |
| `PROVIDER_ISSUER` | `auth.issuer` |
| `PROVIDER_AUDIENCE` | `auth.audience` |
| `PROVIDER_OAUTH_DEV_CONSENT_PAGE` | `auth.oauth.devConsentPage` |
| `PROVIDER_ID` | `provider.id` |
| `PROVIDER_NAME` | `provider.name` |
| `PROVIDER_PUBLIC_URL` | `provider.publicUrl` |
| `PROVIDER_DOCKER_SOCKET` | `docker.socketPath` |
| `PROVIDER_DOCKER_IMAGE` | `docker.image` |
| `PROVIDER_DOCKER_NETWORK` | `docker.network` |
| `PROVIDER_DOCKER_PUBLIC_HOST` | `docker.publicHost` |
| `PROVIDER_BILLING_ENABLED` | `billing.enabled` |
| `STRIPE_SECRET_KEY` | `billing.stripeSecretKey` |
| `STRIPE_WEBHOOK_SECRET` | `billing.stripeWebhookSecret` |
| `PROVIDER_STORAGE_TYPE` | `storage.type` |
| `PROVIDER_STORAGE_PATH` | `storage.path` |
| `PROVIDER_LOG_LEVEL` | `logging.level` |

API key hashes, OAuth clients and push credentials have no variable; they are set in the file.

### Push credentials

A node that holds FCM or APNs credentials can send a push notification that wakes a customer's suspended phone ([Push wake](https://github.com/gotchoices/sereus/blob/master/docs/strands/hibernation.md#push-wake)). The `push` block supplies those credentials to the nodes this provider creates.

The credentials do not by themselves send any wake. A node sends one only when the program running it reports strand activity, and the `cadre start` process in each container never does (ticket `passive-strand-activity-fanout-detector`).

```yaml
push:
  default:                      # every customer without an entry under tenants
    fcm:
      projectId: my-firebase-project
      clientEmail: push@my-firebase-project.iam.gserviceaccount.com
      privateKey: "-----BEGIN PRIVATE KEY-----\n…"
    apns:
      keyId: ABC123DEFG
      teamId: TEAM123456
      bundleId: com.example.app
      privateKey: "-----BEGIN PRIVATE KEY-----\n…"
      production: true          # optional; false or absent uses the APNs sandbox
    cooldownMs: 300000          # optional
    debounceMs: 10000           # optional
  tenants:
    customer-42:                # a customer id; same shape as default
      fcm: { projectId: …, clientEmail: …, privateKey: … }
```

- **One set per container, chosen by customer id.** When a container is created, the provider uses the entry under `tenants` for the container's customer, or `default` when there is none, or nothing. An entry under `tenants` replaces `default` as a whole. One customer's entry is never given to another customer's node.
- **A platform block is all or nothing.** `fcm` needs `projectId`, `clientEmail` and `privateKey`; `apns` needs `keyId`, `teamId`, `bundleId` and `privateKey`. A partial block stops the provider at start.
- **`cooldownMs` and `debounceMs` are optional.** They limit how often the node pushes; the node's defaults are 5 minutes and 10 seconds.
- **The credentials are in the container's environment.** The provider passes them as the `CADRE_PUSH` variable, fixed when the container is created, so a changed `push` block reaches only containers created afterwards, and `docker inspect` on the host shows them.

## Authentication and permissions

The provider is closed by default. The default mode is `api-key`, and with no keys configured every authenticated route answers `401`. A caller sends its credential as `Authorization: Bearer <credential>`.

### API keys

In `api-key` mode a bearer is accepted from one of three sources, in this order:

1. **The `validateApiKey` hook**, when you pass one ([Custom authentication](#custom-authentication)). With a hook installed the other two are not consulted.
2. **`auth.apiKeyHashes`**: SHA-256 hex hashes of administrator keys. A matching key acts as customer `admin` with permission `*`. [First run](#first-run) shows how to make one.
3. **Key records in the store**, each with its own customer id, permissions and optional expiry. The provider has no command or route that creates one; your own code writes it with `store.saveApiKey` and `hashApiKey`:

	```typescript
	import { createProviderServer, createStore, hashApiKey, loadConfig } from '@serfab/cadre-provider';

	const config = loadConfig({ configFile: 'provider.yaml' });
	const store = createStore(config.storage);
	await store.saveApiKey({
		keyHash: hashApiKey(rawKey),
		customerId: 'customer-42',
		name: 'customer-42 app key',
		permissions: ['containers:*', 'billing:read'],
		createdAt: new Date(),
	});
	const server = await createProviderServer({ config, store });
	await server.start();
	```

### Insecure no-auth mode

`mode: none` disables authentication and treats every caller as customer `dev-customer` with permission `*`. The provider refuses to start in this mode unless the configuration acknowledges it:

```yaml
auth:
  mode: none
  allowInsecureNoAuth: true
```

The same can be set with `PROVIDER_AUTH_MODE=none PROVIDER_ALLOW_INSECURE_NO_AUTH=true`. Use it only on a development machine.

### Permission scopes

Each authenticated identity carries a list of permissions. A request that authenticates but lacks the route's scope is answered `403 INSUFFICIENT_SCOPE`. `*` grants everything, and `<resource>:*` (for example `containers:*`) grants every scope of that resource.

| Route | Required scope |
|---|---|
| `POST /containers` | `containers:create` |
| `GET /containers`, `GET /containers/:id`, `GET /containers/:id/peer`, `GET /containers/:id/code` | `containers:read` |
| `DELETE /containers/:id` | `containers:delete` |
| `GET /billing/status` | `billing:read` |
| `GET /status`, `GET /descriptor`, `GET /billing/plans`, `/oauth/authorize`, `/oauth/token` | none; no bearer is read |

Scope and ownership are separate checks. Every per-container route also verifies that the container belongs to the calling customer, and answers `403 FORBIDDEN` when it does not.

### Custom authentication

`createProviderServer` takes `authHooks` ([`AuthHooks`](./src/server/auth.ts)). `validateApiKey(key)` replaces the key lookup in `api-key` mode. `validateJwt(token)` validates a bearer in `oauth` mode that is not one of the provider's own tokens; the provider does not verify JWTs itself. Each returns `{ customerId, permissions }`, or `undefined` to refuse.

```typescript
import { createProviderServer, loadConfig, type AuthHooks } from '@serfab/cadre-provider';

const authHooks: AuthHooks = {
	async validateJwt(token) {
		const user = await verifyWithMyIdentityProvider(token); // your code
		return { customerId: user.id, permissions: user.scopes };
	},
};

const server = await createProviderServer({ config: loadConfig({ configFile: 'provider.yaml' }), authHooks });
```

## Sign-in from apps: OAuth 2 with PKCE

An app needs a token limited to one customer's containers without seeing the customer's password or card. With `auth.mode: oauth` and an `auth.oauth` block, the provider runs OAuth 2 authorization code with PKCE (RFC 6749 §4.1, RFC 7636): the app opens `GET /oauth/authorize` in the system browser, the customer signs in and pays on your pages, the browser returns to the app with a one-time code, and the app exchanges the code at `POST /oauth/token` for a bearer. An operator with an identity provider of their own leaves `auth.oauth` unset and uses `validateJwt`. The app's side is in cadre-core ([Renting a node from an app](https://github.com/gotchoices/sereus/blob/master/docs/hosting/provider.md#renting-a-node-from-an-app)).

### Registering apps

```yaml
auth:
  mode: oauth
  oauth:
    clients:
      - clientId: sereus-chat
        redirectUris: ["sereus-chat://provider-auth", "sereus-chat-second://provider-auth"]
        scopes: ["containers:*", "billing:read"]   # the most a token for this client may carry
    accessTokenTtlSec: 3600       # default
    refreshTokenTtlSec: 2592000   # default, 30 days
    devConsentPage: false
```

`auth.oauth` is allowed only with `mode: oauth`. `clients` names at least one app, and each `clientId` is unique. A redirect URI is an absolute URL with no fragment, compared by exact string equality. A custom scheme is the usual form; `http` is accepted only at a loopback host, because the code travels in that URL. Each scope is one of the [permission scopes](#permission-scopes) or a `<resource>:*` wildcard; `*` is not allowed.

### The `authorizeCustomer` hook

Your account system connects through one hook, called after the client, redirect URI and scopes have been checked. It receives the browser's headers (its cookies tell your site who is signed in) and the authorize query.

```typescript
const authHooks: AuthHooks = {
	async authorizeCustomer({ clientId, scopes, headers, query }) {
		const session = await readSessionCookie(headers.cookie); // your code
		const here = `/api/v1/oauth/authorize?${new URLSearchParams(query)}`;
		if (!session) return { redirect: `https://acme.example/login?next=${encodeURIComponent(here)}` };
		if (!session.paid) return { redirect: `https://acme.example/checkout?next=${encodeURIComponent(here)}` };
		return { customerId: session.customerId, planId: session.planId };
	},
};
```

It answers in one of three ways:

- `{ customerId, planId? }` issues the code. A customer with no billing record gets one with that plan, so the plan's container limit applies from the first create.
- `{ redirect }` sends the browser to your login or checkout page, which returns it to the same authorize URL afterwards.
- `{ deny }` returns the app `error=access_denied` with that reason.

### The dev consent page

With no hook and `devConsentPage: true`, the provider serves a form in place of your account system: whoever opens the authorize URL types a customer id, picks a plan and approves. Anyone can sign in as any customer, so it requires `allowInsecureNoAuth: true`.

The provider refuses to start with neither a hook nor the page, because no sign-in could succeed, and with both, because the form would sign anyone in alongside the hook.

### Endpoints

`GET /oauth/authorize` takes `response_type=code`, `client_id`, `redirect_uri`, `scope` (space-separated), `state`, `code_challenge` and `code_challenge_method=S256`.

- An unknown client or an unregistered redirect URI is answered with a `400` page and no redirect, since redirecting to an unregistered URI is the attack the registration prevents.
- Every other fault redirects to the registered URI with `error` (`invalid_request`, `invalid_scope`, `unsupported_response_type` or `access_denied`), `error_description` and the `state`.
- On success the browser is sent to `redirect_uri?code=…&state=…`. The code lasts ten minutes and can be presented once.

`POST /oauth/token` takes a form-encoded or JSON body and answers `{ access_token, token_type: "Bearer", expires_in, refresh_token, scope }` with `Cache-Control: no-store`.

- `grant_type=authorization_code` with `code`, `code_verifier`, `client_id` and `redirect_uri`. It answers `invalid_grant` when the code is unknown, expired, already presented (even once with a wrong verifier), issued to another client or redirect URI, or the verifier does not hash to the challenge.
- `grant_type=refresh_token` with `refresh_token` and `client_id`. The presented refresh token and its access token stop working and a new pair is issued with the same scopes. It answers `invalid_grant` when the token is unknown, expired, already used or issued to another client.

Token errors follow RFC 6749 §5.2: `400 { error, error_description }` with `invalid_request`, `invalid_client`, `invalid_grant` or `unsupported_grant_type`.

### Bearer lookup order

In `oauth` mode a bearer is first looked up as one of the provider's own tokens. An access token is stored hashed, as an API key record named `oauth:<clientId>` whose permissions are the granted scopes; an expired one is deleted and counts as absent. A bearer that is not one of these goes to `validateJwt` when that hook is installed, so one provider can accept its own tokens and an external identity provider's. Codes and refresh tokens are stored hashed too; the raw values exist only in the redirect and the token response.

## Provider descriptor

`GET /descriptor` is public. It is what an app's store screen shows and what cadre-core's `parseProviderDescriptor` reads. The provider builds it at request time from the `provider` block and `server.basePath`.

```yaml
provider:
  id: acme-nodes                          # stable; an app keys its rental records by it
  name: Acme Cadre Nodes
  publicUrl: https://nodes.acme.example   # the origin this API is reached at
  termsUrl: https://acme.example/terms    # optional
  regions: ["eu-west"]                    # optional, in your own words
  icon: https://acme.example/icon.png     # optional
```

```json
{
  "v": 1,
  "id": "acme-nodes",
  "name": "Acme Cadre Nodes",
  "apiBaseUrl": "https://nodes.acme.example/api/v1",
  "oauth": {
    "authorizeUrl": "https://nodes.acme.example/api/v1/oauth/authorize",
    "tokenUrl": "https://nodes.acme.example/api/v1/oauth/token",
    "scopes": ["containers:*", "billing:read"]
  },
  "plansUrl": "https://nodes.acme.example/api/v1/billing/plans",
  "termsUrl": "https://acme.example/terms",
  "regions": ["eu-west"],
  "icon": "https://acme.example/icon.png"
}
```

- **`id`, `name` and `publicUrl` are required.** Without a `provider` block the route answers `404 NOT_CONFIGURED`, and `check` says so.
- **`publicUrl` is `https`**, with no query or fragment; `http` is accepted only at a loopback host, for a development run. Tokens and node codes travel over the URLs built from it.
- **`oauth` is present only when `auth.oauth` is configured**, and `oauth.scopes` is the union of what the registered clients may be granted. cadre-core refuses a descriptor without `oauth`, so a provider that uses an external identity provider publishes its own descriptor naming that provider's endpoints.
- **There is no client id in the descriptor.** Each app pairs it with the client id it registered.

## HTTP API

Routes are under `server.basePath` (default `/api/v1`).

| Method | Path | Answer |
|---|---|---|
| GET | `/status` | `{ ok, service, version }`; a liveness check. |
| GET | `/descriptor` | The [provider descriptor](#provider-descriptor). |
| GET, POST | `/oauth/authorize` | [Sign-in](#endpoints); `POST` exists only with the dev consent page. |
| POST | `/oauth/token` | [Token exchange and refresh](#endpoints). |
| POST | `/containers` | `201 { container }` for the new container. |
| GET | `/containers` | `{ containers }`: the calling customer's records. |
| GET | `/containers/:id` | `{ container, health? }`; reads a running node live. |
| GET | `/containers/:id/code` | `{ code, peerId, multiaddrs }` for a container waiting to be claimed. |
| GET | `/containers/:id/peer` | `{ peerId, multiaddrs }`: every address the node reports, read live. |
| DELETE | `/containers/:id` | Stops and removes the container and its volume. |
| GET | `/billing/plans` | `{ plans }`; public. |
| GET | `/billing/status` | `{ billing }`: the customer's billing record, absent when there is none. |

Except for the descriptor and the OAuth endpoints, a success is `{ "ok": true, "data": … }` and a failure is `{ "ok": false, "error": { "code", "message" } }`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `INVALID_REQUEST` | The create body failed validation; the message names the field. |
| 401 | `UNAUTHORIZED`, `AUTH_ERROR` | No credential, an unknown one, or a hook that threw. |
| 403 | `INSUFFICIENT_SCOPE` | The identity lacks the route's scope. |
| 403 | `FORBIDDEN` | The container belongs to another customer. |
| 403 | `QUOTA_EXCEEDED` | Plan limit reached, subscription lapsed, or a balance with no payment method. |
| 404 | `NOT_FOUND` | No such container. |
| 404 | `NOT_CONFIGURED` | `GET /descriptor` without a `provider` block. |
| 409 | `NOT_CLAIMABLE`, `ALREADY_CLAIMED`, `CONTAINER_GONE` | `GET /containers/:id/code` refusals. |
| 503 | `NOT_AVAILABLE` | The node has not reported what the route needs yet; ask again. |

A `DELETE` whose stop or removal failed answers `200` with `{ "ok": false, "message": "Termination failed" }`, and the record becomes `error`.

### Joining a cadre: claim or invitation

`POST /containers` takes `join`, which is required, and optionally `profile`, `resources`, `strandFilter` and `tags`. The body names no party, address or owner key: a claim supplies the party and the owner, and an invitation bundle carries the party, the members to dial and the owner keys the node trusts. The sequence of each join is in [Provider flow](https://github.com/gotchoices/sereus/blob/master/docs/hosting/provider.md#provider-flow).

```json
{ "join": { "kind": "claim" } }
{ "join": { "kind": "invitation", "invitation": "sereus-invite:1.…" }, "profile": "storage", "tags": { "label": "home" } }
```

| Field | Rule |
|---|---|
| `join.kind` | `claim` or `invitation`. `claim` is refused unless `docker.publicHost` is set. |
| `join.invitation` | The text an owner's app produces with `encodeCadreInvitation`. Checked for shape; an error never echoes it. |
| `profile` | `storage` (default) or `transaction`. |
| `resources` | `memoryLimit`, `cpuLimit` and `storageQuotaBytes`, as in `docker.defaultResources`. |
| `strandFilter` | A string, passed to the node as `CADRE_STRAND_FILTER`. |
| `tags` | An object of strings, stored on the record and returned. |

A request that fails any rule is answered `400 INVALID_REQUEST` and nothing is provisioned.

**Claim.** The container starts with a one-time secret the provider generates. The app polls `GET /containers/:id/code`, decodes the code with cadre-core's `decodeNodeClaimPayload` and passes it to `CadreNode.claimNode`. The code is `sereus-join:1.…`, the format a cadre-host shows as a QR code. It carries the node's peer id, its claim secret, and only its WebSocket address at `publicHost`.

| `GET /containers/:id/code` answer | When |
|---|---|
| `200 { code, peerId, multiaddrs }` | The node is waiting to be claimed and has reported its peer id and public WebSocket address. |
| `503 NOT_AVAILABLE` | The node has not reported them yet. |
| `409 NOT_CLAIMABLE` | The container was created with an invitation. |
| `409 ALREADY_CLAIMED` | A live read shows the node has an owner. |
| `409 CONTAINER_GONE` | The container is `stopped` or `error`. |

**Invitation.** The container redeems the bundle at one of the members it names, so `publicHost` is not required. A bundle that is not well formed is refused at create; a `sereus-join-request:1.` text is refused as "a join request, not an invitation".

### The container record

`GET /containers/:id` and the list return these fields. Dates are ISO 8601 strings.

| Field | Meaning |
|---|---|
| `id`, `customerId`, `profile`, `resources`, `tags`, `createdAt`, `updatedAt` | As created. |
| `status` | `pending`, `creating`, `enrolling`, `running`, `stopping`, `stopped` or `error`. |
| `error` | The failure, when `status` is `error`. |
| `partyId` | The cadre the node serves. A claim container reports `unclaimed` until the claim is recorded. |
| `peerId` | The node's peer id, once it first reported healthy. |
| `join` | `{ kind }` only. The secret and the bundle are never returned here. |
| `joinState` | Claim: `awaiting`, or `claimed` with `ownerKey` and `partyId`. Invitation: `pending`, `accepted` with `memberPeerId`, or `failed` with `error` and `retryable`. |
| `ownerKey` | The owner key a claim named. |
| `stopReason` | `customer` after a `DELETE`, `non-payment` after a lapse. |

The provider updates `joinState`, `partyId` and `ownerKey` whenever it reads the node, and `GET /containers/:id` reads a `running` node on every call; the list returns the records as stored. A client that selects containers from the list by `partyId` misses an unclaimed one and should select by `joinState`.

An invitation that was spent or expired before the node redeemed it ends as `failed` with `invite-spent` in `error` and `retryable: false`. The container keeps running; delete it and create another with a new invitation.

### One-shot mode

`POST /containers` and `DELETE /containers/:id` accept `shutdownAfter: true`. The provider answers normally with `"shutdownInitiated": true` added, then shuts down and exits 0. `DELETE` also accepts it as the query `?shutdownAfter=true`; the body wins when both are present. A request that fails does not shut the provider down.

```bash
curl -X DELETE "$URL/api/v1/containers/$ID?shutdownAfter=true" -H "Authorization: Bearer $KEY"
```

This suits a batch job that provisions or removes one container and exits. The service definitions in [`service/`](./service/README.md) treat exit 0 as final for that reason.

## Billing

The provider enforces plan limits, records usage, and stops the containers of a customer whose subscription lapses. It computes no charges and calls no payment processor: your own code reports subscription changes to it.

- **Plans.** `GET /billing/plans` lists three built-in plans, `starter`, `professional` and `enterprise`, with container limits of 3, 10 and 100 (`DEFAULT_PLANS` in [`src/service/billing-service.ts`](./src/service/billing-service.ts)). They are not configurable.
- **Billing records.** A customer gets a record at their first OAuth sign-in, or when your code calls `server.billingService.initializeCustomer(customerId, planId?)`. A customer with no record, such as `admin`, is not limited.
- **Quota.** With `billing.enabled`, `POST /containers` is refused with `403 QUOTA_EXCEEDED` when the customer's containers that are not `stopped` or `error` have reached the plan's limit, when the subscription is `lapsed`, or when the record has a positive balance and no payment method.
- **Usage.** With `billing.enabled`, every `usageCollectionIntervalSec` the provider records, for each `running` container, the interval as uptime, Docker's transmitted-bytes counter, and the node's count of active strands at that moment. Stored bytes are recorded as zero.

`createProviderServer` accepts `billingHooks` (`BillingHooks`), but the service does not call them.

### Subscription state and termination for non-payment

Each billing record (`GET /billing/status`) carries `subscription`:

```json
{ "status": "past-due", "renewsAt": null, "lapsesAt": "2026-11-08T00:00:00.000Z" }
```

- `status`: `active`, `past-due` or `lapsed`. A new record starts `active`.
- `renewsAt`: when the current period renews; `null` once lapsed. A new record's is the end of the month.
- `lapsesAt`: set only while `past-due`; when the grace period ends.

Your payment processor's webhook reports each change through `server.billingService`. `updateSubscription(customerId, patch)` writes the fields it is given. `lapseSubscription(customerId)` lapses the subscription and stops the customer's containers; `updateSubscription` refuses `status: 'lapsed'` because it stops nothing. Both throw for a customer with no billing record. With Stripe, after verifying the event and mapping its customer to yours:

```typescript
const { billingService } = server;

switch (event.type) {
	case 'invoice.paid':
		await billingService.updateSubscription(customerId, {
			status: 'active',
			renewsAt: new Date(invoice.lines.data[0].period.end * 1000),
		});
		break;
	case 'invoice.payment_failed':
		await billingService.updateSubscription(customerId, {
			status: 'past-due',
			lapsesAt: new Date(Date.now() + GRACE_PERIOD_MS), // your grace period
		});
		break;
	case 'customer.subscription.deleted':
		await billingService.lapseSubscription(customerId);
		break;
}
```

A subscription lapses when `lapseSubscription` is called, or on the billing tick once a `past-due` record's `lapsesAt` has passed. A lapse marks the record `lapsed` with both dates `null` and stops each of the customer's live containers, one at a time, with `stopReason: 'non-payment'`. A `past-due` customer can still create containers.

Renewing a lapsed subscription does not bring stopped containers back. Each container's volume, and the node identity in it, was deleted with the container, so the customer rents a new one.

## Containers on the Docker host

### Phones dial containers at the public host

Each container listens for libp2p on TCP (port 4001 inside the container) and on WebSocket (4002). The provider publishes both on host ports from `docker.portRange`, on all interfaces, so the firewall must admit that range. The container's health and metrics ports are published on `127.0.0.1` only; the provider is their only reader.

A phone has no TCP transport and listens on nothing, so it reaches a container only by dialing the container's WebSocket port at an address it was given. `docker.publicHost` supplies that address. When it is set, each container announces `/dns4/<publicHost>/tcp/<TCP host port>` and `/dns4/<publicHost>/tcp/<WebSocket host port>/ws` (`/ip4` or `/ip6` for an IP address) in addition to its in-container addresses.

- **In-container addresses are still announced**, so containers on one Docker network reach each other directly.
- **The host is fixed when a container is created.** A changed `publicHost` reaches only containers created afterwards.
- **There is no TLS proxy.** Containers announce plain `/ws`.

### Per-tenant durable state

Each container gets a named Docker volume, `cadre-<containerId>-data`, mounted at `/data`. The node generates its identity key there on first start and keeps its configuration and node-local state there, so the container keeps the same peer id across restarts and image upgrades. The volume is deleted with the container on terminate. The reasons are in [Durable container identity](https://github.com/gotchoices/sereus/blob/master/docs/hosting/provider.md#durable-container-identity).

A custom orchestrator passed to `createProviderServer` must give each container durable storage at `/data` and delete it on removal.

### What the host can read

The container record holds the claim secret or the invitation bundle, so that a provider restart can reproduce the container's environment. `docker inspect` on the host shows `CADRE_CLAIM_SECRET`, `CADRE_INVITATION` and `CADRE_PUSH` in a container's environment. Restrict access to the Docker socket and to `storage.path` accordingly.

### Stuck provisions

A provider that stops while a container is being created or removed leaves a record in `pending`, `creating`, `enrolling` or `stopping`. A sweep at start and every 5 minutes resolves such records and removes containers that never came up ([How the provider tracks a container](https://github.com/gotchoices/sereus/blob/master/docs/hosting/provider.md#how-the-provider-tracks-a-container)). A container waiting to be claimed is not stopped by the sweep; it runs, and is billed, until its customer deletes it.

## Files the provider writes

With `storage.type: file`, the provider keeps these in `storage.path` and rewrites them as records change.

| File | Contents |
|---|---|
| `containers.json` | Container records, including each claim secret or invitation bundle. |
| `api-keys.json` | Key records and OAuth access tokens, by hash. |
| `authorization-codes.json`, `refresh-tokens.json` | Pending OAuth codes and refresh tokens, by hash. |
| `customer-billing.json` | Billing records. |
| `usage-metrics.jsonl` | One line per container per billing tick. |

The provider writes no log file; it logs to standard output and standard error.

## Programmatic use

```typescript
import { createProviderServer, loadConfig } from '@serfab/cadre-provider';

const config = loadConfig({ configFile: 'provider.yaml' });
const server = await createProviderServer({ config });
await server.start();
```

`loadConfig` takes `configFile`, `env` and `overrides`; overrides are applied last and are typed but not validated. `createProviderServer` takes `config` and optionally `authHooks`, `billingHooks`, `orchestrator` and `store`, and returns `{ app, containerService, billingService, start, stop, requestShutdown }`, where `app` is the Fastify instance. The exports are listed in [`src/index.ts`](./src/index.ts).

## Running as a service

[`service/`](./service/README.md) has a systemd unit, a launchd property list and a Windows (NSSM) install script.

## License

MIT
