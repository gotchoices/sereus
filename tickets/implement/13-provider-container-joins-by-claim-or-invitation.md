description: A rented node joins the user's cadre the same two ways a home-hosted node does: the app claims it with a one-time code, or the node redeems an invitation at a member that is already online. The hosting service never handles owner keys or seeds for these containers.
prereq: provider-drone-reachable-by-phone, cadre-invitations-redeemable-by-any-member
architecture: docs/architecture.md#enrollment-flow-phone-adds-provider-drone
files: packages/cadre-provider/src/types.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/create-request-validation.ts, packages/cadre-provider/src/server/invitation-validation.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/service/node-code.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/README.md, packages/integration-tests/src/harness/provider-process-orchestrator.ts, docs/architecture.md
difficulty: hard
----

# A provider container joins by claim or by invitation

First of the `provider-client-and-sign-up` chain: this ticket, then `provider-join-scenarios-phone-shaped-requester`, `provider-oauth-reference-endpoints`, `provider-subscription-state-and-lapse`, `cadre-core-provider-client-and-rent-node`, `reference-app-rn-rents-a-provider-node`, `provider-retires-the-seed-path`.

## Decision: the claim model is adopted

gotchoices/sereus#40 asked whether a provider container should start waiting to be claimed, as a cadre-host node does, instead of being given the owner's key at create and a seed afterwards. Yes:

- One way to add a node in every app and in cadre-core (`CadreNode.claimNode`, `CadreNode.redeemCadreInvitation`), whoever runs the node.
- The provider never sees an owner key or a seed, which is the direction `tickets/backlog/feat-owner-keys-only-on-user-devices.md` sets for every server.
- It composes with the invitation path: a cadre whose only member is the phone claims the container; a cadre with a reachable always-on member hands the container an invitation and the container joins by itself, so the phone can close as soon as the create returns.

Nothing in billing or abuse control needs the owner before the container starts: the provider's customer is the authenticated API caller, not the cadre owner. The seed path (`pinnedOwnerKeys`, `PUT /containers/:id/seed`) therefore has no remaining purpose and is retired by `provider-retires-the-seed-path`, the last ticket of the chain, once the two new paths are proven on the wire. This ticket leaves the seed path untouched so the existing scenarios keep passing until then.

## What exists

- `POST /containers` validates one body (`create-request-validation.ts`) into `CreateContainerRequest`; `ContainerService.createContainer` writes the record and provisions asynchronously; `DockerOrchestrator.createContainer` mints the seed token and builds the env with `buildNodeEnv` (`container-env.ts`); `ContainerService.enrollIfHealthy` promotes to `running` on the first healthy `/status` read and records `peerId`.
- cadre-cli reads `CADRE_CLAIM_SECRET` and `CADRE_INVITATION` straight from the environment (`COMMAND_ENV` in `packages/cadre-cli/src/config/env.ts`); the Docker entrypoint needs no change. With a claim secret, `cadre start` refuses `CADRE_OWNER_KEYS`, `--owner`, `--seed` and an invitation (`refuseClaimConflicts` in `start.ts`); the config's party is a placeholder, and the node restarts in-process into the claimed party. With an invitation it refuses `--owner` and `--seed`, and needs an identity file, which the entrypoint exports as `CADRE_KEY_FILE`.
- `/status` reports `node.claim` (`awaiting` | `claimed` | `none`), `node.claimedBy`, `node.partyId` (the claimed party after the restart), and `node.invitation` (`pending` | `accepted` with `memberPeerId` | `failed` with `error`, `retryable`): `HealthStatus` in `packages/cadre-cli/src/server/health.ts`. cadre-host polls these (`docs/cadre-host.md` → Join a cadre).
- cadre-host builds the node code from the claim secret and the node's addresses (`packages/cadre-host/src/hosted/claim-details.ts`); the format is cadre-core's `encodeNodeClaimPayload` (`node-claim-payload.ts`): `sereus-join:1.` followed by base64url of the JSON object `{ multiaddrs, peerId, secret }`, every address ending in `/p2p/<peerId>`.

