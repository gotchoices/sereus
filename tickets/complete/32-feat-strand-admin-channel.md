description: The local manager app can now list the shared networks a party belongs to, and leave one, over the owner node's private channel — with an extra confirmation step before leaving a network whose membership key would be destroyed.
files: packages/cadre-cli/src/server/admin-server.ts, packages/cadre-cli/test/admin-server.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-control-replication.spec.ts, docs/cadre-host.md, docs/architecture.md
----

# Complete: `strands` resource on the node admin channel

Node-side half only. The manager-side API (`feat-cadre-host-strand-api`) and the owner-facing
screen (`feat-cadre-host-strand-removal-screen`) remain separate tickets.

## What shipped

### `packages/cadre-core/src/cadre-node.ts`

- `getControlConnectionCount(): number` — public read of open control-network connections.
  0 connections ⇒ a control write commits local-only.
- The private `committedAlone()` write-while-alone seam now *calls* it instead of repeating
  the expression under a "change one, change both" comment.

### `packages/cadre-cli/src/server/admin-server.ts`

- `AdminErrorCode` gained `confirmation_required` → **428**.
- Exported response types `AdminStrandSummary`, `AdminStrandList`, `AdminStrandRemoval` for the
  manager-side ticket to consume.
- `route()` gained a `strands` branch (GET list, DELETE remove) plus four module-level helpers
  below the class: `requireControlDatabase`, `projectStrands`, `listStrands`, `removeStrand`.
- `decodePathSegment` — every addressable id now decodes through it.

| Route | Outcome |
|---|---|
| `GET /admin/strands` | `{ strands: {id,type,running,status}[], controlConnections }` from `ControlDatabase.queryStrands()` with running instances overlaid. No forced poll. `MemberPrivateKey` never projected |
| `DELETE /admin/strands/:id` — absent row | 200, `{ published:false, removed:false, type:null }`, no write |
| `DELETE` — `type='o'` | 200, `removed:true`, write issued (confirm accepted and ignored) |
| `DELETE` — `type='c'`, no/bad confirm | **428 `confirmation_required`**, **no write** |
| `DELETE` — `type='c'`, `confirm=1`/`true` | 200, `removed:true`, write issued |
| blank id | 400 `bad_request`, before any read |
| id as one segment, `/` percent-encoded (`ns%2Fstrand`) | addressed normally |
| id with a literal `/`, or a malformed `%` escape | 400 `bad_request` |
| no control database | 503 `not_ready` |

## Review findings

Reviewed the implement diff (`884c69a`) first, then the handoff. Everything below was found by
reading the diff and the code it touches; all fixes are in this pass and the suite is green.

### Fixed in this pass (minor)

- **A malformed percent-escape answered 500.** `route()` called `decodeURIComponent` on the id
  segment; `DELETE /admin/strands/%ZZ` threw `URIError: URI malformed`, which `classifyError`
  could only bucket as `internal`. A caller's typo was being reported as a node fault, on every
  addressable resource (`members`, `authorized-members`, `strands`). Now routed through
  `decodePathSegment`, which converts it to `bad_request`/400. Test added.
- **The slash refusal and its docs were wrong about what is addressable.** `URL.pathname` leaves
  `%2F` encoded, so a percent-encoded id survives the segment split and `decodePathSegment`
  restores it — `DELETE /admin/strands/ns%2Fstrand` removes `ns/strand` today. Only a *literal*
  slash arrives as extra segments. The 400 message said such ids "are not addressable over this
  channel; use `cadre strand remove`", and `docs/cadre-host.md` said the same. Both now say the
  id must be one path segment with `/` percent-encoded as `%2F`. Two tests added: the encoded id
  round-trips to `unpublishStrand('ns/strand')`, the literal one is still refused.
- **`committedAlone()` duplicated the new accessor's expression**, held in sync by a comment.
  It now calls `getControlConnectionCount()`. AGENTS.md prefers composition over comment blocks,
  and this is the exact shape the comment was compensating for.
- **`AdminStrandRemoval.alone` was documented as "sampled right after the write"** but is
  sampled on every call, including one that found no row and wrote nothing (the handoff flagged
  this as unresolved). No behaviour change — the field is truthful either way — but the type doc
  and the route table now say when it means "your delete may not have travelled" (`removed` also
  true) and when it only means "this machine sees no siblings".
- **`getControlConnectionCount()` had no cadre-core test** (handoff gap). Closed:
  `cadre-node-control-replication.spec.ts` already has the control-node fake, so three tests
  landed there — 0 on a node that never started, the live count, and agreement with the
  write-while-alone queueing seam that now depends on it.
- **Test gaps closed** in `admin-server.spec.ts`: empty strand list, `DELETE /admin/strands`
  with no id (400, no write), plus the two encoding tests above. 206 → 210 tests.

### Filed as arms on an existing ticket (not new tickets)

