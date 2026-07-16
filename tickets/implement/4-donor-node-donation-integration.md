----
description: Add an end-to-end test where a stand-in phone asks a cadre-host for a node, and that donated node then joins the phone's own cadre — proving the donate-a-node flow works against real cadre processes on one machine.
prereq: donation-service
files: packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts, packages/integration-tests/src/harness/index.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-cli/src/server/admin-server.ts
difficulty: hard
----

# Node-donation integration scenario (real cadre-cli)

## Why this ticket exists (split from `4-donor-docs-and-integration`)

The original ticket bundled a docs realignment (**Part A**, shipped — see
`review/4-donor-docs-realignment` / `complete/`) with this cross-package integration test
(**Part B**). Part B drives `DonationService.provision` / `getPeer` / `applySeed` /
`terminate` and the grantee-facing `/grants` HTTP surface — **which did not exist when
the original ticket ran.** `2-donation-service` had landed only its Phase 1 (orchestrator
pinned-owner-key wiring) plus the donation store/types; its Phase 2/3 (`DonationService`,
`/grants` routes, reap sweep) were absent. A test importing a non-existent class can't
compile, so this was refiled with `prereq: donation-service` and picked up once that
surface lands. **Assume donation-service has landed as designed** (its ticket specifies
the exact `DonationService` API and `/grants` routes) — build against it.

## Context

`1-donation-grant-tokens` → `2-donation-service` → `3-demote-host-founder` add the donor
role and demote the founder role in code. This test proves the donate-a-node flow works
end-to-end against real cadre-cli children. Model the harness on the existing
`cadre-host-owner-node.integration.ts` (real cadre-cli children, generous startup
budgets, loopback).

**Already landed and worth reusing (do not re-implement):**
- Orchestrator pin-key wiring: `HostProcessOrchestrator.createContainer` threads
  `request.pinnedOwnerKeys` → `env.CADRE_OWNER_KEYS`
  (`packages/cadre-host/src/orchestrator/host-process-orchestrator.ts:220-253`);
  `cadre-cli start` unions `CADRE_OWNER_KEYS` into a `pinnedKeyTrustPolicy`. This is the
  load-bearing bit that lets a cold donated node accept the requester-signed seed. It is
  already unit-covered (`packages/cadre-cli/test/start-pins.spec.ts` and the orchestrator
  unit suite) — this test exercises it end-to-end over the real wire.
- The node's `POST /seed` route + host-side `seedToken` (from the cadre-provider seed
  work) — `DonationService.applySeed` presents the persisted token to it.

## New scenario: `cadre-host-node-donation.integration.ts`

A second real cadre-cli node stands in for the **phone/authority**; cadre-host donates a
node to *its* cadre. Model on `cadre-host-owner-node.integration.ts` (real cadre-cli
children, generous startup budgets, loopback).

Flow to assert:

1. **Requester authority up.** Spawn a cadre-cli node as the requester's authority for
   party `P` (the "phone"): `cadre-cli start --owner --admin-port … --identity-protobuf …`.
   Grab its owner **public key** (the base64url owner key derived from its identity —
   `ed25519KeyPairFromLibp2p` / the owner key the node reports) and its dialable
   multiaddrs (via the admin channel `GET /admin/multiaddrs` / `OwnerNodeClient.getMultiaddrs`).
   These become `ownerKeys` + `bootstrapNodes` for the request.
2. **Host donates a node.** Drive `DonationService` (or the `/grants` HTTP surface) —
   `provision({ grantToken, partyId: P, bootstrapNodes, ownerKeys, profile: 'storage' })`.
   Assert the donated node comes up (`awaiting_seed`), and that its child config/env
   carries the pinned owner key (`CADRE_OWNER_KEYS`).
3. **Peer info.** `getPeer(id)` → donated node's `{ peerId, multiaddrs }`.
4. **Requester seeds it.** Call `addDrone({ dronePeerId, droneMultiaddrs })` on the
   requester authority node (over its admin channel) → `{ encodedSeed }`.
