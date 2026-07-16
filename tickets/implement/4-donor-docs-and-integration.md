----
description: Rewrite the cadre-host documentation around the corrected "donates nodes to other people's cadres" model and add an end-to-end test where a stand-in phone asks the host for a node and that node joins the phone's cadre.
prereq: demote-host-founder
files: docs/cadre-host.md, docs/architecture.md, docs/STATUS.md, packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts, packages/integration-tests/src/harness/index.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts
difficulty: hard
----

# Docs realignment + node-donation integration scenario

## Context

`1-donation-grant-tokens` → `3-demote-host-founder` add the donor role and demote the
founder role in code. This ticket makes the **docs** tell the corrected story and adds
the **cross-package integration test** that proves the donate-a-node flow works
end-to-end against real cadre-cli children. Both are load-bearing: `docs/cadre-host.md`
currently codifies the wrong model throughout ("self-host persona … wants a cadre node
for themselves", "cadre-host runs on a machine that *does* hold the admin's authority
identity"), and the existing `cadre-host-authority-node`-style scenario only exercised
the founder flow.

## Part A — docs

### `docs/cadre-host.md` (rewrite)

Reframe the whole document around: **cadre-host donates nodes (run as OS-managed
child processes) to *external* cadres, the same way cadre-provider donates container
nodes — the requester's device stays the cadre authority; the host contributes
capacity and never holds the requester's authority key.**

- **Persona**: primary = someone running an always-on box who wants to *contribute
  nodes to friends'/family's cadres*. Secondary/opt-in = that same person optionally
  running *their own* personal cadre on the box (`ownCadre.enabled`,
  `3-demote-host-founder`). Delete the framing that founding a cadre is the point.
- **Control-plane separation**: keep the management-plane-vs-control-network split
  (still true), but correct the claim that the host "does hold the admin's owner
  identity" — it holds that identity **only** in the opt-in own-cadre role; for donated
  nodes it holds no authority key at all.
- **New "Node donation" section**: the grant-token gate (`1-donation-grant-tokens`),
  the `/grants` lifecycle (`2-donation-service`) with the end-to-end sequence
  (provision → peer → phone `addDrone` → seed → terminate), the pinned-owner-key
  cold-start-trust requirement, and the seedToken-stays-host-side rule. Mirror the
  provider README's container-lifecycle framing.
- **Trust circle**: reframe as the opt-in own-cadre membership mechanism, not the core
  model.
- **Reachability caveat**: state plainly that v1's `/grants` surface is loopback-only
  (same-machine / test), and that reaching it from a remote phone across NAT is
  `backlog/feat-cadre-host-wan-grant-reachability`.
- **Status section**: update to reflect donor-primary reality.

Don't create a new doc — rewrite the existing one (project rule: update existing docs).

### `docs/architecture.md`

Check for the same drift and fix it. The Provider Integration section (§ ~620) and the
seed-bootstrap API list (§ ~1081, `addDrone`/`createInvite`/`acceptPhone`) are the
likely touch points — architecture.md should state that cadre-host is a **second
Orchestrator implementation** of the same donate-a-node contract (OS services instead
of Docker), not a cadre founder. Add a one-line pointer from the Provider Integration
section to cadre-host as the sibling donor.

### `docs/STATUS.md`

Record the realignment (donor role added, founder role demoted to opt-in) and the
deferred WAN reachability.

## Part B — integration scenario

New `packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts`.
A second real cadre-cli node stands in for the **phone/authority**; cadre-host donates
a node to *its* cadre. Model the harness on the existing
`cadre-host-owner-node.integration.ts` (real cadre-cli children, generous startup
budgets, loopback).

Flow to assert:

1. **Requester authority up**: spawn a cadre-cli node as the requester's authority for
   party `P` (this is the "phone"): `cadre-cli start --owner --admin-port … --identity-protobuf …`
   for party `P`. Grab its owner **public key** (the base64url owner key derived from its
   identity — `ed25519KeyPairFromLibp2p`) and its dialable multiaddrs (via the admin
   channel `GET /admin/multiaddrs` / `OwnerNodeClient.getMultiaddrs`). These become
   `ownerKeys` + `bootstrapNodes` for the request.
2. **Host donates a node**: drive `DonationService` (or the `/grants` HTTP surface) —
   `provision({ grantToken, partyId: P, bootstrapNodes, ownerKeys, profile: 'storage' })`.
   Assert the donated node comes up (`awaiting_seed`), and that its child config/env
   carries the pinned owner key.
3. **Peer info**: `getPeer(id)` → donated node's `{ peerId, multiaddrs }`.
4. **Requester seeds it**: call `addDrone({ dronePeerId, droneMultiaddrs })` on the
   requester authority node (over its admin channel — may need a small admin-channel
   method/route if `addDrone` isn't already exposed; if not, drive it in-process via a
   thin helper). Get `encodedSeed`.
5. **Deliver seed**: `applySeed(donationId, encodedSeed)` → asserts `peersAdded >= 1`
   (this is the gate that proves the pinned-owner-key trust wiring works — a cold node
   with no pinned key rejects here).
6. **Node joined requester's cadre**: assert the donated node now sees the requester's
   authority as a control peer (e.g. via the donated node's `/status` or admin
   `listMembers`), i.e. it synced into party `P`, **not** any host party.
7. **Terminate**: `DELETE`/`terminate` cleans up (ports released, workdir gone).

Keep the existing `cadre-host-owner-node.integration.ts` as the **opt-in own-cadre**
scenario (it now represents that secondary persona) — do not delete it; a short header
note that it covers the opt-in role is enough.

## Edge cases & interactions

- **`addDrone` reachability from the test**: step 4 needs the requester authority to
  produce a seed. Check whether the admin channel already exposes `addDrone` (the
  investigator found `addDrone` on `CadreNode`/`SeedBootstrapService` but the admin
  channel routes in `packages/cadre-cli/src/server/admin-server.ts` may not surface
  it). If absent, either add an `/admin/add-drone` route (small, and generally useful)
  or run the requester node in-process rather than as a child so `addDrone` is callable
  directly. Prefer the admin route if it's a few lines — it keeps the test honest to
  the real wire and is reusable by the future WAN work. Decide during implement; note
  which path was taken in the review handoff.
- **Real-libp2p flakiness / timing**: two real nodes + control-DB startup is slow —
  use the same `waitUntil` + generous timeouts as the owner-node scenario; spawn once
  per suite. The donated node syncing into `P` may lag the seed apply — poll, don't
  assume synchronous.
- **Windows workdir release**: reuse the owner-node scenario's `rmSync` retry teardown.
- **Port ranges**: give the suite a dedicated high port range so it doesn't collide
  with concurrent suites (the owner-node scenario uses 19600–19899; pick a distinct
  band).
- **No WAN**: everything is loopback — do not depend on NAT/DDNS. If a test reviewer
  reads "donation works" they must not infer WAN reachability works; add a comment
  that WAN is out of scope (deferred backlog ticket).

## TODO

- [ ] Rewrite `docs/cadre-host.md` around the donor model (persona, control-plane note
  correction, new Node-donation section, trust-circle reframed, reachability caveat,
  status).
- [ ] Fix drift in `docs/architecture.md` (cadre-host = sibling donor Orchestrator, not
  founder); update `docs/STATUS.md`.
- [ ] Add `cadre-host-node-donation.integration.ts` (steps 1–7 above).
- [ ] If needed for step 4, add `/admin/add-drone` to the cadre-cli admin channel (or
  document the in-process alternative taken).
- [ ] Header note on `cadre-host-owner-node.integration.ts` marking it the opt-in
  own-cadre scenario.
- [ ] `yarn workspace @serfab/integration-tests test` (the new scenario) green;
  `yarn lint` green. Real-libp2p suites are slow — stream output
  (`… 2>&1 | tee /tmp/donation-it.log`), never silently redirect.