## Request shape

`POST /containers` gains `join`:

```
{ "join": { "kind": "claim" } }
{ "join": { "kind": "invitation", "invitation": "sereus-invite:1.…" } }
```

plus the existing `profile`, `resources`, `strandFilter`, `tags`. The validator (`create-request-validation.ts`) rules:

- `join` absent: the seed path exactly as today.
- `join.kind: 'claim'`: `partyId`, `bootstrapNodes` (non-empty) and `pinnedOwnerKeys` must be absent, each refused by name with "a container that is claimed takes its party and owner from the claim". Requires `docker.publicHost` (the `bootstrapNodesOptional` flag the route already has): without it 400 names `docker.publicHost`, since only a dialable container can be claimed. The request's `partyId` is the placeholder `UNCLAIMED_PARTY_ID = 'unclaimed'` (the same placeholder cadre-host and the cadre-cli README use).
- `join.kind: 'invitation'`: `invitation` is a string checked by a new `invitation-validation.ts`: prefix `sereus-invite:1.`, base64url JSON, an object with `v: 1`, non-empty `partyId`, `invitePrivateKey` string, `invite` object, `ownerKeys` non-empty string array, `members` non-empty array of strings that each parse as a multiaddr whose last `/p2p/` names a peer id. This is a copy of cadre-core's `isWellFormedCadreInvitation` rule, for the reason `owner-key-validation.ts` gives for copying the owner-key rule: the provider does not depend on cadre-core, and the node does the full decode and refuses anything a member would. A `sereus-join-request:` prefix is refused as "a join request, not an invitation". `partyId` is taken from the bundle; a body `partyId` that disagrees is refused. `bootstrapNodes` and `pinnedOwnerKeys` must be absent (the bundle names the members to dial and carries the owner keys the node pins itself). `docker.publicHost` is not required.
- Error messages never echo the bundle (it carries the invitation's private key).

## Types

```ts
export const UNCLAIMED_PARTY_ID = 'unclaimed';

/** How a container gets into a cadre; the credential half is redacted on the wire. */
export type ContainerJoin =
  | { kind: 'claim'; secret: string }          // CADRE_CLAIM_SECRET, minted by ContainerService
  | { kind: 'invitation'; invitation: string }; // CADRE_INVITATION, the bundle as submitted

/** The join as the node last reported it on /status; absent on a seed-path container and before the first read. */
export type ContainerJoinState =
  | { kind: 'claim'; state: 'awaiting' }
  | { kind: 'claim'; state: 'claimed'; ownerKey: string; partyId: string }
  | { kind: 'invitation'; state: 'pending' }
  | { kind: 'invitation'; state: 'accepted'; memberPeerId?: string }
  | { kind: 'invitation'; state: 'failed'; error: string; retryable: boolean };
```

`CreateContainerRequest.join?: { kind: 'claim' } | { kind: 'invitation'; invitation: string }`; `Container.join?: ContainerJoin`; `Container.joinState?: ContainerJoinState`; `OrchestratorCreateRequest.join?: ContainerJoin`. `redactContainer` in `routes.ts` maps `join` to `{ kind }` beside dropping `seedToken`.

`ContainerHealthStatus.node` gains `partyId?`, `claim?: 'awaiting' | 'claimed' | 'none'`, `claimedBy?`, `invitation?: { state: 'pending' | 'accepted' | 'failed'; memberPeerId?; error?; retryable? }`, typed locally as the file's header explains.

## Service

- `createContainer` mints the claim secret for `join.kind: 'claim'` (32 random bytes, base64url, which is exactly what cadre-core's `parseClaimSecret` accepts) and stores `join` on the record. One minting site, in the service, so both orchestrators only inject what they are handed; the seed token stays minted in the orchestrators until `provider-retires-the-seed-path` removes it.
- `buildNodeEnv` emits `CADRE_CLAIM_SECRET=<secret>` or `CADRE_INVITATION=<bundle>` from `request.join`, and throws if `pinnedOwnerKeys` is non-empty beside a join (cadre-cli would refuse the start; failing here names the cause). `CADRE_PARTY_ID` is the request's party (the placeholder for a claim, the bundle's for an invitation). `CADRE_SEED_TOKEN` is unchanged in this ticket.
- `readStatus(container)`: the one place the service reads a container's `/status`. It calls `fetchContainerHealthStatus` and then folds the join state into the record (`foldJoinState`): `claim: 'claimed'` writes `joinState`, `partyId` (from `node.partyId`) and `ownerKey` from `claimedBy`; an `invitation` block writes its state, member, error and retryable flag. The record is saved only when the folded state differs from the stored one. `getContainerStatus`, `enrollIfHealthy`, `getPeerInfo` and the billing collector's read go through it, so every read the provider makes keeps the record current and `GET /containers` (the list) carries the party and join state without a live read per row. There is no separate poller: the app polls `GET /containers/:id`, which always reads live.
- `nodeCode(id)`: the claim payload for a claim-mode container, or a typed refusal: `not-claimable` (seed or invitation container), `already-claimed` (after a live read says so), `gone` (`stopped`, `error`), `not-ready` (no `/status`, no peer id, or no announced WebSocket address yet). The addresses are the live `/status.multiaddrs` entries that carry `/ws` or `/wss` and whose host component is `hostComponent(publicHost)`, each given `/p2p/<peerId>` when it lacks one; `ContainerServiceOptions` gains `publicHost?` (the server passes `config.docker.publicHost`; the integration harness passes the one it announces). TCP and in-container addresses are left out, since a phone can dial neither; this mirrors `selectNodeClaimAddresses` for the only address class a provider has. The code is built by a local `node-code.ts` (`sereus-join:1.` + base64url of `JSON.stringify({ multiaddrs, peerId, secret })`, keys in that order, which is what cadre-core's canonical JSON emits), with a NOTE that it mirrors `encodeNodeClaimPayload` because the provider does not depend on cadre-core, and that `decodeNodeClaimPayload` on the phone is the contract.
- An unclaimed container is never reaped: the customer is billed for it and deletes it. NOTE tripwire at the sweep: if abandoned unclaimed containers ever pile up, stop them after a TTL and record why on the record.

## Route

`GET /containers/:id/code` (scope `containers:read`, ownership check as the other per-container routes): 200 `{ code, peerId, multiaddrs }`; 404; 409 `NOT_CLAIMABLE`, `ALREADY_CLAIMED`, `CONTAINER_GONE`; 503 `NOT_AVAILABLE` while the node has no address yet (clients poll, as cadre-host's claim route is polled). The route logs the container id only; the code and the secret never appear in a log line or in any other response. The secret is returned to the authenticated owner of the container, over whatever TLS the deployment puts in front of the API; the README says so.

## Docs

- `packages/cadre-provider/README.md`: the API table (`join`, `/code`), a section "Joining a cadre: claim or invitation" beside "Seed trust", the redaction paragraph, and the security sentence above.
- `docs/architecture.md` → "Enrollment Flow: Phone Adds Provider Drone": the claim flow as the primary diagram (create → poll `/code` → `claimNode` → the node restarts into the cadre → the phone dials in) and the invitation flow as a second short sequence; the seed sequence stays, marked as the path `provider-retires-the-seed-path` removes. "Provider Flow" under Provider Integration gets the same treatment, and row 4 of "Which Side Dials" names the three ways in. Keep each bullet to one claim; the section's existing bullets about the cold-start admission window still hold for an unclaimed container (it admits any connection until claimed, as a cadre-host node does).

## Edge cases & interactions

- A claim-mode container that restarts (Docker `unless-stopped`) replays the same env: cadre-cli starts from `claim.json` and, with the secret still set, answers a rival claimant `already-claimed`. Verified by reading `start.ts`; the scenario ticket pins the restart.
- The record's `partyId` is `unclaimed` until a read folds the claim. `ensureVolume` uses the party only as a label. `GET /containers` filtered by party therefore misses unclaimed containers; the app finds them by customer and `joinState`. By inspection.
- `enrollIfHealthy` reads `/status` once per poll; folding there means the record carries `joinState: awaiting` as soon as it is `running`. Assert in the fold test.
- A provider restart loses nothing: the secret and the bundle are on the record (`FileStore` persists them as it persists the seed token). The reap sweep's enrolling path goes through `readStatus` too.
- The invitation bundle is a bearer credential for one join: it is in the record and in the container's env, as cadre-host keeps it in `hosted-nodes.json` and the child env, and nowhere the provider sends. `docker inspect` on the host shows both secrets, as it shows the seed token today; the README's deployment section says so.
- An invitation spent or expired before the node redeems it: `/status.node.invitation` reports `failed` with `invite-spent` in the error and `retryable: false`; the fold records it; the container keeps running with nothing to do. The app's remedy (`cadre-core-provider-client-and-rent-node`) is to delete the container and rent again, so no retry route is added here; NOTE at the fold site.
- A body with `join` and a non-empty `bootstrapNodes` is refused rather than merged: the invitation names the members to dial, and a claimed node has nobody to dial before the claim. Validator table test.
- `docker.publicHost` unset and `join.kind: 'invitation'`: allowed. The container dials out and holds its connections; a phone cannot dial it directly later, which the README states beside the existing publicHost section.
- Concurrency: two devices of one customer reading the code and claiming at once: the node accepts one owner and refuses the other `already-claimed`; the same owner twice is idempotent (`claimNode`'s contract). By inspection of cadre-core; nothing to add here.
- `MockOrchestrator` and `ProviderProcessOrchestrator` accept `join` in the request; the harness passes it through `buildNodeEnv` unchanged (`provider-process-orchestrator.ts` already calls it) and gains nothing else; its claim-mode child needs no admin channel change.

## Tests

- `create-request-validation.test.ts` (extend): claim without publicHost; claim with `partyId`, `bootstrapNodes` or `pinnedOwnerKeys`; invitation malformed, with a join-request prefix, with a disagreeing `partyId`; a valid claim yields `partyId: 'unclaimed'`; a valid invitation yields the bundle's party. Expected outputs: the error names the field; the request objects as above.
- `container-env.test.ts` (extend): claim emits `CADRE_CLAIM_SECRET` and `CADRE_PARTY_ID=unclaimed` and no `CADRE_OWNER_KEYS`; invitation emits `CADRE_INVITATION`; pins beside a join throw.
- `container-get-status.test.ts` (extend): a `/status` with `claim: 'claimed'` patches `partyId`, `ownerKey` and `joinState`; one with `invitation.state: 'failed'` records `error` and `retryable`.
- A `nodeCode` test: `not-ready` before peer info; the code decodes (locally in the test) to the record's secret and only the announced `/ws` address with `/p2p/`; `already-claimed` after a claimed read.
- `container-token-redaction.test.ts` (extend): neither the secret nor the bundle appears in `POST`, `GET` or list responses.

## TODO

- Types and validator (`join`, `invitation-validation.ts`, placeholder party, publicHost rule).
- `ContainerService`: mint the secret, store `join`, `readStatus` with the fold, `nodeCode`, `publicHost` option.
- `buildNodeEnv` join env and the pins guard; `OrchestratorCreateRequest.join`; Docker and mock orchestrators pass it through; `ContainerHealthStatus` fields.
- `GET /containers/:id/code` route and redaction; export the new types and `UNCLAIMED_PARTY_ID` from `index.ts`.
- Integration harness: `ProviderProcessOrchestrator` accepts `join` and the service `publicHost` option (no scenario in this ticket).
- README and architecture doc sections above.
- `yarn workspace @serfab/cadre-provider typecheck`, `test`, `yarn lint`; rebuild `@serfab/cadre-provider` so the integration suite's stale-build guard sees the change.
