description: Added fast local tests proving a node shuts down its copy of a shared network when someone else removes it, and that a node deliberately not watching that network keeps running — plus a duplicate-startup-notification bug found while reviewing them.
prereq:
files: packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-core/src/cadre-node.ts, docs/architecture.md, docs/STATUS.md
----

# What landed

Two tests at the end of `packages/cadre-core/test/strand-unpublish.spec.ts` covering the
**sibling side** of a party-wide strand removal — the branch a node takes when it did *not*
issue the removal and learns of it only from its own `StrandWatcher` poll
(`StrandWatcher.poll` → `onStrandRemoved` → `CadreNode.handleStrandRemoved`). That branch had
no coverage: `unpublishStrand` force-stops the local instance itself, so the issuing node never
walks it.

The tests stand in for a second machine without needing one: they delete the `Strand` row out
from under a single running node by calling `ControlDatabase.deleteStrand` directly, which
leaves the node in exactly a sibling's state a moment after someone else's removal commits —
row gone from its view, instance still running, only the next poll can notice. Whether the
deletion becomes *visible* to a real second node over the network is deliberately separate
(`implement/19.5-debt-strand-unpublish-sibling-convergence-e2e`); the split means a red sibling
scenario says whether local wiring or replication is at fault.

**Test 1 — "stops a watched instance when the row vanishes from under it".** Filter
`{ mode: 'all' }`, 200 ms poll. Publish first, gate on `strand:discovered` (proof the watcher
holds the id in `knownStrands` — the precondition for its removal path firing at all), then
`addStrand`, then delete the row. Asserts `strand:stopped` fires once and stays at once across
a five-poll quiet window, the instance is gone, no `strand:error`, and a re-`publishStrand` of
the same id yields a second `strand:discovered` rather than a relaunch — which is what proves
`handleStrandRemoved` cleared `sAppConfigs`, the watcher dropped the id, and the removal's
`Revocation` tombstone is not mistaken for a live row.

**Test 2 — "keeps running a strand its strandFilter excluded".** Filter
`{ mode: 'strandId', strandId: <a different id> }`. The excluded strand is published, run via
`addStrand`, and its row deleted; after a five-poll window the instance is still present with
no `strand:stopped`. A node that opted out of *watching* a strand also opted out of observing
its party-wide removal — its only stop is a local `stopStrand`/`unpublishStrand` call.

**Harness (spec file only):** `startSelfOwnerNode` gained an optional overrides parameter
(`strandWatchInterval`, `strandFilter`) defaulting to production values, so the six existing
call sites are unaffected; an `ownerKeys` `WeakMap<CadreNode, Ed25519KeyPair>` lets a test drive
a control writer directly without changing the helper's return type; `deleteStrandRow` and
`collectStrandEvents` helpers; timing constants with the quiet window *derived* from the poll
interval so an interval bump cannot silently make an assertion vacuous.

**Documentation:** the filter-excluded node's non-convergence is now stated in
`CadreNode.unpublishStrand`'s doc comment, `docs/architecture.md` (both the party-wide-removal
paragraph and the `cadre strand remove` CLI paragraph), and `docs/STATUS.md`.

**Production:** one DRY extraction (`CadreNode.detachStrand`, below). No behaviour change.

# Validation

| what | result |
| --- | --- |
| `yarn --cwd packages/cadre-core test test/strand-unpublish.spec.ts` | 10/10 passed |
| `yarn --cwd packages/cadre-core test` | 83 files, 1326 passed, 1 skipped (skip pre-existing) |
| `yarn lint` | clean |
| `yarn typecheck` | clean (test files ARE in the type-check program — `tsconfig.typecheck.json` includes `test`) |

The stale-build guard tripped once mid-review because the linked `C:\projects\quereus`
workspace was edited concurrently; `yarn workspace @quereus/quereus build` cleared it. Nothing
in that repo was modified.

# Review findings

## Checked

Read the implement diff before the handoff summary. Read `strand-watcher.ts` end to end,
`cadre-node.ts`'s `handleStrandAdded` / `handleStrandRemoved` / `addStrand` / `launchStrand` /
`stopStrand` / `unpublishStrand`, `strand-instance-manager.ts:startStrand`,
`hibernation-manager.ts:trackStrand`/`scheduleIdleTransition`, the whole spec file, and every
doc line matching `unpublishStrand|strandFilter|party-wide removal` across `docs/`. Verified the
build/type-check story (`tsconfig.typecheck.json`, `vitest.config.ts`) rather than taking
"typecheck clean" on trust. Ran the target spec, the full package suite, lint, and typecheck.

## Major — filed as a ticket

