description: Review the new integration test proving that a workspace created on one machine really arrives — physically, and readable offline — on a second machine added to the account later.
files: packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts
----

# Review: late-cadre-join scenario (`strand-late-cadre-join.integration.ts`)

## What was built

**One new scenario file**, `packages/integration-tests/src/scenarios/strand-late-cadre-join.integration.ts`,
two tests sharing a local bring-up (`bringUpLateJoin`):

- **Test 1 — the strand follows the newcomer.** Founder (storage profile, own owner) creates
  an open strand, publishes it, writes five `App.Data` rows while provably alone (zero
  control connections asserted at that instant), and the pre-join strand block index is
  snapshotted. A newcomer is then enrolled through the production membership path (vouch
  before start, `createSeed`/`applySeed`, `pinnedOwnerKeys`, membership asserted both ways
  with `isMember`/`isAuthorizedMember`), discovers the strand via its own watcher's
  `strand:discovered` event (row equality asserted), joins with **that** row — no test-side
  strand dial anywhere — and the strand mesh forms from the strand-addr RPC seed alone
  (both directions, with founder strand-peer-id ≠ control-peer-id as the anti-vacuity
  guard). Phase 3 proves the physical claim on **raw stores only** (never the newcomer's
  database): full founder⊆newcomer coverage, then every pre-join block id individually
  present. Phase 4a: founder stopped, newcomer reads all five rows at zero strand
  connections. Phase 4b: newcomer cold-restarted on the same capture and key, alone;
  `queryStrands()` still names the strand from its own control store; `addStrand` with the
  locally-held row; all five rows read again at zero connections (asserted before AND
  after the read).
- **Test 2 — declining sibling holds nothing.** Same bring-up; newcomer sees
  `strand:discovered` but never calls `addStrand`. After a five-watcher-poll quiet window:
  no strand-scoped store exists (`scopes()` logged, `forStrand` throws
  `BlockStoreProbeError`), `getStrands()` empty, no `strand:started`/`strand:error`
  events, and the founder's strand store is non-empty (anti-vacuity).

**One harness change**, `harness/node-fixtures.ts`: `ControlNodeOpts.storageProvider?:
RawStorageProvider`, wired verbatim into `controlNodeConfig`'s `storage.provider`;
throws when combined with `storageOpDelayMs` (two answers to the same question). All
existing callers unaffected (option absent → default `() => new MemoryRawStorage()`).
This is the seam `harness-one-node-config-builder` needs.

## Measurements and run tally

- **Pre-join block count: 6, every run** (`optimystic/schema`, `default/Data`, four
  hash-named blocks). Floor pinned at **4**. Much smaller than the closed-strand file's
  ~18-29 because the open strand seats no membership bootstrap rows and the schema is one
  table — not a red flag.
- **Run tally: 6/6 green** (both tests each run), plus neighbours once each after the
  harness change: `strand-unpublish-sibling-convergence`, `strand-addr-seed-convergence`,
  `websocket-chat` — all green. Logs: `tickets/.logs/strand-late-cadre-join.test.log`,
  `…neighbours.log`.
- **`bug-strand-join-dies-on-missing-block` did NOT reproduce** in any of the 6 joins
  (its rate is ~1 in 9, so 6 clean joins is unremarkable — the addStrand call is wrapped
  to report the `strand:error` tally if it ever fires).
- Typecheck and full `yarn lint` clean.

## Deviations from the ticket, and known gaps (reviewer: treat as starting points)

- **Bring-up returns the founder's strand store only**, not "both strand stores" as the
  ticket's TODO phrased it — the newcomer's strand-scoped store cannot exist before
  `addStrand` (its non-existence is Test 2's whole claim). Test 1 obtains it right after
  the join.
- **Phase 4b's `queryStrands()` read is not gated on control-store coverage** before the
  newcomer stops. It relies on the control-network backfill completing during the several
  seconds of Phases 2-4a (debounce ~1 s), which held 6/6. If it ever flakes, the fix is a
  raw-store coverage poll of `capture.provider('control')` stores before `newcomer.stop()`
  — never a read through the restarted node before the assertion.
- **No direct strand-addr RPC pre-check** (the `collectStrandAddrs` probe
  `strand-addr-seed-convergence` does before joining). The file header tells a future
  debugger to add it if the Phase 2 mesh wait times out; as written, a responder-side RPC
  failure and a discovery failure both present as that timeout.
- **Test 1 does not pin exact lifecycle-event arrays** (the unpublish scenario asserts
  `events.started` etc. exactly). Here the started instance is asserted via
  `status === 'active'` and the discovered row via equality; extra spurious events would
  go unnoticed in Test 1 (Test 2 does assert `started`/`errors` empty).
- **Test 2's quiet window starts after `strand:discovered`**; the structural guards
  (`scopes()`, `getStrands()`, `forStrand` throwing) carry the claim — the window only
  gives a background launch time to betray itself.

## How to validate

```
yarn workspace @serfab/integration-tests test src/scenarios/strand-late-cadre-join.integration.ts
```

Run it more than once — a single green run of a backfill scenario proves little
(`control-offline-read-after-restart.integration.ts:30-32`). ~31 s per run.
