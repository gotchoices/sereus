description: When a donor revokes someone's access, the machines already lent to that person now shut down too (with an opt-out), there is a direct "shut down this one lent machine" command, and the Nodes page no longer offers a Stop that silently undoes itself. Review the implementation.
architecture: docs/cadre-host.md#node-donation-the-primary-role
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/grant-service.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/server/routes/grants-admin.ts, packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/server/__tests__/grants-admin-route.test.ts, packages/cadre-host/src/server/__tests__/nodes-route.test.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/grant-service.test.ts, packages/cadre-host/README.md, docs/cadre-host.md, tickets/backlog/5.5-feat-cadre-host-donor-aware-ui.md
----

# Donated-node teardown: revoke cascades, admin terminate, Nodes-page stop refuses donated ids

## The defect that was fixed

A donated node is a child process cadre-host runs for a grantee. Before this change, once the donor revoked the grant nothing could stop such a node: the grantee's `DELETE /grants/:id` is refused (403) on a revoked grant, the Nodes page's `POST /api/nodes/:id/stop` was undone at once by the `DonationSupervisor` respawn, and no host-side route reached `DonationService.terminate`.

## What was built (maintainer decision 2026-09-28)

- **`DonationService.terminateGrant(token): Promise<string[]>`** (`donation-service.ts`). Runs on the per-grant queue shared with `provision` (field renamed `provisionTail` → `grantTail`). Terminates every record under the grant whose status is not `terminated` — `error` included, because a supervisor give-up keeps the workdir "for a later terminate" that only the (now-refused) grantee could make. Re-reads each record before terminating (stale-snapshot guard, same as `reapStaleAwaitingSeed`); best-effort per record (logs and continues); returns the ids it terminated; idempotent. Predicate `isUnterminated` is module-level beside the reap predicates.
- **Admin handlers** (`types.ts`, `grant-service.ts`): `createGrantAdminHandlers(service, donations?)`. `deleteGrant(token, { keepNodes })` revokes first (so an unknown token 404s before any teardown), then calls `donations.terminateGrant` unless `keepNodes` or no donation service is wired; returns `{ terminated }`. `terminateDonation(id)` → `donations.terminate(id)`.
  - **Deviation from the ticket text:** the ticket said `terminateDonation` should "throw a clear error when donations is absent" *and* the route should be "mounted only when a donation service is wired". I made `terminateDonation` an **optional** member of `GrantAdminHandlers`, present only when `donations` is passed, and the route mounts only when it is present. The "absent" case can't happen, so no error path is needed. Production (`bin/host.ts`) always wires both.
  - `donations` is typed `Pick<DonationService, 'terminate' | 'terminateGrant'>` (type-only import; no runtime cycle).
- **Routes** (`grants-admin.ts`): `DELETE /grants-admin/:token[?keepNodes=true|1]` → `{ ok: true, terminated: [...] }`. New `DELETE /grants-admin/donations/:id` → `{ ok: true }`. An unknown id is a `DonationError('not_found')` → 404 via the existing error handler. The header comment is updated.
- **`server/index.ts`**: passes `opts.donations` into `createGrantAdminHandlers`.
- **`POST /api/nodes/:id/stop`** (`nodes.ts`) now refuses every non-owner id with 501 `not_implemented`, the same rule start/restart already use. The shared helper is renamed `startRestartFallback` → `ownerOnlyFallback`. The 501 message names `cadre-host grant terminate <id>` / `DELETE /grants-admin/donations/<id>`. A donated node's containerId is its donation id, so the Nodes-page id is what terminate takes. The owner node's stop still works; an unknown id still 404s. Small cleanups in the same file: a `notFound` helper replaces four copies of the 404 block, and `FastifyReply` is now imported instead of the inline `import('fastify')` type.
- **CLI** (`bin/host.ts`): `grant revoke <token> [--keep-nodes]` prints `revoked grant: <token>` plus `terminated N donated node(s)` or `existing donated nodes left running`. New `grant terminate <donation-id>`. Both use a new `adminDelete(base, path)` helper: exit 2 when unreachable, exit 1 on a non-OK response.
- **UI**: no code change. I read `NodeDetail.svelte`'s `postAction`: a failed POST becomes an error toast with the server message and code, so a donated node's Stop now shows the 501 message instead of failing silently. I did not check this in a browser. Hiding or relabelling the buttons is appended as an arm to `backlog/feat-cadre-host-donor-aware-ui`, which the ticket named as the place for it.
- **Docs**: README § *Manage grants*, the `grant revoke` / new `grant terminate` reference entries, the `/grants-admin` and `/api/nodes` route bullets, and the Nodes-page bullet. In `docs/cadre-host.md`: the admin-surface bullet plus a new "Revoking a grant shuts down its nodes" bullet, the give-up "later `terminate()`" sentence, the CLI summary, and the API table. I merged the stop row and the old start/restart row into one `/api/nodes/:id/{start,stop,restart}` row, because the old start/restart row ("Lifecycle stub — v1 has no auto-spawn path") was already wrong: owner start/restart work.

