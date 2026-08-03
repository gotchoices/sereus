description: The local manager app can now list the shared networks a party belongs to, and leave one, over the owner node's private channel — with an extra confirmation step before leaving a network whose membership key would be destroyed.
files: packages/cadre-cli/src/server/admin-server.ts, packages/cadre-cli/test/admin-server.spec.ts, packages/cadre-core/src/cadre-node.ts, docs/cadre-host.md, docs/architecture.md
difficulty: medium
----

# Review: `strands` resource on the node admin channel

Implements `tickets/complete/`-bound ticket 32. Node-side half only; the manager-side API
(`feat-cadre-host-strand-api`) and the owner-facing screen
(`feat-cadre-host-strand-removal-screen`) are separate tickets and are **not** touched here.

## What landed

### `packages/cadre-core/src/cadre-node.ts`

- `getControlConnectionCount(): number` — new public read-only accessor next to
  `getControlDatabase()`. Returns `this.controlNode?.getConnections().length ?? 0`, the same
  expression the private `committedAlone()` uses. Doc comment names it a *lower-bound proxy*
  for replication reach (0 connections ⇒ a control write commits local-only) and says plainly
  that both it and `committedAlone()` approximate the precise signal (the block's cluster size),
  and that sampling it after a write is a slightly wider window than `committedAlone()`'s
  sample inside the write.
- `committedAlone()`'s doc gained a back-reference so the two do not drift.

### `packages/cadre-cli/src/server/admin-server.ts`

- `AdminErrorCode` gained `confirmation_required`; `STATUS_BY_CODE` maps it to **428**.
- Three exported response types: `AdminStrandSummary`, `AdminStrandList`, `AdminStrandRemoval`
  (exported so the manager-side ticket consumes them rather than re-declaring the shape).
- `route()` gained a `strands` branch: `GET` list, `DELETE` remove, plus a `segments.length > 3`
  refusal for ids containing `/`.
- Four module-level helpers below the class rather than inline in the already-long `route()`:
  `requireControlDatabase`, `projectStrands`, `listStrands`, `removeStrand` (+ `isConfirmed`
  and the `CONFIRM_VALUES` set).
- Class doc route list and `docs/cadre-host.md` route table both updated.

Behaviour, as specified:

| Route | Outcome |
|---|---|
| `GET /admin/strands` | `{ strands: {id,type,running,status}[], controlConnections }`, listed from `ControlDatabase.queryStrands()` with `node.getStrands()` overlaid. No forced poll. |
| `DELETE /admin/strands/:id` — absent row | 200, `{ published:false, removed:false, type:null }`, no write |
| `DELETE` — `type='o'` | 200, `removed:true`, write issued (confirm accepted and ignored) |
| `DELETE` — `type='c'`, no/bad confirm | **428 `confirmation_required`**, **no write** |
| `DELETE` — `type='c'`, `confirm=1` or `confirm=true` | 200, `removed:true`, write issued |
| blank id, or id with `/` | 400 `bad_request`, before any read |
| no control database | 503 `not_ready` (explicit throw, not a null deref) |

### Docs

- `docs/cadre-host.md`: `confirmation_required` → 428 added to the error-code line; both routes
  added to the `/admin` table with the read→decide→write and closed-strand rules stated.
- `docs/architecture.md`: the `cadre strand list|remove` bullet now says the same
  read→decide→write and closed-strand gate are reachable over the admin channel, so the manager
  UI enforces the identical rule instead of reimplementing it.

## Use cases to exercise

1. **Owner lists participation.** `GET /admin/strands` on a node running one of two published
   strands: both rows appear, the running one has `running:true` + its live status, the other
   `running:false` + `status:null`. This is the case the control-DB-driven list exists for — a
   `strandFilter`-excluded or failed-to-launch strand is still removable participation.
2. **Owner leaves an open strand.** `DELETE /admin/strands/<open-id>` with no query string →
   200, `removed:true`, one `unpublishStrand` call.
3. **Owner tries to leave a closed strand.** No `confirm` → 428 and **nothing written**. This is
   the security-relevant path: the row holds the party's only copy of its membership key for
   that network. Re-send with `?confirm=1` → 200 and the write lands.
4. **Owner asks about a strand they already left.** 200 with `published:false` — the caller
   asked for it to be gone and it is gone; no 404.
5. **Isolated machine.** With 0 control connections, both routes report it: `controlConnections:0`
   on the list, `alone:true` on the removal, so the manager can warn before and after instead of
   warning unconditionally.

## Validation run

- `yarn build` — clean.
- `yarn lint` — clean (exit 0).
- `yarn dep-check` — exit 0; the three new exported types are not in the unused-exports list.
- `yarn --cwd packages/cadre-cli test` — **16 files / 206 tests, all pass** (was 183 before;
  23 new).
- `yarn --cwd packages/cadre-core test` — 87/89 files pass, **5 failures, all pre-existing and
  already tracked**: 4 in `test/control-revocation-reissue.spec.ts` and 1 in
  `test/control-revocation-replay.spec.ts`, exactly the entries in
  `tickets/.pre-existing-known.md` under `10-revocation-reissue-same-pk-update-unique-collision`
  (blocked) / `10-control-revocation-reissue-test-fixes` (implement). Same fingerprints
  (`context.OwnerKey isn't a column`, `UNIQUE constraint failed: Revocation.*`). Not re-reported,
  not skipped, nothing loosened. No `.pre-existing-error.md` written.

## Tests added (`packages/cadre-cli/test/admin-server.spec.ts`)

The mock node gained `getStrands`, `getControlDatabase` (returning a two-method fake with
`queryStrands`/`queryStrand`), `unpublishStrand`, `getControlConnectionCount`, and scriptable
knobs (`strandRows`, `strandInstances`, `noControlDatabase`, `unpublishError`,
`controlConnections`). 23 tests under `strands routes`:

- list overlays running instances; list is side-effect free (asserts no `forceStrandPoll`);
  list reports `controlConnections` from the accessor; 503 with no control DB; `GET` with an id
  is not a route; 401 without a bearer.
- **Secret leakage asserted on the raw response text** for both routes: neither the string
  `MemberPrivateKey` nor the key value appears.
- delete: open (with and without `confirm`), closed refused at 428 with `unpublishStrand`
  **not** called, closed accepted for `confirm=1` and `confirm=true` (`it.each`), closed refused
  for `yes` / `` / `0` / `on` / `TRUE` (`it.each` — note `TRUE` is deliberately refused, the
  match is case-sensitive), absent id, blank id (also asserts no `queryStrand` read happened),
  slash-bearing id (asserts the message names `cadre strand remove`), `alone:true` at 0
  connections, 503 with no control DB, rejection message passthrough, 401 without a bearer.

## Known gaps — treat as the floor, not the finish line

- **No real node anywhere in this diff.** Every strands test drives a `MockNode`. The fake
  `getControlDatabase()` returns an object with only `queryStrands`/`queryStrand`, so nothing
  here proves the projection survives a real `StrandRow` from a real `ControlDatabase`, or that
  a real `unpublishStrand` failure classifies the way the mock's does. An integration-level
  exercise against a live `cadre-cli` child (the `cadre-host-owner-node.integration.ts` shape)
  is not written. Worth a reviewer's judgement on whether that should block.
- **`getControlConnectionCount()` has no cadre-core test.** It is a one-line accessor with no
  branch beyond the `??`, and cadre-core has no existing spec that stands up a `controlNode` to
  read connections from. Exercised only indirectly, through the cadre-cli mock.
- **`removed: true` is "this call issued the delete", not "the row is observed gone."** The read
  and the write are not atomic; a concurrent removal in between makes this call a no-op that
  still reports `true`. Documented on the type, same window the CLI documents. Not tested —
  there is no seam in the mock to interleave a concurrent removal.
- **Rejection does not imply survival.** `unpublishStrand`'s local stop runs after the
  control-plane delete commits, so a throw can sit on top of a completed removal. The error path
  deliberately makes no "the strand is still there" claim; nothing asserts that absence.
- **`alone` is sampled even when no write happened** (absent-row case). Truthful — it reports the
  connection count at that moment — but a caller reading `alone` as "your delete may not have
  travelled" will over-read it on a call that deleted nothing. Not specified either way in the
  ticket; flagging rather than guessing.
- **Case sensitivity of `confirm` is a deliberate refusal, not an oversight.** `TRUE` and `Yes`
  are unconfirmed. If the manager-side ticket ends up sending a differently-cased value this
  fails closed (428), which is the safe direction, but it will look like a bug to whoever hits it.

## Tripwire parked

- `packages/cadre-cli/src/server/admin-server.ts`, `projectStrands` doc: a `NOTE:` records that
  a **running instance with no control row** (a removal the watcher observed but whose local
  stop failed) is invisible to the list, and that the fix — if such orphans ever appear in the
  field — is a separate "stop a local instance" route, not widening this projection with
  entries that `DELETE` could not act on. Fine now; conditional on orphans actually occurring.
