---
description: A borrowed node that finished joining at the same moment the host shut its loan down used to undo the shutdown and bring the ended loan back to life. The shutdown now wins, and the review found and fixed one more place where the same thing could happen in reverse.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/donation-store.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, docs/cadre-host.md
---

# An ending that lands mid-operation wins

`DonationStore.put` replaces a whole row. Any method that reads a record, `await`s something
slow, then writes back a row built from the **entry-time** copy discards whatever landed during
the wait. When what landed was the borrower ending the loan, the ending got undone and the dead
loan kept counting against the lender's node quota — the same class of bug `respawn` was fixed
for in `tickets/complete/respawn-succeeds-after-loan-terminated.md`.

The rule applied at every site: **re-read after the slow `await`, decide against what is actually
on disk, and let no `await` sit between that read and the write** — `DonationStore` is
synchronous, so a read-decide-write pair with no `await` inside it cannot be interleaved. Merge
forward only the fields the operation itself produced.

## What shipped (implement stage)

- **`applySeed`** — result type split. `NodeSeedResponse` (module-private) is the node's wire
  body; `DonationSeedResult` is now a discriminated union mirroring `RespawnResult`:
  `{ outcome: 'seeded'; peersAdded }` | `{ outcome: 'rejected'; error? }` |
  `{ outcome: 'abandoned'; status? }`. New `SEEDABLE_STATUSES` constant checked on both the entry
  guard and the post-`fetch` re-read. Nothing is cleaned up on the `abandoned` path: the record
  named its `dockerId` throughout, so the ending's own `terminate` already stopped and reclaimed
  the child.
- **`provisionLocked`** — the single wide `try` was split so the abandon decision is no longer
  swallowed by the failure `catch`: a narrow `try` around `createContainer`, an `await`-free
  re-read + `safeReclaim` + typed throw (`invalid_state` if the record went terminal, `not_found`
  if it vanished), and a targeted `try` around the `awaiting_seed` `put`. New private
  `markProvisionFailed(id, message)` writes `status: 'error'` **only if** the record is still
  `provisioning`, so a host fault cannot overwrite the borrower's own `terminated` and a row
  deleted mid-spawn is not recreated.
- **`PUT /grants/:id/seed`** switches on the outcome: `seeded` → 200, `rejected` → 502
  `seed_failed`, `abandoned` with a status → 409 `invalid_state`, without one → 404 `not_found`.
- Integration scenario step 4–5 polls on `result.outcome === 'seeded'`; `donation/index.ts` and
  `src/index.ts` re-export `DonationSeedResult` unchanged by name.

## What the review changed

- **Fixed (see findings): the stale-`awaiting_seed` reap sweep had the same hazard, inverted.**
  It collected candidates in one pass and then terminated them one at a time, each `terminate`
  awaiting a stop and a reclaim — so from the second record on it acted on a stale snapshot. It
  now re-reads each record immediately before terminating it, through a shared `isReapable`
  predicate applied to both the candidate list and the per-record re-check.
- Route test added for the 404 half of the abandon mapping (previously only 409 was covered).
- `DonationStore`'s class doc now states the synchronous-write invariant the service depends on.
- `docs/cadre-host.md` § "An ending that lands mid-operation wins" gained a bullet for the reap
  sweep and lost its "all three long operations" count.

## Review findings

**Checked:** the full implement diff read before the handoff summary; every re-read/write pair in
`donation-service.ts` re-derived by hand for an interleaving `await`; `donation-supervisor.ts`
(`reconcileOnce` snapshot, `giveUp`) and `donation-store.ts` swept for the same read-await-write
shape; every consumer of `DonationSeedResult` in the monorepo (route, integration scenario, two
barrel re-exports — nothing else); `docs/cadre-host.md` § Donation lifecycle, § Respawn and
§ Status of the donation surface read against the new reality.

**Found and fixed in this pass (minor):**

- `reapStaleAwaitingSeed` terminated on a stale snapshot — with two or more stale records, a
  borrower's seed (or a respawn's `updatedAt` refresh, whose stated purpose is to defer this very
  reap) landing during an earlier record's stop was ignored, and the sweep killed a loan that had
  just come good. Fixed as described above; the new test
  *leaves a loan alone when a seed lands mid-sweep…* was confirmed to fail against the
  unfixed loop before the fix was restored.
