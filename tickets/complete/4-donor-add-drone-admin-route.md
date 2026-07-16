description: A node can now mint, over a small local HTTP call, the join-credential ("seed") that authorizes another node to join its cadre — the piece a friend's phone needs on its side of the donate-a-node flow.
prereq:
files: packages/cadre-cli/src/server/admin-server.ts, packages/cadre-cli/test/admin-server.spec.ts, packages/cadre-host/src/owner/owner-node-client.ts, packages/cadre-host/src/owner/__tests__/owner-node-client.test.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts, docs/cadre-host.md
difficulty: easy
----

# Complete: `add-drone` admin route + client helper

Carve-out from `4-donor-node-donation-integration`. Adds `POST /admin/add-drone`
to the cadre-cli loopback admin channel and the matching
`OwnerNodeClient.addDrone` on the cadre-host side, so a requester ("phone") node
can mint the seed that authorizes a donated node to join its cadre.

## What shipped (implement commit af41d5b)

- **`admin-server.ts`** — `POST /admin/add-drone`: body
  `{ dronePeerId: string, droneMultiaddrs: string[] }` → `node.addDrone(...)` →
  `{ seed, encodedSeed }`. Validates both fields (→ `400 bad_request`);
  seed-bootstrap-not-initialized classifies to `503 not_ready`.
- **`owner-node-client.ts`** — `addDrone({ dronePeerId, droneMultiaddrs })` →
  `Promise<DroneInitResult>`, thin loopback POST, standard envelope unwrap.
- **`cadre-host-owner-node.integration.ts`** — header note marking it the opt-in
  own-cadre (founder) scenario.

## Review findings

### Checked
- **Route logic / ordering** — `add-drone` resource distinct from siblings; no
  collision. Handler reads JSON, validates, delegates, returns envelope. ✓
- **Validation** — non-empty `dronePeerId`, string-array `droneMultiaddrs`; both
  → `bad_request`. Stricter than sibling `accept-phone`. Empty `droneMultiaddrs`
  array is allowed, consistent with `AddDroneOptions` (no non-empty contract). ✓
- **Type alignment** — route args match `AddDroneOptions`
  (`packages/cadre-core/src/types.ts:976`); return matches `DroneInitResult`
  (`types.ts:996`). `node.addDrone` exists (`cadre-node.ts:2778`). Build clean, so
  narrowing/casts sound. ✓
- **Error classification** — real node throws `"Seed bootstrap service not
  initialized. …"`; `classifyError` regex `/not initialized/` → `not_ready` 503.
  Matches the mock. ✓
- **Client plumbing** — `addDrone` uses shared `request<T>`; same
  `OwnerNodeUnavailableError` + envelope-unwrap path as every other method. ✓
- **Auth gating** — `handle()` runs `isAuthorized` before `route()`, so
  `add-drone` sits behind the loopback bearer like all routes (structural, not
  per-route-asserted). ✓
- **Tests** — `@serfab/cadre-cli` 94 pass (8 files); `@serfab/cadre-host` 425
  pass / 3 pre-existing skips (51 files). Both builds EXIT=0. ESLint clean on all
  five touched files.

### Minor — fixed inline this pass
- **`docs/cadre-host.md`** admin-route table (line ~162) was missing
  `add-drone`. Added the row after `accept-phone`.
- **`owner-node-client.ts`** file header enumerated the client's extra methods
  ("plus `pushInviteAddresses`") but omitted the new `addDrone`. Updated to name
  both.

### Major — none
No new tickets filed.

### Tripwires — none
No conditional concern surfaced a clear trip condition worth parking. The
"empty `droneMultiaddrs` → possibly degenerate seed" question is a *semantic*
property of the real node, exercised only end-to-end — it belongs to the blocked
integration scenario below, not a route-level guard.

### Deferred (correctly, by the implementer) — not reopened
- **No real-wire E2E.** These are unit/route tests against a mock `CadreNode`
  and a stub admin server; "the real node mints a usable seed through this route"
  stays **unverified end-to-end**. That check is exactly what
  `implement/4-donor-node-donation-integration` (blocked on `2-donation-service`)
  will do, consuming this route via `OwnerNodeClient.addDrone`.
- **Seed shape not asserted.** Mock returns a stand-in `{ seed, encodedSeed }`;
  tests assert plumbing, not a well-formed `ControlNetworkSeed`. Real-node
  assertion belongs to the same integration test.

## Downstream

`implement/4-donor-node-donation-integration` remains in `implement/`, blocked on
`2-donation-service`; it now depends on this slice via `OwnerNodeClient.addDrone`.
