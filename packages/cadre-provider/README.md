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
| POST | `/api/v1/containers` | Create a new container |
| GET | `/api/v1/containers` | List customer's containers |
| GET | `/api/v1/containers/:id` | Get container status |
| DELETE | `/api/v1/containers/:id` | Terminate container |
| GET | `/api/v1/billing/plans` | List billing plans |
| GET | `/api/v1/billing/status` | Get customer billing status |

## Configuration

Configuration can be provided via YAML/JSON file or environment variables.

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

| Variable | Description |
|----------|-------------|
| `PROVIDER_HOST` | Server host |
| `PROVIDER_PORT` | Server port |
| `PROVIDER_AUTH_MODE` | Authentication mode (`none`, `api-key`, `oauth`) |
| `PROVIDER_ALLOW_INSECURE_NO_AUTH` | Set to `true` to acknowledge running fully open with `PROVIDER_AUTH_MODE=none` |
| `PROVIDER_DOCKER_SOCKET` | Docker socket path |
| `PROVIDER_DOCKER_IMAGE` | Container image |
| `STRIPE_SECRET_KEY` | Stripe API key |

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

### Kubernetes

For Kubernetes deployments, implement a custom orchestrator or use the Docker orchestrator with Docker-in-Docker.

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