- The route's `abandoned`-without-status → 404 mapping had no test. Added.

**Found and referred elsewhere (major):** none. No defect surfaced that needed a new ticket.

**Verified rather than tested — the implement stage flagged these and asked for a reasoning check:**

- *`provision`'s abandon path versus a concurrent `terminate` in every ordering.* The claim holds.
  `terminate` is `requireDonation` → `put` with no `await` between, so it cannot interleave with
  `provision`'s own synchronous `put`. Either it runs wholly before `provision`'s re-read (record
  is `terminated`, has no `dockerId`, nothing for `terminate` to stop, and the abandon path is the
  only thing that can reclaim the child) or wholly after the post-spawn write (record names
  `dockerId`, `terminate` cleans up normally, no abandon). There is no window where `terminate`
  sees the handle *and* `provision` still abandons.
- *Concurrent `respawn` during `applySeed`.* Correctly parked as a tripwire, not fixed. The
  narrowing argument survives scrutiny with one refinement worth knowing: it depends on the
  supervisor's liveness read being *right*. If `isRunning` reports a live child as down — a
  dropped or stale handle — our `fetch` to the old endpoint can still succeed and we would mark
  `seeded` a record whose live child is the new spawn. The shared workdir still carries the seed
  the old child persisted, so the outcome is benign today. The `NOTE:` at `applySeed`'s re-read
  states the trip conditions.

**Tripwires parked (conditional; not tickets):**

- `packages/cadre-host/src/donation/donation-store.ts` class doc — the store's methods must stay
  synchronous; an async write path would silently reopen these races while the tests that guard
  them kept passing. (The implement stage raised this as a gap; its home is the store, which is
  what would change.)
- `packages/cadre-host/src/server/routes/grants.ts` at the outcome switch — exhaustive today,
  with nothing forcing it to stay so; a fourth `DonationSeedResult` variant would fall out of the
  handler as `undefined` and hang the request rather than fail to compile.
- `packages/cadre-host/src/donation/donation-service.ts` at `applySeed`'s re-read — the concurrent
  `respawn` ambiguity above (parked by the implement stage; verified, not re-parked).

**Judged and deliberately left alone:**

- *The ASCII lifecycle diagram in `docs/cadre-host.md`.* It sketches the success path only, and the
  409/404 answers are spelled out in the prose directly beneath it. Adding failure arrows would
  cost more legibility than it buys.
- *`orchestrator_error` on a `store.put` failure in `provisionLocked`.* A storage fault reported
  under an orchestrator code is a misnomer, but it predates this diff and an existing test asserts
  it. Not this ticket's to change.
- *The `status ? {...} : {...}` ternaries on the `abandoned` / `rejected` returns.* Unnecessary
  under this tsconfig (`exactOptionalPropertyTypes` is off), but they match the shape `respawn`
  already established in the same file. Consistency wins.

**Validation.** From `packages/cadre-host`: `yarn vitest run src/donation src/server` → 16 files,
**171 passed** (169 at the implement handoff, +2 from this pass). `yarn test` → 58 files,
**507 passed, 4 skipped**. From the repo root: `yarn typecheck` clean (after `yarn build` in
`packages/cadre-host` — `integration-tests` resolves `@serfab/cadre-host` types from the built
package, so a stale `dist` reads as a red typecheck); `yarn lint` → **0 errors**, 6 pre-existing
"unused eslint-disable directive" warnings in
`packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, untouched.

One `yarn test` run in this session reported 6 failures across 5 files, immediately after a
back-to-back targeted vitest invocation; three subsequent full runs — including one deliberately
repeating that same sequence — were clean, and the failures were outside this diff (a
`writeFileSync` site in a package none of these files touch). Recorded here as an observed flake
rather than filed, since it could not be reproduced and no test name was captured. Not written to
`tickets/.pre-existing-error.md` for that reason.

**Not run: the integration scenario.** `cadre-host-node-donation.integration.ts` needs real
`cadre-cli` children and exceeds the agent's runnable window. Its step 4–5 edit is a mechanical
`success`/`peersAdded` → `outcome` swap and its types are covered by the root `yarn typecheck`,
but nobody has watched it go green. Left to CI.
