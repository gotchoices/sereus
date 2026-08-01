description: An app that started a shared workspace and then announced it to the group was told twice that it had started, and in a related case was told a workspace stopped that it had never run — both fixed, reviewed, and covered by tests.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts, docs/architecture.md
difficulty: easy
----

# What shipped

`packages/cadre-core/src/cadre-node.ts`:

- `launchStrand` (shared by `addStrand` and the watcher's `handleStrandAdded`) returns the
  existing instance when `strandManager.getInstance(strand.Id)` is already set, before
  deriving the transport key or calling `resolveCohortSeed` (a control-mesh RPC fan-out).
  The ordinary founding order — `addStrand` then `publishStrand` — no longer re-emits
  `strand:started` when this node's own `StrandWatcher` rediscovers the row it just
  published.
- `detachStrand` (shared by `stopStrand` and the watcher's `handleStrandRemoved`) skips
  `strandManager.stopStrand` and the `strand:stopped` emit when
  `strandManager.hasStrand(strandId)` is false. `hibernationManager.untrackStrand` and
  `sAppConfigs.delete` stay unconditional (no-ops when nothing is tracked), so a launch
  that failed before an instance existed still gets its stray sApp config cleared. A party
  owner that published a strand's row but never ran it locally no longer emits a phantom
  `strand:stopped`.

Tests: `strand-unpublish.spec.ts` tracks `strand:started`; the sibling-side removal test
uses the normal add-then-publish order (the old publish-first workaround routed around this
bug) and asserts exactly one `strand:started` and zero `strand:discovered`; a new test
proves `strand:stopped` never fires for a strand this node published but never ran.
`cadre-node-strand-launch-key.spec.ts`'s fake strand manager gained `getInstance`.

Docs: `docs/architecture.md` (strand launch/mode section) now states the one-event-per-instance
contract for `strand:started` / `strand:stopped`, including that a genuine stop-then-start
cycle still emits the full pair.

# Review findings

## Read of the implement + fix diffs against the stated invariant

- **Guards key off instance-tracking state only, as claimed.** `hasStrand` and `getInstance`
  read the same `instances` map in `strand-instance-manager.ts`, so the two guards agree.
  Neither consults anything stickier (an id seen once, a config still registered), so a
  real restart is two distinct instances and emits both events again.
- **No behavior regression from skipping the work `launchStrand` used to redo on re-entry.**
  On re-entry the old code still reached `startStrand`, whose own already-running guard
  returned the same instance — so the only things now skipped are a redundant
  `resolveCohortSeed` RPC fan-out, a redundant `hibernationManager.trackStrand`, and the
  duplicate emit. The hibernate → wake path resolves its own seed in `resumeStrand`, so
  nothing depended on the launch-path re-resolution.
- **Downstream consumers of the removed events checked.** `cadre-cli/src/commands/start.ts`,
  `reference-app-rn/src/use-cadre.ts`, `reference-app-web/src/lib/store.svelte.ts`,
  `reference-app-ns/src/cadre-vm.ts` all treat `strand:stopped` as "refresh my strand list"
  or a log line; none uses it to clear discovery state, so suppressing it for a strand that
  never ran locally loses nothing.
- **Integration scenario re-read, not re-run.**
  `packages/integration-tests/src/scenarios/strand-unpublish-sibling-convergence.integration.ts`
  is compatible by inspection: node B discovers before it adds, so it has exactly one
  instance and its assertions (`started`/`stopped`/`discovered` each exactly once) hold
  unchanged. Not executed — that suite is real-network and several of its siblings are
  tracked as blocked in `tickets/.pre-existing-known.md`.
- **The two out-of-scope implement-stage fixes are correct.** The `discovered` assertion
  change to `[strandId]` follows from `handleStrandAdded` only emitting `strand:discovered`
  when no sApp config is registered; the `getInstance: () => undefined` fake stub is the
  minimum that keeps that spec's never-tracks-an-instance premise true.

## Fixed in this pass (minor)

- **Missing restart regression coverage.** The invariant the implement handoff asked review
  to confirm — a genuine stop-then-start emits both events again — had no test pinning it;
  the full-suite pass was circumstantial. Added
  `'re-emits strand:started on a genuine restart, and strand:stopped only once per instance'`
  to `strand-unpublish.spec.ts`: add → stop → add asserts two `strand:started` and one
  `strand:stopped`, then two further `stopStrand` calls on the already-stopped id assert no
  phantom third `strand:stopped`. The second arm fails without the `detachStrand` guard.
- **Docs did not reflect the new contract.** `docs/architecture.md` described the removal
  fan-out but said nothing about how many lifecycle events an instance produces. Added the
  paragraph described above. `docs/strands.md` is design Q&A with no lifecycle-event surface
  and needed no change; `docs/STATUS.md`'s references are to the integration scenario's
  discovery anchor, still accurate.

## Filed as a new ticket (major)

- `tickets/backlog/bug-failed-strand-launch-leaves-dead-instance.md` — when
  `buildStrandRuntime` throws, `StrandInstanceManager.startStrand` leaves the failed
  instance in its `instances` map with `status: 'error'`, so every later launch of that id
  returns the dead record instead of retrying. Pre-existing (the old guard inside
  `startStrand` had the same effect), not introduced here, but this fix makes that map the
  single arbiter of "is this strand running" so it is worth settling. `repro: static` —
  read from the code, not reproduced; the ticket names the test that would confirm it.
  A second symptom resolves at the same site and is filed as part of it rather than
  separately: `launchStrand` also returns a *quiesced* (hibernating) instance — tracked but
  with no libp2p node or database — to an `addStrand` caller expecting a live one. Same
  unsettled question: what counts as "running" for the tracked-instance checks.

## Categories checked with nothing to report

- **Resource cleanup / error handling in the diff**: the guards add no handles and no
  catch blocks; `detachStrand` still untracks hibernation and drops the sApp config before
  its early return, which is what keeps a failed launch's stray config from leaking.
- **Type safety**: no `any`, no casts added; the fake-manager stub is the only widening and
  it is test-local.
- **Source hygiene**: net product change is two guards, ~12 lines including comments. No
  function grew past a screen, no new file, no duplication introduced.
- **Tripwires**: none recorded. The one conditional-looking concern (hibernated instance
  returned as if live) is not conditional — it is wrong the moment that path runs — so it
  went into the ticket above rather than a `NOTE:` comment.

## Verification (this review pass)

- `yarn workspace @serfab/cadre-core build` — exit 0.
- `yarn lint` (repo-wide) — exit 0.
- `yarn workspace @serfab/cadre-core test` (full suite) — 83/83 files, **1328 passed**, 1
  skipped (the pre-existing win32 skip in `key-store.spec.ts`), 0 failed. The extra test
  versus the implement-stage run is the restart regression added above.
- Sibling-workspace stale-build guard tripped again on `@quereus/quereus` (uncommitted
  in-flight edits in `../quereus`); cleared with `yarn workspace @quereus/quereus build`,
  which built clean. Same environment drift already logged in
  `tickets/.pre-existing-known.md` — not a sereus defect, no ticket.
