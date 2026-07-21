description: The self-hosted manager can now donate a compute node to a friend's cadre — the friend's phone asks over a small bearer-authenticated API, the manager spawns a node into the friend's cadre and presents the phone-signed seed to it, never holding the friend's authority key.
prereq: donation-grant-tokens
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-store.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/server/error-handler.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts, packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, docs/cadre-host.md
difficulty: hard
----

# Complete: donation service — the node-donor grant lifecycle

## What shipped

cadre-host donates a node on behalf of an external cadre authority (a friend's
phone). The host contributes capacity only; it never receives the phone's
authority private key. Full loopback flow:

```
phone (authority)            cadre-host (donor)                donated node (child proc)
1. POST /grants        ──▶ validate grant bearer + quota, serialize per grant,
                            orchestrator.createContainer(... pinnedOwnerKeys)  ── spawn: pin ownerKeys, join party
2. GET /grants/:id/peer ──▶ node /status → { peerId, multiaddrs }
3. phone addDrone(...)      → encodedSeed (signed with the phone's authority key)
4. PUT /grants/:id/seed ──▶ present host↔node seedToken to node POST /seed      ── node trusts the pinned ownerKeys
5. DELETE /grants/:id  ──▶ orchestrator stop + remove
```

The load-bearing gotcha (the #1 gate): a freshly-spawned cold node defaults to a
db-anchored trust policy that **rejects every seed**. The donated node is started
with the requester's owner public key(s) pinned as cold-start trust anchors —
`OrchestratorCreateRequest.pinnedOwnerKeys` → child `env.CADRE_OWNER_KEYS` →
`cadre-cli start` unions into a pinned-key trust policy. "Node accepts the
phone's seed" is proven by the integration scenario.

The implement handoff read as finished; the code from commit `ecb42a8` (routes,
wiring, reap, unit tests) plus `d977c30` was verified this pass and found sound.
Review found no major defects — only minor polish (below).

## Review findings

**Checked:** the full diff with fresh eyes (`donation-service.ts`,
`donation-store.ts`, `types.ts`, `routes/grants.ts`, `error-handler.ts`,
`server/index.ts`, `bin/host.ts`, orchestrator pin-key threading, all three unit
suites) against SRP / DRY / resource-cleanup / error-handling / type-safety /
security / concurrency / crash-recovery; the touched docs; and a full green
build + test + lint. Integration acceptance (5/5, two real cadre-cli children)
was re-confirmed as the shipping gate in the implement pass.

**Minor — fixed inline this pass:**
- `routes/grants.ts` `authenticate`: an unknown/missing bearer on the
  GET/PUT/DELETE paths returned HTTP **401** with envelope `code: 'forbidden'` —
  self-contradictory, and inconsistent with `POST /grants`, which surfaces the
  same condition as `unauthorized`. Now derives the code from the status
  (401→`unauthorized`, 403→`forbidden`). Locked with a new route test
  (`GET /grants` unknown bearer → 401 `unauthorized`); grants-route suite now
  11/11.
- `docs/cadre-host.md` "Status of the donation surface": listed the `/grants`
  provisioning surface, the `bin/host.ts` wiring, the reap sweep, and the
  `DonationService`/route unit tests as **"still in progress"** — all shipped in
  this ticket. Rewritten to reflect landed reality (only WAN reachability
  remains, already cross-linked below it).
- `types.ts` `Donation.peerId`: doc-comment claimed "libp2p peerId, once the
  node reports one", but nothing ever writes the field (`getPeer` reads it live
  from the node's `/status` every call). Comment corrected to mark it reserved /
  currently-unwritten so a future reader doesn't trust a dead field.

**Major (new ticket):** none. No correctness, security, or resource defect
survived scrutiny.

**Verified sound — no action:**
- **Reclaim on provision failure.** The failure path calls only
  `safeReclaim` (`removeContainer`), not `stopContainer` — but
  `HostProcessOrchestrator.removeContainer` stops a live child before removing
  it, so no orphaned process. Confirmed by reading, and by the
  `reclaim-on-post-spawn-failure` unit test (`removeContainer` called with the
  spawned dockerId, record → `error`, live count → 0).
- **Quota-race serialization.** `serializeByGrant` chains each provision after
  the prior one for the same token and swallows the stored tail's outcome, so a
  rejected provision defers — never rejects — the next caller; the check→create
  pair is atomic per grant. Covered by the concurrent-boundary test (exactly one
  of two racing provisions passes; one node spawned).
- **Key-boundary security.** `seedToken` + `seedEndpoint` are stripped by
  `DonationView` on every wire return but persisted in `donations.json` for the
  host-restart request→seed gap; the phone's authority private key never
  transits the host (only its signed, public seed does). Ownership isolation: an
  unknown id and a foreign grant's id are both 404 (a grantee never learns
  another's donations exist).
- **`pinnedOwnerKeys` inert on the provider Docker path.** Only
  `HostProcessOrchestrator` reads it; cadre-provider's `docker-orchestrator`
  never references it. Intentional and confirmed.

**Tripwires (conditional — recorded, not ticketed):**
- Revoked/expired grant blocks the grantee's own `DELETE /grants/:id` (the
  `authenticate` gate rejects it), and the reap sweep only targets
  `awaiting_seed` — so a **`seeded`** node under a later-revoked grant is not
  torn down by the grantee and is not reaped. This matches the documented CLI
  contract ("revoke blocks future requests; live nodes are not torn down" — the
  admin tears them down). Intentional today; if operators expect revoke to also
  reap live donated nodes, add a `seeded`-status reap on revoke. Parked here in
  findings (no single new code site; the behavior spans `grant revoke` + reap).