- **Duplicate `strand:started` on rediscovery** → `fix/duplicate-strand-started-on-rediscovery`
  (`repro: verified`). Found by checking whether the implementer's setup-ordering comment in
  test 1 was actually true. It is: `addStrand` then `publishStrand` — the ordinary founding
  sequence — makes this node's own watcher rediscover the row, take the auto-start branch
  because the sApp config is already registered, and emit a **second** `strand:started` for the
  already-running instance. Root cause is one site: `CadreNode.launchStrand` does its
  post-start work (`trackStrand` + `emit`) unconditionally, and cannot tell an idempotent
  `StrandInstanceManager.startStrand` return from a fresh launch. Reproduced with a throwaway
  spec (since removed): two events observed where one was expected. No timer leak —
  `scheduleIdleTransition` clears before arming — but `resolveCohortSeed`'s RPC fan-out is also
  re-run for an already-running strand. Test 1's ordering comment now names this ticket so the
  constraint can relax once it lands.

## Minor — fixed in this pass

- **DRY, production.** `handleStrandRemoved` was a verbatim copy of `stopStrand`'s body (untrack
  hibernation → drop sApp config → stop instance → emit `strand:stopped`), differing only in the
  `_running` guard and the try/catch. Extracted `CadreNode.detachStrand` and had both call it;
  behaviour is byte-identical, and the comment at the call site now records *why*
  `handleStrandRemoved` cannot simply call `stopStrand` (its `_running` guard would throw on a
  poll landing during shutdown). Both paths were already covered — the pre-existing tests cover
  `stopStrand`, this ticket's cover `handleStrandRemoved` — which is what made the extraction
  safe.
- **Test 2's negatives were vacuous.** "No discovery, no stop" would have passed identically if
  the watcher had never polled at all. Added an admitted strand alongside the excluded one as a
  liveness witness: the filter is `{ mode: 'strandId', strandId: admittedId }`, and gating on
  *its* `strand:discovered` proves the watcher is running before any silence about the excluded
  id is asserted. Also added an explicit `queryStrands()` assertion that the excluded row really
  left the database — otherwise "still running" proves nothing about removal.
- **Two comments misattributed `knownStrands`.** They credited `handleStrandRemoved` with
  clearing the watcher's `knownStrands`; `StrandWatcher.poll` does that (`strand-watcher.ts`,
  the removed-strands loop) before invoking the callback. Corrected.
- **`startSelfOwnerNode`'s conditional spread** (`...(x === undefined ? {} : { x })`, twice) was
  unnecessary — `exactOptionalPropertyTypes` is not enabled anywhere in the repo — and the
  parameter type already restricts the keys. Replaced with `...overrides`.
- **`vi.waitFor` options repeated three times** → one `WAIT_OPTS` constant.
- **`collectStrandEvents` was declared mid-`describe`**, after seven tests. Moved up with the
  other helpers.
- **Two docs still over-claimed** what the implement pass fixed in one place: the `cadre strand
  remove` paragraph (`docs/architecture.md`) and the removal entry in `docs/STATUS.md` both said
  every node stops on its next poll. Both now carry the filter-excluded caveat.

## Reviewed and deliberately left alone

- **The `ownerKeys` WeakMap** (the handoff asked for a second opinion). It is the right call:
  `CadreNode` exposes no public accessor for its owner signing key (`requireOwnerSigningKey` is
  private), and the alternative — returning `{ node, ownerKey }` — would churn six call sites to
  serve two tests. The WeakMap is three lines, documented, and keyed by the node itself.
- **The filter-excluded strand as a design smell** (the handoff flagged it rather than filing).
  Agreed with not filing: a node running a strand its own watcher was told to ignore is an app
  choosing to do so, and both `unpublishStrand`'s comment and the architecture doc now say
  plainly that such a node is never told about a party-wide removal. If that becomes
  unacceptable it is a design decision for a human (`blocked/`), not a defect.
- **Test 1's setup ordering.** Confirmed the rationale holds, and the reason is stronger than
  the handoff knew — see the major finding above.

## No tripwires recorded

Nothing found in this diff was of the "fine now, only matters if X later" shape. The one
conditional weakness — test 2's time-bounded negatives — was fixable outright with the liveness
witness rather than parked as a note, so it was fixed.

## Known gaps carried forward (unchanged, deliberate)

- **No real second node.** Cross-machine visibility is
  `implement/19.5-debt-strand-unpublish-sibling-convergence-e2e`.
- **`handleStrandRemoved`'s `strand:error` branch is untested** — it fires only when
  `strandManager.stopStrand` throws, which needs a fault injected into the manager. Left
  uncovered rather than reaching into internals to force it; the branch only logs and emits.
- **Hibernation is off in these specs**, so `handleStrandRemoved`'s `untrackStrand` call runs but
  is not meaningfully asserted. A hibernating-then-removed strand has no coverage.
- **`sAppId` filter mode** and its provisional/`defer` re-evaluation branch stay with
  `strand-watcher-filters.spec.ts`; the ticket scoped them out.
- **A poll whose read throws is swallowed and retried** (`strand-watcher.ts`, the outer catch in
  `poll`). If either new test ever times out, check `sereus:cadre:strand-watcher` debug output
  before concluding anything about convergence — a failing read looks identical to a row that
  never disappeared.