## Tests

- `donation-service.test.ts` › `DonationService.terminateGrant` › *terminates every unterminated donation under the grant, error included, and leaves other grants alone*. It covers a seeded record, an `error` record, an already-terminated record (not re-terminated or returned) and another grant's record (untouched). It also checks the returned ids and which children were removed.
- `grants-admin-route.test.ts`: the file-level setup now wires a `DonationService` over `FakeOrchestrator`, as production does. There are three new tests:
  - revoke terminates the grant's live donation and returns its id;
  - `?keepNodes=true` revokes but leaves the node `awaiting_seed` with nothing stopped;
  - `DELETE /grants-admin/donations/:id` ends one node under an already-revoked grant (this is the `--keep-nodes`-then-terminate case) and leaves its sibling running, and an unknown id 404s.
- `nodes-route.test.ts`: the old "stop calls orchestrator and publishes one event" test on the non-owner `alice` is replaced by *stop on a non-owner (donated) node returns 501 and stops nothing*, which also checks the message names `cadre-host grant terminate alice`. The one-event regression guard moved to the owner `describe` as *stop calls the orchestrator and publishes exactly one event via the listener*. The now-unused bus wiring was removed from the first `describe`.
- `grant-service.test.ts`: the two existing `deleteGrant` calls were updated for the new signature. No new test there.

## Validation run

- `yarn workspace @serfab/cadre-host typecheck`: clean.
- `yarn workspace @serfab/cadre-host test`: 68 files, 662 passed, 4 skipped.
- `yarn lint`: clean.
- The stale-build guard first refused the run because `@serfab/cadre-core`'s dist was older than its (clean, committed) src. I ran `yarn workspace @serfab/cadre-core build`. That is a workspace package in this repo, not a sibling.
- I checked the CLI by hand. After `yarn workspace @serfab/cadre-host build:server`, I ran the built `dist/bin/host.js` against a stub HTTP server. `grant revoke` → `DELETE /grants-admin/tok` and printed `terminated 2 donated node(s)`, exit 0. `--keep-nodes` → `?keepNodes=true` and printed "left running". `grant terminate grn_x` → `DELETE /grants-admin/donations/grn_x`, exit 0. A 404 → exit 1 with the body on stderr. There is no automated CLI test for these commands; `cli-invite.smoke.test.ts` covers only `trust`/`invite`.

## Known gaps / things for the reviewer to push on

- **No test pins the per-grant serialization of `terminateGrant`.** I could not find a reachable interleaving where dropping the queue changes the end state. The caller revokes first, so a provision that has not yet run its synchronous validate-and-write is refused. One that has written its `provisioning` row is either terminated by the cascade, or its own post-spawn re-read sees `terminated` and reclaims the child. A test would pass with or without the queue, so it would pin nothing. The queue is kept as the ticket designed it; judge whether it earns its place.
- **Partial teardown is not reported as an error.** `terminateGrant` is best-effort, so a record whose `terminate` throws is only logged (the `debug` channel `cadre:host:donation-service`). The admin sees a smaller `terminated` count, not a failure. `terminate` itself rarely throws: `safeStop` and `safeReclaim` swallow errors, so what's left is a `donations.json` write failure. Re-running revoke is the recovery path, and the README says revoking again is safe.
- **Revoke runs its teardown synchronously in the HTTP request.** The request awaits one stop-and-reclaim per node. That is fine at household scale (a handful of nodes per grant). With many nodes per grant the CLI call would get slow.
- `isOwnerNode('owner')` is true even when no owner handle exists, so `POST /api/nodes/owner/stop` on a donor-only install still 404s through `resolveDockerId`, as before.