`grep` over the board found `tickets/implement/32.3-feat-cadre-host-strand-api.md` already owns
both sites, so per the workflow rules the arms were appended there rather than filed fresh:

- Its "strand ids containing `/`" design note repeated the incorrect limitation above. Corrected
  in place, with the additional requirement that `OwnerNodeClient` must `encodeURIComponent` the
  id — otherwise an id containing `/`, `?` or `#` corrupts the admin URL.
- **No real node appears anywhere in this diff** (handoff's own first gap): every strands test
  drives a `MockNode` whose `getControlDatabase()` is a two-method fake. A new Phase 5 asks for
  two cheap cases in `cadre-host-owner-node.integration.ts` — `listStrands()` on a fresh party,
  and a removal of a never-published id — which need no formation flow and prove the projection
  and envelope against a real `ControlDatabase`. Deliberately *not* done here: the natural driver
  is `OwnerNodeClient`, which that ticket builds. The closed-strand gate stays mock-only until a
  real closed strand exists (formation), and the arm says so instead of implying coverage.

### Tripwires parked (conditional — not tickets)

- `admin-server.ts`, `removeStrand` doc: the "closed strand needs confirmation" rule now lives
  in two places — here and `planRemove` in `src/commands/strands.ts`. Each is shaped by its own
  output (exit codes and warning prose there, HTTP codes here), and the rule is one comparison on
  `Type`, so duplication is cheaper than a shared abstraction today. `NOTE:` records that if the
  strand types or the gate grow, the decision should be hoisted rather than edited twice.
- `admin-server.ts`, `projectStrands` doc: the pre-existing `NOTE:` from the implement pass (a
  running instance with no control row is invisible to the list) was re-read and left as-is —
  still correct, still conditional on orphans appearing in the field.

### Checked, nothing found

- **Secret containment.** `projectStrands` names its four fields rather than spreading, and both
  routes are asserted against the raw response *text* for the `MemberPrivateKey` field name and
  its value. `queryStrands()` does pull the secret into process memory (it selects the column for
  all callers), but it never crosses the process boundary; narrowing that shared query would be
  scope creep for no reachable gain, so it was left.
- **Auth.** Both routes sit behind the same bearer check as every other route; both have a 401
  test, and the DELETE 401 test asserts no write happened.
- **Error handling / resource cleanup.** A missing control database throws `not_ready` explicitly
  instead of null-dereferencing into `internal`; an `unpublishStrand` rejection passes its message
  through intact. No new handles, timers, or listeners are opened by either route.
- **Type safety.** No `any` in the diff; the exported response types are concrete and the
  `'o' | 'c'` union matches `StrandRow`.
- **`removed: true` is "this call issued the delete", not "the row is gone."** Re-read the
  non-atomic read→write window the handoff flagged. It is the same window `applyRemove` documents
  and the honest answer for a caller who asked for the row to be gone; no fix, and no test, since
  there is no seam to interleave a concurrent removal through. Documented on the type.
- **Source size.** `admin-server.ts` is 490 lines (`wc -l`) with `route()` at ~120; the strands
  branch follows the existing per-resource `if` chain rather than inventing a second dispatch
  style. Judged acceptable rather than silently ignored — a split is worth doing when a resource
  lands that needs sub-routing, not for this one.
- **Docs beyond the diff.** `docs/STATUS.md` mentions `/admin/invites` in prose but keeps no
  route inventory, and `docs/strands.md` / `docs/cadre-consistency.md` mention no admin routes, so
  neither needed an edit. `docs/architecture.md` and `docs/cadre-host.md` were both re-read
  end-to-end for the strand and admin sections and match the shipped behaviour.

### Validation

- `yarn build` — clean (the stale-build guard tripped first on a fresh checkout; rebuilt).
- `yarn lint` — exit 0.
- `yarn --cwd packages/cadre-cli test` — **16 files / 210 tests, all pass** (206 before).
- `yarn --cwd packages/cadre-core test` — 87/89 files, 1440 pass / 1 skip / **5 fail**, all the
  tracked pre-existing set: 4 in `control-revocation-reissue.spec.ts` and 1 in
  `control-revocation-replay.spec.ts`, same fingerprints as
  `tickets/.pre-existing-known.md` (`context.OwnerKey isn't a column`,
  `UNIQUE constraint failed: Revocation.*`) under
  `10-revocation-reissue-same-pk-update-unique-collision` / `10-control-revocation-reissue-test-fixes`.
  Not re-reported, not skipped, nothing loosened. No `.pre-existing-error.md` written.
- `yarn dep-check` — **exit 1**, correcting the implement handoff's "exit 0": the repo carries a
  pre-existing baseline of 14 unused files, 1 unused dependency, 68 unused exports and 1 duplicate
  export. None of them are in this diff (grepped for `admin-server`, `cadre-node.ts`, `strands.ts`
  — no hits), and `dead-code-cleanup-and-knip-gate` in `backlog/` already owns that baseline.
