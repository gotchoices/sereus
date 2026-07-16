----
description: Add an end-to-end test where a stand-in phone asks a host for a node, and that donated node then joins the phone's own cadre — proving the donate-a-node flow works against real cadre processes on one machine.
prereq: donation-service, donor-add-drone-admin-route
files: packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts, packages/integration-tests/src/harness/wait-utils.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/grant-service.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/owner/owner-node-client.ts, packages/cadre-cli/src/server/admin-server.ts
difficulty: hard
----

# Node-donation integration scenario (real cadre-cli)

## ⚠️ Why this is still in `implement/` (not done yet)

This ticket's **only** deliverable is the cross-package integration test, and that test
imports `DonationService` (`provision` / `getPeer` / `applySeed` / `terminate`) and the
grantee-facing `/grants` HTTP surface — **which still do not exist.** The prereq
`2-donation-service` (slug `donation-service`) never landed its Phase 2/3: as of this
writing it sits in `tickets/implement/2-donation-service.md` with a `<!-- resume-note -->`.

**Root cause of the stall is transient, not logic (re-checked this run).** The prior
`donation-service` run did NOT fail on a code/design problem — it died on an API
connection drop: `API Error: Connection closed mid-response`, then
`[RESULT ✗ ERROR | 518.1s]` (log:
`tickets/.logs/2-donation-service.implement.2026-07-16T16-55-13-096Z.log`). By the time it
dropped it had already written `donation/types.ts` and `donation/donation-store.ts` and was
one step away from writing `donation/donation-service.ts` (it had just confirmed no
`nanoid` dep and chose `randomBytes`). So the surface is *nearly* built — resuming the
ticket (runner will, via its resume-note) should finish `donation-service.ts` +
`server/routes/grants.ts` and export `DonationService` from `@serfab/cadre-host`. This is a
**re-dispatch-to-completion** situation, not a broken-design one.

Present today: the grant-token layer (`1-donation-grant-tokens`, complete), the orchestrator
pinned-owner-key wiring, and `donation/donation-store.ts` + `donation/types.ts` (from the
dropped run). Absent: `donation-service.ts`, `server/routes/grants.ts`, and any
`DonationService` export (`grep DonationService packages/cadre-host/src` → empty, re-verified
this run).

A test against a non-existent class can't compile, so **the scenario cannot be written to
a green build until `donation-service` lands.** This ticket is therefore kept in
`implement/` (not blocked — "a sibling isn't done" is a `prereq:`, not a block) with the
prereq declared so the runner defers it until that surface exists. The **buildable** part
of the original ticket — the `add-drone` admin route the scenario's step 4 needs — was
split off, built, tested, and has since advanced all the way to
`complete/4-donor-add-drone-admin-route` (re-verified this run: client helper
`owner-node-client.ts:165`, route `admin-server.ts:207`).

**Human note:** the blocker is a *transient API drop* that killed the near-complete
`donation-service` run — not a logic bug (see root-cause paragraph above). Re-running
`donation-service` should carry it to completion, which unblocks this scenario. Nothing
here needs a human decision; it needs `donation-service` to finish. If `donation-service`
proves genuinely un-completable across repeated re-dispatches (not the case as of this
run), *that* is when it — not this ticket — would escalate.

## What is already done (do NOT redo)

- **`addDrone` reachability — RESOLVED.** `POST /admin/add-drone` now exists on the
  cadre-cli admin server (`packages/cadre-cli/src/server/admin-server.ts`) and
  `OwnerNodeClient.addDrone({ dronePeerId, droneMultiaddrs })` →
  `{ seed, encodedSeed }` exists on the cadre-host client
  (`packages/cadre-host/src/owner/owner-node-client.ts`). **Step 4 below uses
  `OwnerNodeClient.addDrone` directly** — do not run the requester node in-process, and do
  not re-add the route. (Landed + unit-tested in `complete/4-donor-add-drone-admin-route`.)
- **Orchestrator pin-key wiring** (`host-process-orchestrator.ts:~220-253`): threads
  `request.pinnedOwnerKeys` → `env.CADRE_OWNER_KEYS`; `cadre-cli start` unions that into a
  `pinnedKeyTrustPolicy`. This is the load-bearing bit that lets a cold donated node accept
  the requester-signed seed. Already unit-covered — this test exercises it over the wire.
