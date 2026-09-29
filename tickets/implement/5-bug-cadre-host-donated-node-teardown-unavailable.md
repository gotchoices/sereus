description: When a donor revokes someone's access, the machines already lent to that person keep running and nothing can shut them down. Make revoking also shut those machines down (with an opt-out), add a direct "shut down this one lent machine" command, and stop the Nodes page from offering a Stop button that silently undoes itself.
architecture: docs/cadre-host.md#node-donation-the-primary-role
files: packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/grant-service.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/server/routes/grants-admin.ts, packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/server/__tests__/grants-admin-route.test.ts, packages/cadre-host/src/server/__tests__/nodes-route.test.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/README.md, docs/cadre-host.md
repro: static
----

# Donated-node teardown: revoke cascades, admin terminate, Nodes-page stop refuses donated ids

## The defect (confirmed by reading the code)

A donated node is a child process cadre-host runs on behalf of a grantee. Its lifecycle is meant to be owned only by the donation surface. Today, once the donor revokes the grant, nothing can stop such a node:

- **Grantee release is blocked.** `DELETE /grants/:id` (`src/server/routes/grants.ts`) runs `authenticate()`, which calls `GrantService.validate()`; a revoked grant returns `reason: 'revoked'`, which `denyStatus()` maps to 403. So after revoke, the grantee's only teardown call is refused.
- **Nodes-page Stop does not stick.** `POST /api/nodes/:id/stop` (`src/server/routes/nodes.ts`) stops any node. The orchestrator's `onStateChange` fires, and `DonationSupervisor` (which respawns every `awaiting_seed` / `seeded` donation with a `dockerId` that is found down) brings it straight back. `start` and `restart` in the same file already refuse every non-owner id with 501; `stop` is the one inconsistent verb.
- **No host-side teardown exists.** `DonationService.terminate(id)` (`src/donation/donation-service.ts`) is correct — it writes `terminated` first, then stops and reclaims, so the supervisor never resurrects it — but the only HTTP route reaching it is the bearer-gated `DELETE /grants/:id`. `/grants-admin` (`src/server/routes/grants-admin.ts`) only does issue / list / revoke.

## Maintainer decision (2026-09-28) — the shape to build

- **Revoke cascades.** `cadre-host grant revoke <token>` and `DELETE /grants-admin/:token` terminate every donation under that grant through `DonationService.terminate`.
- **`--keep-nodes` opt-out.** CLI flag `--keep-nodes`, admin route query flag `?keepNodes=true`: revoke only, leave existing nodes running (the old behaviour).
- **Separate admin terminate route** for one donation.
- **`POST /api/nodes/:id/stop` refuses donated ids**, as `start` / `restart` already do.
- Update the `GrantService.revoke()` docstring and `docs/cadre-host.md` to match.

## Design

### `DonationService.terminateGrant(token): Promise<string[]>`

New method, the single home of the cascade (the admin handler just calls it). It:

