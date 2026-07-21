----
description: The self-hosted manager can now donate a compute node to a friend's cadre — the friend's phone asks over a small bearer-authenticated API, the manager spawns a node into the friend's cadre and presents the phone-signed seed to it, never holding the friend's authority key.
prereq: donation-grant-tokens
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-store.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/server/error-handler.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts, packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts
difficulty: hard
----

# Review: donation service — the node-donor grant lifecycle

## What shipped

cadre-host can now donate a node on behalf of an external cadre authority (a
friend's phone). The phone holds its own owner keypair; the host contributes
capacity only and **never** receives the phone's authority private key. Full
flow (all over the **loopback** management server in v1 — WAN reachability is
deferred, see below):

```
phone (authority)                cadre-host (donor)              donated node (child proc)
1. POST /grants          ──▶ validate grant bearer + quota, serialize per grant,
   {partyId,bootstrapNodes,      orchestrator.createContainer(... pinnedOwnerKeys)  ── spawn: pin ownerKeys,
    ownerKeys, profile?}   ◀──  201 { donation } (seedToken stays host-side)          join partyId via bootstrap
2. GET /grants/:id/peer  ──▶ node /status → { peerId, multiaddrs }
3. phone addDrone(...)       → encodedSeed (signed with the phone's authority key)
4. PUT /grants/:id/seed  ──▶ present host↔node seedToken to node POST /seed
   { seed: encodedSeed }   ◀──  { peersAdded } (node trusts the pinned ownerKeys)     ── syncs into phone's cadre
5. DELETE /grants/:id    ──▶ orchestrator stop + remove
```

This was a **resume**: an earlier interrupted run's Phase-1/2 work plus this
run's Phase-3 (routes + wiring + reap) and all unit tests were committed by the
runner along with the resume note (commit `ecb42a8`). This run rebuilt every
dependent package, re-ran the suites, added nothing new to the code — it
**verified** the committed slice compiles, lints, and passes end-to-end, and
determined the prior run's reported test failures were entirely environmental
(cadre-cli was not built + vitest fork-worker starvation), not code defects.

### The load-bearing wiring: pinned owner key (the #1 gotcha)

A freshly-spawned cold node defaults to a db-anchored trust policy that
**rejects every seed** (its control DB has no owner keys yet). For the donated
node to accept the phone-signed seed in step 4, it is started with the
requester's owner public key(s) pinned as cold-start trust anchors:

- `OrchestratorCreateRequest.pinnedOwnerKeys?: string[]`
  (`packages/cadre-provider/src/service/orchestrator.ts`).
- `HostProcessOrchestrator.createContainer` threads them into the child as
  comma-separated `env.CADRE_OWNER_KEYS`, which `cadre-cli start` unions into a
  cold-start pinned-key trust policy
  (`host-process-orchestrator.ts:220`).

"Node accepts the phone's seed" is the acceptance gate — **proven green** by the
integration scenario (see Validation).

## Key files

- `donation/donation-service.ts` — `DonationService`: `provision` / `getPeer` /
  `applySeed` / `terminate` / `get` / `list` / `reapStaleAwaitingSeed`. Per-grant
  provision serialization (quota-race), reclaim-on-failure, seedToken persisted +
  redacted, foreign-party no-push.
- `donation/donation-store.ts` — atomic `donations.json`; **persists seedToken**
  (crash-recovery for the request→seed gap); `liveNodeCount(grantToken)` = the
  quota tally the grant validator consumes.
- `donation/types.ts` — `Donation`, `DonationView` (strips `seedToken` +
  `seedEndpoint`), `DonationStatus`, `DonationError`/`DonationErrorCode`.
- `server/routes/grants.ts` — grantee-facing bearer-gated surface (below).
- `server/error-handler.ts` — `DonationError` → HTTP status map.
- `server/index.ts` — mounts `/grants` when both `grants` + `donations` present.
- `server/routes/nodes.ts` — generic-spawn `501` reworded to point at `/grants`
  (generic node lifecycle now owned by the donation surface); owner-node
  start/restart path unchanged.
- `bin/host.ts start` — constructs `DonationService`, mounts it, runs the reap
  sweep (once at startup + `setInterval`, `unref`'d, `clearInterval` on shutdown).

### Grantee-facing HTTP surface (`/grants`, loopback, bearer-gated)

| Method & path | Purpose | Auth |
|---|---|---|
| `POST /grants` | provision → `201 { donation }` | bearer + quota (validated inside `provision`) |
| `GET /grants` | list this grant's donations | bearer |
| `GET /grants/:id` | one donation (redacted) | bearer + ownership |
| `GET /grants/:id/peer` | `{ peerId, multiaddrs }` for `addDrone` | bearer + ownership |
| `PUT /grants/:id/seed` | apply phone-signed seed → `{ peersAdded }` | bearer + ownership |
| `DELETE /grants/:id` | terminate | bearer + ownership |

Ownership = donation's `grantToken` equals the presented bearer. An unknown id
and one owned by a *different* grant are deliberately indistinguishable (both
404) — a grantee never learns another grantee's donations exist.

## Validation (what was actually run — green)

- `yarn workspace @serfab/cadre-provider build` ✓
- `yarn workspace @serfab/cadre-cli build` ✓ (required — orchestrator + CLI-smoke
  suites spawn a real `cadre` bin; without its `dist/bin/cadre.js` they time out)
- `yarn workspace @serfab/cadre-host build` ✓
- `yarn workspace @serfab/cadre-host test` → **54 files, 447 passed / 3 skipped / 0 failed** ✓
- `yarn lint` (whole repo, `eslint .`) ✓
- `packages/integration-tests` `cadre-host-node-donation.integration.ts` →
  **5/5** with two real cadre-cli children — **the acceptance gate**: step 4–5
  `peersAdded ≥ 1` (donated node accepts the phone-signed seed), step 6 the node
  is a live control peer in party `P`, step 7 terminate releases it.

### New unit tests (treat as a floor, not a ceiling)

- `donation/__tests__/donation-service.test.ts` (8 cases, fake orchestrator):
  provision→awaiting_seed (pinned keys threaded, seedToken persisted+redacted),
  explicit transaction profile, unknown-grant denial before spawn, **seedToken
  reproduced from a store rebuilt off disk** (host-restart gap), **per-grant
  quota-race serialization** (two concurrent provisions at the boundary can't
  both pass), reclaim-on-post-spawn-failure vs no-reclaim-when-spawn-throws,
  reap of stale `awaiting_seed` past TTL leaving fresh ones alone.
- `server/__tests__/grants-route.test.ts` (10 cases): 201 + redaction, missing/
  unknown bearer → 401, body validation → 400, quota → 429, ownership isolation
  (foreign grant → 404), seed-body validation, terminate drops from live tally.
- `__tests__/orchestrator-pin-keys.test.ts` (3 cases, fake CLI records its env):
  `CADRE_OWNER_KEYS` threaded/omitted, foreign-party push suppression on a
  storage-profile node.

## Known gaps — reviewer, look here

- **`getPeer` / `applySeed` happy paths are NOT unit-tested.** Both do a real
  `fetch` to a live node, so their success paths are covered only by the
  cross-package integration scenario (green, above). The route/unit tests cover
  their *guard/validation* branches, not a live round-trip. If you want a unit
  seam, a fetch-mock harness would let the seeded/`peersAdded` success path be
  asserted without a real child.
- **The `bin/host.ts` reap timer wiring is not unit-tested** (no start-command
  smoke test for it). The reap *logic* (`reapStaleAwaitingSeed`) is unit-tested
  directly; the `setInterval`/`unref`/`clearInterval`-on-shutdown plumbing is
  verified only by reading. Low risk, but uncovered.
- **Provider's Docker orchestrator ignores `pinnedOwnerKeys`** by design — its
  requesters pin via their own mechanism. Intentional; noted at the type. Not a
  bug, but confirm the field is genuinely inert on that path.
- **WAN reachability is out of scope** — `/grants` binds loopback only, same as
  the trust-circle/NAT surfaces. Exposing it to a remote phone (NAT-mapped port
  vs libp2p broker) is `backlog/feat-cadre-host-wan-grant-reachability`. A green
  donation test says nothing about a remote phone reaching the host.
- **Reap TTL / sweep interval are module constants** (30 min / 5 min), not
  operator-configurable. Fine for now; promote to `host.config.json` if hosts
  need to tune. (Already tagged `NOTE:` at the constant in `donation-service.ts`.)

## Tripwires already parked in code (not tickets — index only)

- `donation-service.ts` — `provisionTail` map has one entry per distinct grant
  token, never evicted (`NOTE:` at the field). Fine at household scale; evict on
  resolve if grant counts grow large.
- `donation-store.ts` — rewrites the whole `donations.json` on every mutation
  (`NOTE:` at `save()`). Fine at a handful of donated nodes; switch to an
  append/compact log if counts grow large.

## Environmental note (no ticket — for context)

The prior run reported ~16 test failures and started to file a pre-existing
error. Those were **not** code defects: (a) `cadre-cli` was not built, so every
real-node spawn timed out, and (b) running the full heavy suite in parallel
starved vitest's fork workers ("Timeout waiting for worker to respond"). With
cadre-cli built and the machine quiet, the orchestrator suite and the full
cadre-host suite are green (above). No `.pre-existing-error.md` was written and
nothing was skipped/disabled. If CI runs these suites, ensure cadre-cli is built
first and heavy real-node suites aren't over-parallelized on a small runner.
