<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-16T16:55:13.096Z (agent: claude)
  Log file: C:\projects\sereus\tickets\.logs\2-donation-service.implement.2026-07-16T16-55-13-096Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
----
description: Make cadre-host actually donate a node — a friend's phone asks the host over a small API, the host spawns a node that joins the phone's own cadre, and the host presents the phone-signed seed to that node without ever holding the phone's authority key.
prereq: donation-grant-tokens
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-store.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/types.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-host/src/bin/host.ts
difficulty: hard
----

# Donation service — the node-donor grant lifecycle

## Context

This is the core of the realignment. cadre-provider already implements the exact
donate-a-node flow for Docker; cadre-host's `HostProcessOrchestrator` already
implements provider's `Orchestrator` interface and its `createContainer` already
spawns a generic node with a **caller-supplied** `partyId` + `bootstrapNodes` and
returns `seedEndpoint` + `seedToken`. What's missing is the **service + HTTP surface**
that drives that machinery on behalf of an external requester — today
`server/routes/nodes.ts` returns `501 not_implemented` for generic node spawn and
there is no request/grant API.

Read `packages/cadre-provider/src/server/routes.ts` and
`packages/cadre-provider/src/service/container-service.ts` first — this ticket is a
faithful cadre-host analogue of both, minus Docker/billing, plus the grant-token
gate from `1-donation-grant-tokens`.

### The donate-a-node flow (end to end)

The requester is an external cadre **authority** (a phone) that already owns a cadre
and holds its own authority (owner) keypair. The host contributes capacity only.

```
phone (authority)                         cadre-host (donor)                donated node (child proc)
─────────────────                         ──────────────────                ─────────────────────────
1. POST /grants                ─────────▶ validate grant (bearer)
   { partyId, bootstrapNodes,             quota check + serialize
     ownerKeys, profile? }                orchestrator.createContainer(...)  ── spawn: pin ownerKeys,
                               ◀─────────  { grantId } (seedToken stays here)    join partyId via bootstrap
2. GET /grants/:id/peer        ─────────▶ node /status → peerId+multiaddrs
                               ◀─────────  { peerId, multiaddrs }
3. phone: addDrone({ dronePeerId, droneMultiaddrs })  → { encodedSeed }   (signs w/ phone's authority key)
4. PUT /grants/:id/seed        ─────────▶ present seedToken to node POST /seed
   { seed: encodedSeed }                  node.applySeed (trust: pinned ownerKeys)
                               ◀─────────  { peersAdded }                    ── node dials phone's cadre,
                                                                                syncs into requester's cadre
5. DELETE /grants/:id          ─────────▶ orchestrator stop+remove
```

