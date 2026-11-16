# cadre-host management API

This document is the reference for the HTTP API that `cadre-host start` serves on loopback: the routes with their response shapes and error codes, the Server-Sent Events stream, and the settings a caller may write. The `cadre-host` CLI and the web UI are both clients of it. It is for anyone writing another client or changing a route.

Related: [cadre-host design](cadre-host.md) · [cadre-host package README](../../packages/cadre-host/README.md) · [Provider-hosted nodes](provider.md)

## Who may call it

The listener binds `127.0.0.1` and asks for no credentials. It refuses a request with `403 forbidden_origin` unless the `Host` header, and the `Origin` header when present, name loopback ([Binding and origin policy](cadre-host.md#binding-and-origin-policy)). [No login](cadre-host.md#no-login) gives the reason there is no password.

## API surface

`/api/hosted-nodes`, `/api/nodes` and `/api/settings` wrap a success as `{ ok: true, data }`. `/api/status`, `/nat/*` and `/update/*` return the bare object. Every error is `{ ok: false, error: { code, message } }`; `src/server/error-handler.ts` maps each code to an HTTP status. A request that declares a JSON content type and sends no body is treated as having no body.

| Method and path | Purpose | Errors |
|---|---|---|
| `GET /api/hosted-nodes` | Every hosted node, without secrets | |
| `POST /api/hosted-nodes` | Start a node waiting to be claimed (no body) or one that redeems `{ invitation }`; 201 | 400 `invalid_request`; 409 `invalid_state` or 404 if removed while starting; 500 `orchestrator_error`, `storage_error` |
| `GET /api/hosted-nodes/:id` | One hosted node | 404 `not_found` |
| `GET /api/hosted-nodes/:id/claim` | `{ payload, peerId, multiaddrs, reachability }` | 404; 409 `invalid_state` unless `unclaimed`; 503 `node_unavailable` |
| `DELETE /api/hosted-nodes/:id` | Remove the node; 204 | 404 |
| `POST /api/hosted-nodes/:id/reset` | Remove the node and start a fresh one; 201 | 404; 500 `orchestrator_error` |
| `POST /api/hosted-nodes/:id/retry` | Start an invitation node again | 404; 409 `invalid_state` unless retryable |
| `GET /api/status` | Version, uptime, process handles, NAT status, update state | |
| `GET /api/nodes`, `/api/nodes/:id` | Process handles; one handle with statistics | 404 |
| `GET /api/nodes/:id/logs?lines=N` | End of the node's log (default 200 lines, at most 2000) | 404 |
| `GET`, `PUT /api/settings` | Read `host.config.json`; write the whitelisted keys | 400 `invalid_setting` |
| `GET /api/events` | Server-Sent Events stream | |
| `GET /nat/status`, `POST /nat/test` | The NAT status; `POST` runs the probes first | |
| `GET /nat/providers` | The DDNS providers and their fields | |
| `PUT /nat/ddns` | Set a provider: `{ providerId, hostname, config }` | 400 `invalid_config`, `ddns_provider_unknown`, `ddns_credentials_missing` |
| `PUT /nat/settings` | Change `network`, `upnpEnabled` or `ddns` | 400 `invalid_config` |
| `PUT /nat/nodes/:nodeId/forward` | Record forwards: `{ tcp?, ws? }`; `null` clears a port | 404 `unknown_node`; 400 `invalid_config` |
| `GET /update`, `POST /update/apply` | The update state; apply the update | 400 `no_update_available`, `min_previous_version`; 409 `apply_in_progress`; 500 `apply_failed`, `rollback_failed` |
| `GET`, `PUT /update/settings` | Read or change `autoApply` and `manifestUrl` | |

`/api/nodes` is read-only because the supervisor would undo a stop issued outside `/api/hosted-nodes`. A handle's `partyId` stays at the placeholder `unclaimed` until the node's first respawn after its claim; the hosted-node record carries the real party. The claim route answers 503 until the child reports an address.

## Server-Sent Events

`GET /api/events` sends these events. The UI re-reads the relevant route when one arrives.

| Event | Sent when | Carries |
|---|---|---|
| `node-state-changed` | A child process starts or stops | `nodeId`, `status` |
| `hosted-nodes-changed` | A hosted node was added, claimed, joined by invitation, removed, or otherwise changed | `kind`, `nodeId` |
| `connectivity-changed` | NAT settings or a forward changed, reachability was re-tested, or the NAT status changed by itself | `directReachability` |
| `update-available` | A newer release is seen, or an update was applied | `version` |

The stream sends a comment line every 15 seconds so that proxies do not close an idle connection.

## Write-whitelist for `/api/settings`

`GET /api/settings` returns the whole `host.config.json`. `PUT` accepts only these keys, and any other key is `400 invalid_setting`.

| Key | Effect |
|---|---|
| `upnpEnabled` | Applied to the running `NatService` at once |
| `updates.autoApply` | Applied to the running `UpdateService` |
| `updates.manifestUrl` | Applied to the running `UpdateService`; the environment variable still takes precedence |
| `claimAddresses` | Replaced whole and validated; used by the next claim code |

Every other key, `uiPort` and `dataDir` included, is changed by editing the file and restarting. The file format is version 3 (`src/installer/config.ts`), and a file of another version is refused on read.

## Limits and accepted tradeoffs

- **The management API is open to every local account,** including the claim route that returns a claim secret. (ticket `decide-cadre-host-management-api-open-to-other-local-accounts`)
