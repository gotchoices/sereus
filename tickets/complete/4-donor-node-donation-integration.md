description: A cadre-host feature that lets a friend's phone borrow a spare node from the host — the host spins up a node that joins the phone's own network — now has an end-to-end test proving it works, plus the small service that drives it. Reviewed and complete.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/index.ts, packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts, docs/cadre-host.md, docs/STATUS.md, docs/architecture.md
----

# Complete: node-donation integration scenario + the `DonationService` it drives

## What landed

1. **`packages/cadre-host/src/donation/donation-service.ts`** — the `DonationService`
   class (`provision` / `getPeer` / `applySeed` / `terminate` / `get` / `list`),
   exported from `@serfab/cadre-host`. Drives the donate-a-node lifecycle: spawns a
   generic node into the *requester's* cadre, pins the requester's owner key(s) so the
   node accepts a requester-signed seed, presents that seed to the node's `POST /seed`.
   Never holds the requester's authority private key.
2. **`packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts`** —
   steps 2–7 end-to-end against **two real `cadre-cli` children** (requester authority +
   donated node) on loopback. The load-bearing assertion is step 5 (`peersAdded ≥ 1`): a
   cold donated node accepts the requester-signed seed only because the requester's owner
   key was pinned via `CADRE_OWNER_KEYS`.

## Why `donation-service.ts` was built in this ticket

This ticket's stated deliverable was only the integration scenario, gated on prereq
`2-donation-service`, which never landed its service layer (it kept dying on transient API
connection drops, not logic problems). Per tess rules ("design as if the prereq landed;
pick the best option and proceed"), the implementer built the minimal slice the test needs
— exactly `donation-service.ts` — and went green. The rest of `2-donation-service`
(grantee-facing `/grants` HTTP routes, `bin/host.ts` wiring, reap sweep, dedicated unit
tests) is still owned by that ticket; a `STATUS (updated by ticket 4)` banner was left there
so the resuming agent does not clobber `donation-service.ts`.

## Review findings

**Gates run this pass (all green):**
- `eslint` on all 5 touched code files — exit 0.
- `yarn workspace @serfab/cadre-host typecheck` + `@serfab/integration-tests typecheck` — clean.
- `yarn workspace @serfab/cadre-host test` — **425 passed, 3 pre-existing skips, 0 regressions**.
- Built `@serfab/cadre-core` + `@serfab/cadre-cli` + `@serfab/cadre-host` (`build:server`), then
  `vitest run cadre-host-node-donation` — **5/5 steps passed, ~22s**.

**Correctness / logic (`DonationService`) — checked, no defects found:**
- `provision` serializes per grant token (`serializeByGrant`) so the quota check + record-create
  are atomic; a failed provision reclaims the container and marks the record `error`, freeing the
  quota slot (`error`/`terminated` excluded from `liveNodeCount`). `serializeByGrant` attaches
  rejection handlers on both the returned promise and the stored tail — no unhandled rejection, a
  rejected provision only defers the next same-token caller.
- `getPeer` reads `/status` fresh every call (no stale cache); `applySeed` guards on
  `awaiting_seed`/`seeded`, fails fast when `seedToken` is missing, and does **not** transition
  status on a node `success:false` (correct — no false `seeded`). `terminate` uses best-effort
  stop/reclaim that log-but-never-throw.
- `redact` strips `seedToken` + `seedEndpoint` from every wire view (`DonationView`). Verified the
  `/status` payload shape (`packages/cadre-cli/src/server/health.ts`) exposes both top-level
  `peerId`/`multiaddrs` (used by `getPeer`) and nested `node.partyId`/`node.connectionPaths` (used
  by step 6) — both read paths are correct.

**Docs (were stale — fixed inline this pass):** `DonationService` had landed but three docs still
listed it as "in progress / being wired" and the integration test as not-yet-done:
- `docs/cadre-host.md` "Status of the donation surface" — moved `DonationService` into "Landed
  today" (proven by the integration scenario); kept `/grants` routes + `bin/host.ts` wiring + reap
  sweep + unit tests as in-progress.
- `docs/STATUS.md` node-donation checklist — `DonationService` lifecycle and the cross-package
  integration test flipped to `[x]`; residual routes/wiring/reap/unit-tests remain `[~]`.
- `docs/architecture.md` cadre-host section heading + donor bullet — reflect `DonationService`
  landed, `/grants` routes still being added.

**Test coverage (happy path only — a known floor, not re-filed here):** the scenario walks only
the happy path. `DonationService`'s error paths (`not_found`, `invalid_state`, denial→code mapping,
reclaim-on-failure, foreign-party no-push) and persistence edge cases (seedToken survives store
reconstruct, quota-race serialization) have **no** dedicated unit tests yet. This is explicitly
tracked as remaining Phase-2 work on `2-donation-service` (its test list) — left there rather than
duplicated into a new ticket.

**Major findings → new ticket (1):**
- `backlog/debt-vitest4-pooloptions-migration` — `packages/integration-tests/vitest.config.ts` uses
  `poolOptions.forks.singleFork`, which **Vitest 4 removed** (prints a `DEPRECATED … poolOptions was
  removed` warning). The intended single-fork *sequential* run — the guard against two suites
  colliding on the same TCP port — is silently no longer applied. Pre-existing (outside this diff)
  and not failing today only because the two real-child scenarios use disjoint port bands
  (owner-node 19600–19899, donation 19900–20199) — a convention, not an enforced invariant. This is
  a definite misconfiguration (option dropped), not a conditional concern, so it's a `debt-` ticket
  rather than a tripwire; low, mechanical.

**Tripwires / observations (parked, not ticketed):**
- `DonationService.provisionTail` grows unbounded (one entry per grant token, never evicted).
  Already tagged `// NOTE:` at the site in `donation-service.ts`. Fine at household scale; if grant
  counts grow large, evict the tail once it resolves.
- Provisions for the *same* grant token are fully serial including the multi-second node spawn
  (`serializeByGrant` holds the lock across the awaited `createContainer`). Correct and required for
  the atomic quota check; only a concern if one grant ever needs many nodes provisioned fast — not a
  household-scale problem. Observation only.
- `Donation.peerId` is declared but never populated (`getPeer` reads live from `/status` instead);
  `DonationView.peerId` is therefore always `undefined`. Harmless (live read is the source of truth);
  the routes layer in `2-donation-service` may populate it. Not a defect.
- Step 6's connection assertion is coarse — it passed in ~13ms, i.e. the donated node was likely
  already connected via its bootstrap dial, independent of the seed. Step 5 (`peersAdded ≥ 1`) is
  the real seed-caused-trust proof; step 6 is corroboration, not a tight seed→connection assertion.
- Real-libp2p flakiness: green and fast this run (~22s), but two real children + control DBs are
  timing-sensitive. Timeouts are generous and everything polls via `waitUntil`; treat a single green
  run as a floor, not a guarantee on a slow CI box.

## Deferred (unchanged, owned elsewhere)

- `2-donation-service` (still in `implement/`): `/grants` HTTP routes, `bin/host.ts` wiring, reap
  sweep, and `DonationService` unit tests.
- `backlog/feat-cadre-host-wan-grant-reachability`: WAN reachability + per-donated-node NAT/relay
  mapping. v1 donation is loopback-only; a green donation test says nothing about a remote phone
  reaching the host over NAT.
