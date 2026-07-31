---
description: A borrowed node that finished joining at the same moment the host shut its loan down used to undo the shutdown and bring the ended loan back to life; the shutdown now wins. Review the fix.
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, docs/cadre-host.md
difficulty: medium
---

# An ending that lands mid-`applySeed` / mid-`provision` now wins

Same class of bug `respawn` was fixed for in `tickets/complete/respawn-succeeds-after-loan-terminated.md`.
`DonationStore.put` replaces a whole row, so any method that reads a record, `await`s something slow,
then writes back a row built from the **entry-time** copy discards whatever landed during the wait.
When what landed was the borrower ending the loan, the ending got undone and the dead loan kept
counting against the lender's node quota.

Three sites fixed, all in `packages/cadre-host/src/donation/donation-service.ts`. The rule applied at
each: **re-read after the slow `await`, decide against what is actually on disk, and let no `await`
sit between that read and the write** — `DonationStore` is synchronous, so a read-decide-write pair
with no `await` inside it cannot be interleaved. Merge forward only the fields the operation itself
produced.

## What changed

### `applySeed` — result type split, then re-read

`DonationSeedResult` used to do double duty: it was both the node's `POST /seed` response body
(`res.json()` was cast to it) and the service's own result. Now:

- `NodeSeedResponse` (module-private) is the wire body.
- `DonationSeedResult` is a discriminated union mirroring `RespawnResult`:
  `{ outcome: 'seeded'; peersAdded }` | `{ outcome: 'rejected'; error? }` | `{ outcome: 'abandoned'; status? }`.

`SEEDABLE_STATUSES` (`awaiting_seed` | `seeded`) is a new module constant checked on both the entry
guard and the post-`fetch` re-read. Deliberately **not** folded into `RESPAWNABLE_STATUSES` — the
respawn review kept `RESPAWNABLE_STATUSES` / `SUPERVISED_STATUSES` / `LIVE_STATUSES` separate because
they answer different questions, and "may this record be marked seeded" is a fourth.

Nothing is cleaned up on the `abandoned` path here (unlike respawn/provision): the record named its
`dockerId` the whole time, so the ending's own `terminate` already stopped and reclaimed the child.

### `provisionLocked` — narrow `try`, guarded abandon, guarded failure write

The single big `try` was split so the abandon decision is no longer swallowed by the failure `catch`:

- a narrow `try` around `createContainer` only;
- an `await`-free re-read + `safeReclaim(result.dockerId)` + typed throw (`invalid_state` if the
  record went terminal, `not_found` if it vanished) on the abandon path;
- a targeted `try` around the `awaiting_seed` `put`.

`provision` **throws** rather than returning an outcome union: its caller is the request that is
*creating* the thing, so there is no successful shape to report, and the HTTP layer already maps
`invalid_state` → 409 / `not_found` → 404.

New private `markProvisionFailed(id, message)` mirrors `storeAttempt`: re-read, and write
`status: 'error'` **only if** the record is still `provisioning`. Both `error` writes route through
it, so a host fault can no longer overwrite the borrower's own `terminated`, and a row deleted
mid-spawn is no longer recreated. Best-effort (logs, never throws) so it cannot mask the orchestrator
error being unwound.

### Caller updates

- `PUT /grants/:id/seed` (`server/routes/grants.ts`) switches on the outcome: `seeded` → 200,
  `rejected` → 502 `seed_failed`, `abandoned` with a status → **409 `invalid_state`**, `abandoned`
  without one → **404 `not_found`**. Both codes already mapped to those statuses in
  `server/error-handler.ts`; nothing there was touched.
- `packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts` step 4–5 polls
  on `result.outcome === 'seeded'` instead of `result.success === true`.
- `donation/index.ts` and `src/index.ts` re-export `DonationSeedResult` unchanged by name (shape
  changed). Nothing else in the monorepo references the type — re-verified by grep.

## Use cases to test / validate

The interleavings that were reproduced as failing on `master` at e2930e4, all now covered by unit
tests. Each is driven by running the concurrent operation *inside* the slow call: a stubbed
`globalThis.fetch` for the seed window, `FakeOrchestrator.onCreate` for the spawn window.

