description: A cadre-host feature that lets a friend's phone borrow a spare node from the host — the host spins up a node that joins the phone's own network — now has an end-to-end test proving it works, plus the small service that drives it. Review the new code.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/index.ts, packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts
difficulty: medium
----

# Review: node-donation integration scenario + the `DonationService` it drives

## TL;DR for the reviewer

Two things landed and are green:

1. **`packages/cadre-host/src/donation/donation-service.ts`** — the `DonationService`
   class (`provision` / `getPeer` / `applySeed` / `terminate` / `get` / `list`), exported
   from `@serfab/cadre-host`.
2. **`packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts`** —
   the steps 1–7 end-to-end scenario against **two real `cadre-cli` children** (requester
   authority + donated node), on loopback.

Status of every gate run this session:

- `yarn workspace @serfab/cadre-host build:server` — clean.
- `yarn workspace @serfab/integration-tests typecheck` + `yarn workspace @serfab/cadre-host typecheck` — clean.
- `eslint` on all touched files — clean (exit 0).
- The new scenario — **5/5 passed, 19s** (`vitest run cadre-host-node-donation`).
- `yarn workspace @serfab/cadre-host test` — **425 passed, 3 pre-existing skips, 0 regressions**.

## Why `donation-service.ts` is in *this* ticket's diff (important context)

This ticket's stated deliverable was **only** the integration scenario, gated on prereq
`donation-service` (ticket `2-donation-service`). That prereq never landed its service
layer: across 5+ re-dispatches it kept dying on **transient API connection drops**
(`API Error: Connection closed mid-response`), not on any logic/design problem — its
`types.ts` + `donation-store.ts` were already written, but `donation-service.ts` and the
`DonationService` export did not exist. A test that imports `DonationService` cannot compile
against a class that does not exist, so the scenario could not be written to a green build,
and the ticket sat re-documenting the gate run after run without advancing the board.

Per the tess rules (**don't park on a `prereq:` — "design as if it has landed", pick the
best option and proceed; never mirror the runner's deferral by hand**), the value-adding
move was to build the *minimal slice of the prereq my test actually needs* and go green,
rather than re-park. My test drives `DonationService` **in-process** (the ticket explicitly
allowed "drive `DonationService` **or** the `/grants` HTTP surface"), so the minimal slice is
exactly one file: `donation-service.ts`. I did **not** build the rest of the
`donation-service` ticket (see next section) — that stays its work.

**Coordination:** I updated `tickets/implement/2-donation-service.md` with a
`STATUS (updated by ticket 4)` banner so the resuming agent does not re-write / clobber
`donation-service.ts`; it should now build **only** the remaining Phase 3 + tests.

## What `DonationService` does NOT include (still owned by `2-donation-service`)

The reviewer should **not** flag these as omissions in *this* ticket — they are deliberately
left to the prereq ticket, and I noted them there:

- **Grantee-facing HTTP routes** (`server/routes/grants.ts`) — the scenario drives the
  service object directly; no routes needed to prove the flow.
- **`bin/host.ts` wiring** — constructing/mounting the service in the real host process.
- **Reap sweep** for stale `awaiting_seed` donations (TTL auto-terminate) + reap-on-init.
- **Dedicated unit tests** for `DonationService` (provision→awaiting_seed, seedToken
  persistence across store reconstruct, quota-race serialization, reclaim-on-failure,
  foreign-party no-push). Today the class is exercised **only** through the integration
  scenario — treat that as a floor, not a unit-test substitute.

## The flow the scenario proves (use cases / validation)

Run it: `cd packages/integration-tests && yarn vitest run cadre-host-node-donation`.
Needs `@serfab/cadre-cli`, `@serfab/cadre-core`, `@serfab/cadre-host` built (the
orchestrator resolves the real `cadre-cli` bin via its `exports` map → `dist/bin/cadre.js`).

- **Requester authority up** (a real `cadre-cli --owner` child = the "phone", party `P`).
  Its owner **public** key (base64url, via `ed25519KeyPairFromLibp2p(identity).publicKeyB64`)
  and dialable multiaddrs become the donation's `ownerKeys` + `bootstrapNodes`.
- **Host donates** (`provision`) → donated node comes up `awaiting_seed`, registered in
  party `P` (not a host party).
- **`getPeer`** → the donated node's real `12D3Koo…` peerId + multiaddrs (polled — startup
  lags).
- **Requester seeds it** (`OwnerNodeClient.addDrone` → `{ encodedSeed }`, the already-landed
  admin route) and **`applySeed` → `peersAdded ≥ 1`**. *This is the load-bearing assertion*:
  a cold donated node accepts the requester-signed seed **only** because the requester's
  owner key was pinned via `CADRE_OWNER_KEYS` (the orchestrator pin-wiring). No pin ⇒
  `success:false` forever ⇒ the poll times out.
- **Sync** → donated node reports party `P` + a live control connection (`/status`).
- **`terminate`** → node handle + workdir released; donation record → `terminated`.

## Known gaps & things to probe (your tests are a floor)

- **`DonationService` has no dedicated unit tests** (see above). If you want confidence in
  the error paths (`not_found`, `invalid_state`, denial→code mapping, reclaim-on-failure),
  they are not covered yet — the integration test only walks the happy path.
- **Env pin not directly asserted.** Step 2 does **not** read the spawned child's
  `CADRE_OWNER_KEYS` env (it isn't observable post-spawn — it's not written into `cadre.json`,
  only passed to `spawn`). The pin's *effect* is asserted at step 5. The env threading itself
  is unit-covered in the cadre-host orchestrator suite. If you want a direct assertion,
  that's a real gap.
- **Step 6 connection assertion is coarse.** It passed in ~12ms, i.e. the donated node was
  *already* connected to the requester (very likely via its control-network **bootstrap**
  dial during startup, independent of the seed). So step 6 confirms "in party `P` + a live
  peer", but does **not** isolate "the connection came from applying the seed." Step 5
  (`peersAdded ≥ 1`) is the real trust proof; step 6 is corroboration. Not wrong — just be
  aware it's not a tight seed-caused-the-connection assertion.
- **Real-libp2p flakiness.** Green and fast this run (19s), but two real children + control
  DBs are inherently timing-sensitive. Timeouts are generous (`STARTUP_MS` 90s, `OP_MS` 30s)
  and everything polls via `waitUntil`, but a slow CI box could still surface flake. Treat a
  single green run as a floor.
- **`provisionTail` map grows unbounded** (one entry per grant token, never evicted). Tagged
  `// NOTE:` at the site in `donation-service.ts`. A tripwire, not a bug — fine at household
  scale; if grant counts ever grow large, evict the tail once it resolves.

## Review findings

- Noticed: `vitest.config.ts` still uses `test.poolOptions.forks.singleFork`, which Vitest 4
  **removed** (it prints a `DEPRECATED … poolOptions was removed` warning and moved these to
  top-level). Consequence: the intended *sequential, single-fork* run may no longer be
  applied, so integration suites could run in parallel and collide on ports. Pre-existing
  (not in my diff), and my scenario is isolated by a **dedicated** port band (19900–20199,
  distinct from the owner-node suite's 19600–19899), so it is unaffected — but a general
  cross-suite port-collision risk. Parked here as an observation (config-level, no single
  code site); not filed as a ticket since all suites currently pass.
- Noticed: `DonationService.provisionTail` unbounded growth — parked as a `// NOTE:` code
  comment at the site in `donation-service.ts` (household-scale tripwire).
- Noticed: `DonationService` currently lacks dedicated unit tests — parked as remaining work
  on `2-donation-service` (its Phase 2 test list), not re-filed here.
