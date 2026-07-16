----
description: A node can now mint, over a small local HTTP call, the join-credential ("seed") that authorizes another node to join its cadre — the piece a friend's phone needs on its side of the donate-a-node flow.
prereq:
files: packages/cadre-cli/src/server/admin-server.ts, packages/cadre-cli/test/admin-server.spec.ts, packages/cadre-host/src/owner/owner-node-client.ts, packages/cadre-host/src/owner/__tests__/owner-node-client.test.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts
difficulty: easy
----

# Review: `add-drone` admin route + client helper

## What this is (and why it's a carve-out)

This is a slice split out of `4-donor-node-donation-integration` (the node-donation
integration test). That test's **step 4** needs the requester's authority node (the
"phone") to mint a **seed** — the signed join-credential that authorizes a donated node
to join the phone's cadre — via `CadreNode.addDrone`. The cadre-cli **admin channel did
not expose `addDrone`** (it had `identity`, `multiaddrs`, `members`,
`authorized-members`, `invites`, `accept-phone`, `members/:peerId` DELETE,
`invite-addresses` — but no `add-drone`).

The parent ticket explicitly asked the implementer to resolve this "addDrone
reachability question" by either **(a)** adding `POST /admin/add-drone` to the admin
server, or **(b)** running the requester node in-process. **Option (a) was taken** —
it's a few lines, honest to the real wire, and reusable by the future WAN grant work
(`backlog/feat-cadre-host-wan-grant-reachability`). This slice is independent of the
still-missing donation service, so it was built, tested, and advanced on its own rather
than held hostage to that blocker (see the sibling implement ticket below).

## What changed

- **`packages/cadre-cli/src/server/admin-server.ts`** — new route
  `POST /admin/add-drone`. Body `{ dronePeerId: string, droneMultiaddrs: string[] }` →
  delegates to `node.addDrone(...)` → returns `{ seed, encodedSeed }` in the standard
  `{ ok, data }` envelope. Validates: non-empty `dronePeerId` and a string-array
  `droneMultiaddrs` (both → `400 bad_request`); a not-yet-initialized seed-bootstrap
  service classifies to `503 not_ready` via the existing `classifyError` regex. The
  route doc-comment list was updated.
- **`packages/cadre-host/src/owner/owner-node-client.ts`** — new
  `OwnerNodeClient.addDrone({ dronePeerId, droneMultiaddrs })` → `Promise<DroneInitResult>`
  (`{ seed, encodedSeed }` from `@serfab/cadre-core`). Thin POST over the loopback admin
  channel, same envelope-unwrapping / `OwnerNodeUnavailableError` mapping as the other
  client methods.
- **`cadre-host-owner-node.integration.ts`** — header note added marking it the opt-in
  own-cadre (founder) scenario, pointing at the (blocked) donation scenario.

## How to validate

- `yarn workspace @serfab/cadre-cli test` — `admin-server.spec.ts` gained an
  `add-drone route` block (4 cases: happy path forwards decoded args + returns the minted
  seed; missing `dronePeerId` → 400; non-array `droneMultiaddrs` → 400; not-initialized →
  503). **94 tests pass.**
- `yarn workspace @serfab/cadre-host test` — `owner-node-client.test.ts` gained an
  `addDrone` case (POSTs `/admin/add-drone`, sends the body, unwraps the seed result).
  **425 pass / 3 pre-existing skips.**
- `yarn workspace @serfab/cadre-cli build` + `@serfab/cadre-host build` — typecheck clean.
- `eslint` on all five touched files — clean.

## Known gaps / test floor (be adversarial here)

- **No end-to-end coverage.** These are unit/route tests against a mock `CadreNode`
  (cadre-cli) and a stub admin server (cadre-host). The route is **not** yet exercised
  over the real wire against a real `CadreNode.addDrone` — that is precisely what the
  blocked donation integration scenario will do. Treat "the real node actually mints a
  usable seed through this route" as **unverified end-to-end**.
- **Seed shape not asserted.** The mock returns a stand-in `{ seed, encodedSeed }`; the
  tests assert plumbing (args forwarded, envelope shape), not that `seed` is a
  well-formed `ControlNetworkSeed`. A reviewer wanting more could add a
  cadre-core-level assertion, but the real-node check belongs in the integration test.
- **Auth posture unchanged.** `/admin/add-drone` sits behind the same loopback bearer as
  every other admin route — no new exposure. Confirm the route can't be reached without
  the bearer (covered by the existing global auth test, not re-asserted per-route).

## Sibling ticket (the actual donation scenario, still blocked)

`implement/4-donor-node-donation-integration` remains in **implement/**, blocked on
`2-donation-service` (its `DonationService` / `/grants` provisioning surface never
landed — that ticket is still in `implement/` with a resume note). This add-drone slice
is a hard dependency that ticket now consumes via `OwnerNodeClient.addDrone`.