| interleaving | required behaviour | test |
| --- | --- | --- |
| `terminate` inside `applySeed`'s `fetch` | `{ outcome: 'abandoned', status: 'terminated' }`; record stays `terminated` with `dock_1`; `liveNodeCount` 0 | `donation-service.test.ts` → *lets a borrower terminate that lands mid-seed win* |
| stale-seed reap inside `applySeed`'s `fetch` | same, and `updatedAt` stays at the reap's stamp (TTL clock not restarted) | *lets a stale-seed reap that lands mid-seed win…* |
| record deleted inside `applySeed`'s `fetch` | `{ outcome: 'abandoned' }` with no `status`; no row recreated | *abandons with no status when the record vanishes mid-seed* |
| `terminate` inside `provision`'s `createContainer` | rejects `invalid_state`; record stays `terminated`; `orch.removed` = `['dock_1']`; `liveNodeCount` 0 | `provision` → *lets a borrower terminate that lands mid-spawn win…* |
| `terminate` mid-spawn **and** `createContainer` then throws | rejects `orchestrator_error`; record stays `terminated`, **not** rewritten to `error` | *does not rewrite a terminated record as error…* |
| record deleted mid-spawn | rejects `not_found`; child reclaimed; no row recreated | *reclaims the new child and recreates nothing…* |
| ending mid-seed over HTTP | `PUT /grants/:id/seed` answers **409 `invalid_state`**, not 200 | `grants-route.test.ts` → *answers 409 invalid_state when the loan ends…* |

Plus the previously-missing ordinary paths: `applySeed` happy path (`{ outcome: 'seeded', peersAdded }`,
record `awaiting_seed` → `seeded`), node-rejects-the-seed (`{ outcome: 'rejected', error }` with the
stored row asserted byte-identical to before via `toEqual(before)`), and the entry guard refusing a
`terminated` loan.

`donation-service.test.ts`'s header comment was rewritten — it previously claimed `applySeed`'s happy
path was untestable there.

## Validation run

From `packages/cadre-host`:

- `yarn vitest run src/donation src/server` → **16 files, 169 passed** (baseline at e2930e4 was
  16 files / 159 passed — the 10 new tests above).
- `yarn test` → **58 files, 506 passed, 4 skipped**.

From the repo root:

- `yarn typecheck` → clean. **Note:** it fails against a stale `packages/cadre-host/dist` because
  `integration-tests` resolves `@serfab/cadre-host` types from the built package, not source. Run
  `yarn build` in `packages/cadre-host` first (that is what was done here). Not a new coupling, but
  worth knowing before diagnosing a red typecheck.
- `yarn lint` → **0 errors**. Six pre-existing warnings, all "unused eslint-disable directive" in
  `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts` — unrelated to
  this diff, untouched.

## Known gaps — read before signing off

- **The integration scenario was not run.** `cadre-host-node-donation.integration.ts` needs real
  `cadre-cli` children and exceeds the agent's runnable window; only its *types* were verified
  (root `yarn typecheck` covers it). Its step 4–5 edit is a mechanical `success`/`peersAdded` →
  `outcome` swap, but nobody has watched it go green. Leave it to CI.
- **`docs/cadre-host.md` — prose generalised, ASCII diagram not.** The § Respawn paragraph
  "**An ending that lands mid-respawn wins**" was rewritten to "**An ending that lands mid-operation
  wins**" with a three-bullet breakdown covering `respawn` / `applySeed` / `provision`. The step-1..5
  lifecycle diagram above it still shows only the success arrows (`◀──── { peersAdded }` at step 4) —
  accurate but not showing the new 409/404 answers. Judge whether that is worth a diagram edit;
  § Status of the donation surface was checked and needs nothing (it lists methods, not shapes).
- **Concurrent `respawn` during `applySeed` is a knowingly-accepted ambiguity, not a fixed case.**
  Recorded as a `NOTE:` tripwire at `applySeed`'s re-read: a respawn leaves the status `awaiting_seed`
  (so the re-read's check passes) but swaps `seedEndpoint`/`seedToken`, so we would mark `seeded` a
  record whose live child is the *new* one while the seed actually went to the old endpoint. Narrow
  today — respawn only fires when the supervisor believes the child is down, in which case our
  `fetch` would have failed; and both spawns share one workdir, so the seed the old child persisted
  is on disk for the new one. Becomes real work if a second `respawn` caller appears or respawn stops
  sharing the workdir. **No test covers it** — verify the reasoning rather than the code here.
- **The tests assert against a synchronous store.** Every race test relies on `DonationStore.put`
  landing synchronously inside the stub/hook. If the store ever gains an async write path, these
  tests will pass while the invariant they guard silently stops holding.
- **`provision`'s abandon path is not serialized against a second `provision`.** Out of scope here
  (`serializeByGrant` covers the quota race, not this), but the reviewer may want to confirm the
  claim in the code comment that the ending's `terminate` really can find no `dockerId` in every
  ordering, not just the one the test drives.

## Review findings

- Tripwire parked as a `NOTE:` at `applySeed`'s re-read in
  `packages/cadre-host/src/donation/donation-service.ts`: a concurrent `respawn` passes the status
  re-read but has swapped the seed endpoint/token underneath us. Conditional, not wrong today —
  see the gap bullet above for why, and for what would make it real.
