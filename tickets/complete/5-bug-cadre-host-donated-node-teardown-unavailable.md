description: When a donor revokes someone's access, the machines already lent to that person now shut down too (with an opt-out), there is a direct "shut down this one lent machine" command, and the Nodes page no longer offers a Stop that silently undoes itself.
architecture: docs/cadre-host.md#node-donation-the-primary-role
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/grant-service.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/server/routes/grants-admin.ts, packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/server/__tests__/grants-admin-route.test.ts, packages/cadre-host/src/server/__tests__/nodes-route.test.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/grant-service.test.ts, packages/cadre-host/README.md, docs/cadre-host.md, tickets/backlog/5.5-feat-cadre-host-donor-aware-ui.md
----

# Donated-node teardown: revoke cascades, admin terminate, Nodes-page stop refuses donated ids

## The defect

A donated node is a child process cadre-host runs for a grantee. Once the donor revoked the grant nothing could stop such a node: the grantee's `DELETE /grants/:id` is refused (403) on a revoked grant, the Nodes page's `POST /api/nodes/:id/stop` was undone at once by the donation supervisor's respawn, and no host-side route reached `DonationService.terminate`.

## What landed (`ticket(implement): bug-cadre-host-donated-node-teardown-unavailable`)

- `DonationService.terminateGrant(token)` terminates every record under a grant whose status is not `terminated` (`error` included, since a supervisor give-up keeps the workdir for a later terminate that a revoked grantee can no longer make). It runs on the per-grant queue shared with `provision` (`grantTail`), re-reads each record before terminating it, is best-effort per record and idempotent, and returns the ids it terminated.
- `createGrantAdminHandlers(service, donations?)`: `deleteGrant(token, { keepNodes })` revokes first (unknown token → 404 before any teardown), then runs the teardown unless `keepNodes`. `terminateDonation(id)` is present only when a donation service is wired, and the route mounts only then.
- Routes: `DELETE /grants-admin/:token[?keepNodes=true|1]` → `{ ok, terminated }`; `DELETE /grants-admin/donations/:id` → `{ ok }`, unknown id 404.
- `POST /api/nodes/:id/stop` refuses every non-owner node with 501 `not_implemented`, as start/restart already did, and the message names `cadre-host grant terminate <id>`.
- CLI: `grant revoke <token> [--keep-nodes]` and `grant terminate <donation-id>`, sharing an `adminDelete` helper (exit 2 unreachable, exit 1 non-OK).
- Docs: README (*Manage grants*, command reference, route list, Nodes page) and `docs/cadre-host.md` (admin surface, revoke-cascade bullet, give-up sentence, CLI summary, API table).
- Hiding or relabelling the Nodes-page buttons for donated nodes is appended as an arm to `backlog/feat-cadre-host-donor-aware-ui`.

## Review findings

Checked by reading the implement diff first, then `DonationService.terminate` / `provisionLocked` / `respawn` / `abandonRespawn`, the orchestrator's `getNode` / `resolveDockerId` / `isOwnerNode`, the error handler's `DonationError` mapping, the grantee `DELETE /grants/:id` route, `NodeDetail.svelte`'s `postAction`, and every doc line the change touches (plus a grep for stale "cannot be torn down" / "honest-gap" claims — none remain).

- **Correctness — fixed inline (minor).** The Nodes-route 501 message named the route parameter. `getNode` / `resolveDockerId` accept either the donation id or the orchestrator's opaque `pid:token` dockerId, so a caller hitting the route with the dockerId was told to run `cadre-host grant terminate <pid:token>`, which 404s. `ownerOnlyFallback` in `nodes.ts` now names `node.id` (the containerId, which for a donated node is the donation id). The UI passes `node.id`, so it was not hit from the page; no new test, since the existing 501 test uses the containerId and the fix is a one-token change on a path with no branching.
- **Race between revoke and provision — checked, no defect.** Traced the three orderings: a provision queued behind the teardown is refused by `provisionLocked`'s grant re-check; one ahead of it finishes and is then terminated; without the queue a mid-spawn `provisioning` record is terminated, its workdir reclaimed, and `provisionLocked`'s post-spawn re-read reclaims the child. The end state is the same with or without the queue, as the implementer said. The queue is kept — it costs nothing and makes the teardown's snapshot complete rather than relying on the re-read — and no test pins it, because none could fail without it.
- **Supervisor respawn during teardown — checked, no defect.** `terminate` writes `terminated` before stopping, and `abandonRespawn` reclaims a child whose record went `terminated` mid-respawn.
- **Admin terminate of an already-terminated donation — considered, not changed.** `terminate` re-stamps `updatedAt` and repeats best-effort stop/reclaim (no-ops). Same behaviour as the grantee's existing path; harmless.
- **Partial teardown reported as a smaller count, not an error — accepted as designed.** `terminate` throws only on a `donations.json` write failure (stop/reclaim swallow their errors); the failure is logged and re-running revoke is the documented recovery.
- **Teardown runs synchronously in the revoke request — tripwire.** Parked as a `NOTE:` in `createGrantAdminHandlers.deleteGrant` (`grant-service.ts`).
- **Owner-only stop — noted, out of scope.** `isOwnerNode('owner')` is true with no owner handle; stop then 404s via `resolveDockerId`, as before.
- **Tests.** The four new/moved tests each pin a stated contract (cascade scope incl. `error` and other-grant isolation; `keepNodes`; single terminate under a revoked grant + 404; stop 501 on donated ids with the one-event guard moved to the owner node). None restates the implementation or verifies a mock; nothing cut, nothing added.
- **Type safety / hygiene.** No `any`; `donations` is a type-only `Pick<>` import (no runtime cycle); `notFound` helper removes four duplicated 404 blocks; comments explain constraints rather than narrate. No file-size concern introduced (`donation-service.ts` grew by ~50 lines).
- **UI.** Not checked in a browser (neither by the implementer nor here); `postAction` turns the 501 into an error toast carrying the server message, confirmed by reading.
- **CLI.** No automated test for `grant revoke` / `grant terminate`; the implementer's manual run against a stub server is the evidence. Not adding one — the commands are thin HTTP wrappers.

Validation: `yarn workspace @serfab/cadre-host typecheck` clean; `yarn workspace @serfab/cadre-host test` 68 files, 662 passed, 4 skipped; `yarn lint` clean.