5. **Deliver seed.** `applySeed(donationId, encodedSeed)` → assert `peersAdded >= 1`.
   This is the gate that proves the pinned-owner-key trust wiring works — a cold node with
   no pinned key rejects here.
6. **Node joined requester's cadre.** Assert the donated node now sees the requester's
   authority as a control peer (via the donated node's `/status` or admin `listMembers`),
   i.e. it synced into party `P`, **not** any host party.
7. **Terminate.** `DELETE` / `terminate` cleans up (ports released, workdir gone).

Keep the existing `cadre-host-owner-node.integration.ts` as the **opt-in own-cadre**
scenario — do not delete it; add a short header note that it covers the opt-in founder
role (a one-line note is enough; the docs realignment already labels it as such).

## The `addDrone` reachability question (decide during implement, note in handoff)

Step 4 needs the requester authority to produce a seed via `addDrone`. Check whether the
cadre-cli **admin channel** exposes it. It currently does **not**:
`packages/cadre-cli/src/server/admin-server.ts` routes `identity`, `multiaddrs`, `members`,
`authorized-members`, `invites`, `accept-phone`, `members/:peerId` (DELETE), and
`invite-addresses` — but **no `add-drone`**. `addDrone` lives on `CadreNode` /
`SeedBootstrapService`.

Two options — prefer the first if it's a few lines:
- **Add `POST /admin/add-drone`** to the admin server (body `{ dronePeerId,
  droneMultiaddrs }` → `{ seed, encodedSeed }`). Small, honest to the real wire, and
  reusable by the future WAN work. If chosen, add a matching `OwnerNodeClient.addDrone` (or
  a thin admin-client helper) and a route unit test.
- **Run the requester node in-process** (a real `CadreNode` in the test process, not a
  child) so `addDrone` is directly callable, while the *donated* node stays a real
  cadre-cli child. Faster to write; slightly less "real wire."

Decide during implement; state which path was taken (and why) in the review handoff.

## Edge cases & interactions

- **Real-libp2p flakiness / timing.** Two real nodes + control-DB startup is slow — reuse
  the owner-node scenario's `waitUntil` + generous timeouts (`STARTUP_MS` 90s,
  `OP_MS` 30s). Spawn once per suite. The donated node syncing into `P` may **lag** the
  seed apply — poll (`waitUntil`), don't assume synchronous.
- **Windows workdir release.** Reuse the owner-node scenario's `rmSync` retry teardown
  (`maxRetries` / `retryDelay`).
- **Port ranges.** Give the suite a **dedicated high port band** so it doesn't collide
  with concurrent suites — the owner-node scenario uses `19600–19899`; pick a distinct
  band (e.g. `19900–20199`) for each orchestrator + the requester node's admin/health
  ports. Use ephemeral (`0`) libp2p ports so the OS assigns them and `getMultiaddrs()`
  reports the real bound address (avoids cross-suite TCP collisions).
- **No WAN.** Everything is loopback — do not depend on NAT/DDNS. Add a comment that WAN
  reachability is out of scope (deferred `backlog/feat-cadre-host-wan-grant-reachability`)
  so a reader can't infer WAN works from a green donation test.
- **Two cadres at once (optional hardening).** The orchestrator keys workdirs/ports by
  `containerId` (= donation id, unique), so one host can donate to two different
  `partyId`s concurrently; a second donation to a different party is a good extra assertion
  if cheap.

## TODO

- [ ] Add `cadre-host-node-donation.integration.ts` (steps 1–7 above), modeled on
  `cadre-host-owner-node.integration.ts`.
- [ ] Resolve the `addDrone` reachability question: add `POST /admin/add-drone`
  (+ client helper + route unit test) **or** run the requester node in-process. Note which
  in the handoff.
- [ ] Header note on `cadre-host-owner-node.integration.ts` marking it the opt-in
  own-cadre scenario.
- [ ] `yarn workspace @serfab/integration-tests test` (the new scenario) green;
  `yarn lint` green. Real-libp2p suites are slow — **stream output**
  (`… 2>&1 | tee /tmp/donation-it.log`), never silently redirect (idle-timeout risk).