- Already-parked `NOTE:` tripwires from implement remain valid: `provisionTail`
  never evicts an entry per grant token (`donation-service.ts`), and
  `donation-store.ts` rewrites the whole `donations.json` on every mutation —
  both fine at household scale, both greppable at their site.
- `DonationStore.remove()` has no caller (terminate keeps records as
  `terminated` for audit). Harmless — it mirrors `GrantStore.remove`'s API
  shape; left in place.

**Empty categories, stated explicitly:** no major findings, so no new
`fix/`/`plan/`/`backlog/` ticket was filed — the shipped slice is correct and
complete for v1 loopback scope. No pre-existing test failure surfaced (full
cadre-host suite green), so no `.pre-existing-error.md` was written.

## Validation (this pass — all green)

- `yarn workspace @serfab/cadre-provider build` ✓
- `yarn workspace @serfab/cadre-cli build` ✓ (required: orchestrator/CLI-smoke
  suites spawn a real `cadre` bin)
- `yarn workspace @serfab/cadre-host build` ✓
- `yarn workspace @serfab/cadre-host test` → **54 files, 448 passed / 3 skipped /
  0 failed** ✓ (447 → 448 with the new GET-auth route test)
- `yarn lint` (whole repo) ✓ — clean before and after the edits

## Known gaps (carried forward, unchanged)

- `getPeer` / `applySeed` happy paths (a live `fetch` round-trip to a child) are
  covered only by the integration scenario, not by a unit seam. A fetch-mock
  harness would let the `peersAdded` success path be unit-asserted.
- The `bin/host.ts` reap-timer plumbing (`setInterval` / `unref` /
  `clearInterval`-on-shutdown) is verified by reading, not a start-command smoke
  test. The reap *logic* (`reapStaleAwaitingSeed`) is unit-tested directly.
- WAN reachability is out of scope — `/grants` binds loopback only. Exposing it
  to a remote phone is `backlog/feat-cadre-host-wan-grant-reachability`.
- Reap TTL / sweep interval are module constants (30 min / 5 min), not
  operator-configurable (already `NOTE:`-tagged at the constant).