- Runs inside `serializeByGrant(token, …)`. The caller has already marked the grant revoked, and `provisionLocked` re-validates the grant inside that same per-grant queue, so any provision already queued for the grant either finishes first (and its record is then terminated here) or runs after and is refused as revoked. Nothing provisioned under the grant can slip past the cascade. (The queue's field is named `provisionTail`; either rename it to something like `grantTail` or note at `serializeByGrant` that teardown also uses it.)
- Terminates every record from `store.listByGrant(token)` whose status is **not** `terminated` — this deliberately includes `error`. A record the supervisor gave up on keeps its workdir (identity key) and, per `docs/cadre-host.md`, is left "for a later `terminate()`"; that later call was the grantee's `DELETE /grants/:id`, which revoke now blocks. Terminating it here reclaims the workdir so nothing under a revoked grant is stranded.
- Terminates one at a time, re-reading each record first and skipping one that has since gone `terminated` (same stale-list hazard the `awaiting_seed` reap sweep guards against — see its comment near `reapStaleAwaitingSeed`).
- Is best-effort per record: a failed `terminate` is logged and the loop continues (mirror the reap sweep). Returns the ids it terminated.
- Is idempotent: running it again on an already-revoked grant terminates whatever is still non-terminal. That also gives donors whose grants were revoked before this landed a way to clean up — just revoke again (`GrantStore.markRevoked` is already idempotent).

The `GrantService` stays unaware of donations (its docstring says it is deliberately not the authority for live nodes); the cascade is composed in the admin handlers.

### Admin handlers and routes

- `GrantAdminHandlers` (`src/donation/types.ts`): `deleteGrant(token, opts: { keepNodes: boolean })` returns `{ terminated: string[] }`; add `terminateDonation(id): Promise<void>`.
- `createGrantAdminHandlers(service, donations?)` in `grant-service.ts`: `deleteGrant` calls `service.revoke(token)` (still throws `not_found` for an unknown token, before any teardown), then — unless `keepNodes` or `donations` is absent — `donations.terminateGrant(token)`. `terminateDonation` throws a clear error when `donations` is absent. When no donation service is wired (tests; nothing in production), there can be no donated nodes, so revoke-only is correct.
- `src/server/routes/grants-admin.ts`:
  - `DELETE /grants-admin/:token` reads `keepNodes` from the query string (`'true'` / `'1'` → true) and responds `{ ok: true, terminated: [...] }`.
  - New `DELETE /grants-admin/donations/:id` → `terminateDonation(id)` → `{ ok: true }`. An unknown id surfaces as `DonationError('not_found')` from `requireDonation`, which `server/error-handler.ts` already maps to 404. Mount this route only when a donation service is wired. The static `donations` segment makes it a distinct path from `/:token` (different depth), so no router conflict.
  - Update the file header (it still says the `/grants` surface "arrives in the `2-donation-service` ticket").
- `src/server/index.ts`: pass `opts.donations` into `createGrantAdminHandlers`, and into `registerNodesRoutes` only if the nodes arm below ends up needing it (the recommended rule does not).

### `POST /api/nodes/:id/stop`

Recommended rule: **refuse every non-owner id with 501**, the same rule `start` / `restart` already use (reuse `startRestartFallback`, renamed to fit three verbs). Every non-owner node this route can see is a donated node (the route no longer spawns generic nodes), so this matches the file's own stated invariant without giving the route a dependency on `DonationService`. The 501 message should point the admin at `cadre-host grant terminate <id>` / `DELETE /grants-admin/donations/:id`. The owner node keeps a working stop. Update the file's header comment ("Stop works for any running node").

A donated node's orchestrator `containerId` equals its donation id (`grn_…`, see `Donation.id` in `types.ts`), so the id shown on the Nodes page is exactly what the terminate command takes.

The UI's Nodes page (`ui/src/routes/Nodes.svelte`, `NodeDetail.svelte`) keeps its Stop button; for a donated node it now gets a 501 error instead of a silent respawn. Hiding or relabelling it is part of `backlog/feat-cadre-host-donor-aware-ui` — confirm the page surfaces the error (e.g. toast) rather than failing silently, but don't build new UI here.

### CLI (`src/bin/host.ts`, the `grant` command group)

- `grant revoke <token> [--keep-nodes]`: sends `?keepNodes=true` when given; prints `revoked grant: <token>` plus how many donated nodes were terminated (or "existing nodes left running" with `--keep-nodes`). Update the command description (it currently says "live nodes are not torn down").
- New `grant terminate <donation-id>`: `DELETE /grants-admin/donations/:id`; same error-handling shape as `revoke` (exit 2 unreachable, exit 1 non-OK).

## Tests (one per behaviour)

- `nodes-route.test.ts`: the existing "POST /api/nodes/:id/stop calls orchestrator and publishes exactly one event" test stops the non-owner sample node `alice`; that becomes a 501 (and nothing stopped). Keep the event-publishing coverage by moving it onto the owner node in the owner `describe` block.
- `donation-service.test.ts` (uses `fake-orchestrator.ts`): `terminateGrant` terminates every non-`terminated` record under the grant (include one `seeded` and one `error`), leaves another grant's donations alone, and returns the ids.
- `grants-admin-route.test.ts`: revoke with a wired `DonationService` terminates the grant's live donation; `?keepNodes=true` leaves it running; `DELETE /grants-admin/donations/:id` terminates one and 404s an unknown id. This file currently builds handlers from `GrantService` only — wire a `DonationService` over the fake orchestrator for the new cases.

No integration test is required; the per-layer tests above cover the new branching, and `terminate` itself is already proven end-to-end by `cadre-host-node-donation.integration.ts`.

## Docs

- `packages/cadre-host/README.md`: rewrite § *Manage grants* (around the `cadre-host grant revoke` block — currently says nodes keep running and cites `backlog/bug-cadre-host-donated-node-teardown-unavailable`), the `grant revoke` command reference (~line 283), add a `grant terminate` reference entry, the `/grants-admin` routes bullet (~line 360), and the Nodes-page bullet (~line 389: stop/start/restart apply to the owner node only; donated nodes are ended with `grant terminate`).
- `docs/cadre-host.md`: the admin-surface bullet (~line 70, `issue|list|revoke` → add cascade, `--keep-nodes`, `terminate`), the `/api/nodes/:id/stop` row in the routes table (~line 472: 501 for non-owner ids), and the CLI summary (~line 556).
- `GrantService.revoke()` docstring: revoke itself only marks the grant; the cascade is `DonationService.terminateGrant`, invoked by the admin handler unless `keepNodes`.

## TODO

- Add `DonationService.terminateGrant(token)` under the per-grant queue; terminates all non-`terminated` records, re-reading each, best-effort, returns ids.
- Extend `GrantAdminHandlers` / `createGrantAdminHandlers(service, donations?)` with the cascading `deleteGrant(token, { keepNodes })` and `terminateDonation(id)`.
- Update `grants-admin.ts`: `keepNodes` query flag + `terminated` in the response; new `DELETE /grants-admin/donations/:id`; refresh the header comment.
- Wire `opts.donations` into the admin handlers in `server/index.ts`.
- Make `POST /api/nodes/:id/stop` refuse non-owner ids with 501 (shared helper with start/restart); update header comment.
- CLI: `grant revoke --keep-nodes`, new `grant terminate <donation-id>`, updated descriptions.
- Tests as listed above; adjust the existing nodes-route stop test.
- Check the UI Nodes page surfaces the 501 on a donated node's Stop (no new UI).
- Update `GrantService.revoke()` docstring, README sections, and `docs/cadre-host.md` as listed.
- Run `yarn workspace @serfab/cadre-host test`, typecheck, and `yarn lint`.