- The node's `POST /seed` route + host-side `seedToken` (from the cadre-provider seed
  work) — `DonationService.applySeed` presents the persisted token to it.

## Context

Model the harness on `cadre-host-owner-node.integration.ts` (real cadre-cli children,
generous startup budgets, loopback). The requester's authority node is a **second real
cadre-cli child** standing in for the phone; cadre-host donates a node to *its* cadre.
The `waitUntil` helper lives in `packages/integration-tests/src/harness/` (re-exported
from `index.ts`).

## New scenario: `cadre-host-node-donation.integration.ts`

Flow to assert (steps 1–7):

1. **Requester authority up.** Spawn a cadre-cli node as the requester's authority for
   party `P` (the "phone"): `cadre-cli start --owner --admin-port … --identity-protobuf …`.
   Grab its owner **public key** (the base64url owner key derived from its identity) and
   its dialable multiaddrs (via `OwnerNodeClient.getMultiaddrs` / `GET /admin/multiaddrs`).
   These become `ownerKeys` + `bootstrapNodes` for the request.
2. **Host donates a node.** Drive `DonationService` (or the `/grants` HTTP surface):
   `provision({ grantToken, partyId: P, bootstrapNodes, ownerKeys, profile: 'storage' })`.
   The `grantToken` comes from `GrantService.issue({ label })` (that layer HAS landed).
   Assert the donated node comes up (`awaiting_seed`) and that its child config/env carries
   the pinned owner key (`CADRE_OWNER_KEYS`).
3. **Peer info.** `getPeer(id)` → donated node's `{ peerId, multiaddrs }`.
4. **Requester seeds it.** `client.addDrone({ dronePeerId, droneMultiaddrs })` on the
   requester authority node (over its admin channel) → `{ encodedSeed }`.
5. **Deliver seed.** `applySeed(donationId, encodedSeed)` → assert `peersAdded >= 1`.
   This is the gate that proves the pinned-owner-key trust wiring works — a cold node with
   no pinned key rejects here.
6. **Node joined requester's cadre.** Assert the donated node now sees the requester's
   authority as a control peer (via the donated node's `/status` or admin `listMembers`),
   i.e. it synced into party `P`, **not** any host party.
7. **Terminate.** `terminate` / `DELETE /grants/:id` cleans up (ports released, workdir gone).

## Edge cases & interactions

- **Real-libp2p flakiness / timing.** Two real nodes + control-DB startup is slow — reuse
  the owner-node scenario's `waitUntil` + generous timeouts (`STARTUP_MS` 90s, `OP_MS` 30s).
  Spawn once per suite. The donated node syncing into `P` may **lag** the seed apply —
  poll (`waitUntil`), don't assume synchronous.
- **Windows workdir release.** Reuse the owner-node scenario's `rmSync` retry teardown
  (`maxRetries` / `retryDelay`).
- **Port ranges.** Give the suite a **dedicated high port band** distinct from the
  owner-node scenario's `19600–19899` — e.g. `19900–20199` for each orchestrator + the
  requester node's admin/health ports. Use ephemeral (`0`) libp2p ports so the OS assigns
  them and `getMultiaddrs()` reports the real bound address (avoids cross-suite TCP
  collisions).
- **No WAN.** Everything is loopback — do not depend on NAT/DDNS. Add a comment that WAN
  reachability is out of scope (deferred `backlog/feat-cadre-host-wan-grant-reachability`)
  so a reader can't infer WAN works from a green donation test.
- **Two cadres at once (optional hardening).** The orchestrator keys workdirs/ports by
  `containerId` (= donation id, unique), so one host can donate to two different `partyId`s
  concurrently; a second donation to a different party is a good extra assertion if cheap.

## TODO

- [ ] (Gated on `donation-service`.) Add `cadre-host-node-donation.integration.ts`
  (steps 1–7), modeled on `cadre-host-owner-node.integration.ts`. Use
  `OwnerNodeClient.addDrone` for step 4 (route already landed).
- [ ] `yarn workspace @serfab/integration-tests test` (the new scenario) green;
  `yarn lint` green. Real-libp2p suites are slow — **stream output**
  (`… 2>&1 | tee /tmp/donation-it.log`), never silently redirect (idle-timeout risk).
- [ ] (Already done — do not repeat.) `add-drone` admin route + client helper; header note
  on `cadre-host-owner-node.integration.ts`.