The host **never** receives the phone's authority private key. The seed is signed on
the phone (step 3) and only its signed, public form transits the host (step 4). The
`seedToken` (host↔node bearer that gates the node's `POST /seed`) is minted host-side
and **never** returned to the requester — exactly as provider redacts it
(`redactContainer`).

## The load-bearing new wiring: pin the requester's owner key

**This is the piece with no existing analogue in cadre-host's spawn path and the one
most likely to be missed.** A freshly-spawned cold node defaults to
`dbAnchoredTrustPolicy()` (see `packages/cadre-core/src/seed-bootstrap.ts:183`), which
**rejects** any seed because the node's control DB has no owner keys yet. For the node
to accept the phone-signed seed in step 4, it must be started with the requester's
owner public key(s) pinned as cold-start trust anchors — via `--pin-owner-key <b64url>`
(repeatable) or `CADRE_OWNER_KEYS` (comma-separated), which `cadre-cli start` turns
into `pinnedKeyTrustPolicy(...)` (`packages/cadre-cli/src/commands/start.ts:132`).

Today `HostProcessOrchestrator.createContainer` / `buildChildConfig`
(`host-process-orchestrator.ts:220,660`) pass **no** pinned keys. So the request must
carry the requester's owner public key(s), and the orchestrator must thread them into
the child. Extend:

- `OrchestratorCreateRequest` (`packages/cadre-provider/src/service/orchestrator.ts`)
  → add optional `pinnedOwnerKeys?: string[]`.
- `HostProcessOrchestrator.createContainer` → set
  `env.CADRE_OWNER_KEYS = request.pinnedOwnerKeys.join(',')` when present (env is the
  cleaner path than a CLI arg since spawn already builds `env`; `cadre-cli start`
  already unions `CADRE_OWNER_KEYS`).

(cadre-provider's own Docker orchestrator can ignore the new field for now — its
requesters pin via its own mechanism; note it, don't wire it there.)

Without this the integration test in `4-donor-docs-and-integration` fails at step 4
with a seed-rejected error — treat "node accepts the phone's seed" as the acceptance
gate for this ticket.

## Design

### Types (`donation/types.ts`, extending `1-donation-grant-tokens`)

```ts
export type DonationStatus =
  | 'provisioning' | 'awaiting_seed' | 'seeded' | 'error' | 'terminated';

/** One donated node, tracked host-side. Persisted. */
export interface Donation {
  id: string;                 // "grn_<nanoid>"
  grantToken: string;         // which grant authorized it (quota key)
  partyId: string;            // the REQUESTER's cadre
  profile: 'storage' | 'transaction';
  status: DonationStatus;
  dockerId?: string;          // orchestrator handle
  peerId?: string;
  seedEndpoint?: string;      // node POST /seed URL (loopback)
  seedToken?: string;         // host↔node bearer — NEVER leaves the host
  createdAt: string;
  updatedAt: string;
  error?: string;
}

/** Redacted wire shape (seedToken + seedEndpoint stripped). */
export type DonationView = Omit<Donation, 'seedToken' | 'seedEndpoint'>;
```

### Store (`donation/donation-store.ts`)

Atomic JSON `<dataDir>/donations.json`, modeled on the provider store + the
grant store from the prior ticket. **Must persist `seedToken`** — this is the
crash-recovery fix from `tickets/complete/cadre-provider-seed-endpoint-never-populated.md`:
the orchestrator mints a fresh `seedToken` per spawn and does **not** persist it on the
handle (`host-process-orchestrator.ts` `toPersisted` omits it), so if the host restarts
in the request→seed gap, only the donation record can reproduce the token needed to
present the seed. `liveNodeCount(grantToken)` = count of donations with that token in a
non-terminal, non-`terminated` status — this is the authoritative tally the grant
validator consumes.

### Service (`donation/donation-service.ts`)

Analogue of `ContainerService`. Constructed with `{ orchestrator, grants: GrantValidator, store }`.

- `provision({ grantToken, partyId, bootstrapNodes, ownerKeys, profile? })` →
  `Donation`. Serialize per-grant (see race edge case) → `grants.validateForProvision`
  → create record (`provisioning`) → `orchestrator.createContainer({ containerId: id,
  partyId, bootstrapNodes, profile, pinnedOwnerKeys: ownerKeys })` → persist dockerId +
  seedEndpoint + **seedToken** + peer info-pending → status `awaiting_seed`. On any
  failure reclaim the orchestrator resources (`removeContainer`) exactly like
  `ContainerService.provisionContainer`'s `safeReclaim`.
- `getPeer(id)` → live `{ peerId, multiaddrs }` from the node `/status` (reuse the
  provider `getPeerInfo` freshness model — read live every call, no cache).
- `applySeed(id, encodedSeed)` → present the persisted `seedToken` to the node's
  `POST /seed` (copy `ContainerService.applySeed` verbatim in spirit); on success set
  status `seeded`.
- `terminate(id)` → `orchestrator.stopContainer` + `removeContainer`; status
  `terminated` (kept in the store for audit, excluded from `liveNodeCount`).
- `list(grantToken?)`, `get(id)` → `DonationView`(s).

### Grantee-facing routes (`server/routes/grants.ts`)

Mirror provider's container routes, bearer = grant token (via
`1-donation-grant-tokens`'s validator), envelope `{ ok, data }` / `{ ok:false, error }`:

| Method & path | Purpose | Auth |
|---|---|---|
| `POST /grants` | provision — `{ partyId, bootstrapNodes, ownerKeys, profile? }` | grant bearer + quota |
| `GET /grants` | list this grant's donations | grant bearer |
| `GET /grants/:id` | one donation (redacted) | grant bearer + ownership |
| `GET /grants/:id/peer` | `{ peerId, multiaddrs }` for the requester's `addDrone` | grant bearer + ownership |
| `PUT /grants/:id/seed` | apply the phone-signed seed — `{ seed }` | grant bearer + ownership |
| `DELETE /grants/:id` | terminate | grant bearer + ownership |

"Ownership" = the donation's `grantToken` equals the presented bearer (a grantee sees
only its own donations — the single cross-grantee boundary, analogous to provider's
per-customer check).

**Reachability is out of scope here (deferred).** In v1 the grant surface mounts on
the **loopback** management server, same as the trust-circle/NAT surfaces and the
provider API in its own tests — fully exercisable same-machine (the integration test
and provider's tests both hit it over loopback). Physically exposing it to a remote
phone (NAT-mapped port vs a libp2p broker) is
`backlog/feat-cadre-host-wan-grant-reachability`. Do **not** bind 0.0.0.0 here.

Replace `server/routes/nodes.ts`'s generic-spawn `501` path: generic node lifecycle is
now owned by the donation surface. Leave the owner-node start/restart path
(`3-demote-host-founder` reframes it); the `501` for *arbitrary* saved-config respawn can
stay or point at `/grants`.

### Wiring (`bin/host.ts start`)

Construct `GrantService` + `DonationService` (both need `dataDir` + the already-built
`orchestrator`) and mount `grants.ts` + `grants-admin.ts` on the same Fastify instance.
No owner node is required for the donor path — but this ticket lands *alongside* the
still-present owner-node spawn; `3-demote-host-founder` makes the owner node optional.

## Edge cases & interactions

- **Cold-node seed rejection (the #1 gotcha)**: without pinned owner keys the node
  rejects the seed. Covered by the pin-key wiring above; assert the node accepts the
  seed in the downstream integration test.
- **Requester vanishes after provision, before seed** → orphaned `awaiting_seed` node
  holding host ports. Add a reap policy: a donation stuck in `awaiting_seed` past a TTL
  (config, default e.g. 30 min) is auto-terminated on a periodic sweep (and on
  `start`/`init` for records recovered from disk). Log the reap.
- **Grant replay / double-redemption / quota race**: two concurrent `POST /grants`
  under the same grant at count = maxNodes-1 must not both pass. Serialize provision
  per-grant-token (in-memory async lock / in-flight set keyed by token, like
  `TrustCircleService.inFlightRedemptions`) so the quota check and record-create are
  atomic. Test with two concurrent provisions at the boundary.
- **Host restart mid-lifecycle (request→seed gap)**: `orchestrator.init()` re-attaches
  the surviving child; the donation record must reproduce `seedToken` (persisted) so a
  later `PUT /grants/:id/seed` still works. Test: persist a donation, drop the service,
  reconstruct from disk, apply seed successfully.
- **One host serving multiple distinct cadres concurrently**: port allocation +
  per-party workdirs already key by `containerId` (= donation id, unique) — confirm no
  `partyId`-uniqueness assumption sneaks in (two donations with different `partyId` must
  coexist). The orchestrator already supports this; add a test provisioning two
  donations for two different `partyId`s.
- **Push-credential fan-out for foreign parties (source plan #7)**: donated nodes belong
  to *foreign* cadres, not the host's. Decision: **donated nodes get NO push block** —
  the host's FCM/APNs credentials are minted for the host owner's own app/bundle and are
  meaningless to a foreign cadre's app. `createContainer`'s push resolution is gated on
  `profile === 'storage'`; for donations, pass push through **only** if a future ticket
  adds per-grantee push creds (it won't in v1). Ensure the donor path does **not**
  inject the host's push creds into foreign-party nodes. Note this at the call site.
- **Seed applied twice / to a `terminated` node**: `applySeed` on a non-live donation →
  clean error, not a spawn or a 500. Match provider's status guard
  (`ContainerService.applySeed` rejects when not running/enrolling).
- **profile default**: absent `profile` → `storage` (so the node participates and can be
  dialed), matching provider.

## TODO

### Phase 1 — orchestrator pin-key wiring
- [ ] `OrchestratorCreateRequest` (`cadre-provider/src/service/orchestrator.ts`): add
  `pinnedOwnerKeys?: string[]`.
- [ ] `HostProcessOrchestrator.createContainer`: thread `pinnedOwnerKeys` →
  `env.CADRE_OWNER_KEYS`. Unit test: spawned child config/env carries the keys.

### Phase 2 — service + store
- [ ] `donation/types.ts` (extend), `donation/donation-store.ts` (persist `seedToken`),
  `donation/donation-service.ts`. Unit tests: provision→awaiting_seed, seedToken
  persistence across store reconstruct, quota race serialization, reap of stale
  `awaiting_seed`, reclaim-on-failure, foreign-party no-push.

### Phase 3 — routes + wiring
- [ ] `server/routes/grants.ts` (grantee-facing, bearer + ownership). Remove the
  generic-spawn `501` from `nodes.ts`.
- [ ] `bin/host.ts start`: construct + mount `GrantService`/`DonationService`; start the
  reap sweep; reap-on-init recovered orphans.
- [ ] `yarn workspace @serfab/cadre-host build` + `test`; `yarn workspace @serfab/cadre-provider build`; `yarn lint` green.
