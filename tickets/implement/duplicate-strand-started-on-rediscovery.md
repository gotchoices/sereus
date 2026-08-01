description: When an app starts a shared workspace and then announces it to the rest of the group, the app was told twice that the workspace started (and, in a related case, told it stopped for a workspace it never ran) — fix is written, needs build/test verification.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/strand-unpublish.spec.ts
difficulty: easy
----

# Status

Root cause and fix are from `tickets/fix/duplicate-strand-started-on-rediscovery.md` (deleted on
this handoff). The code change and matching test updates are ALREADY WRITTEN in this working
tree. What's left is build/test verification, which the fix-stage run did not reach before
hitting its token budget.

# What was changed

`packages/cadre-core/src/cadre-node.ts`:

- `launchStrand` (shared by `addStrand` and the watcher's `handleStrandAdded`) now returns
  early with the existing instance when `this.strandManager.getInstance(strand.Id)` is already
  set — before deriving the transport key or calling `resolveCohortSeed` (the control-mesh RPC
  fan-out). This stops the normal add→publish founding sequence from re-emitting
  `strand:started` when this node's own `StrandWatcher` rediscovers the row it just published.
- `detachStrand` (shared by `stopStrand` and the watcher's `handleStrandRemoved`) now skips the
  `strandManager.stopStrand` call and the `strand:stopped` emit when
  `this.strandManager.hasStrand(strandId)` is false. `hibernationManager.untrackStrand` and
  `sAppConfigs.delete` stay unconditional (both are no-ops when there's nothing tracked), so a
  launch that failed before an instance was ever created still gets its stray sApp config
  cleared. This stops a party owner that published a strand's row but never ran it locally (or
  an explicit `stopStrand` for an id never started) from emitting a phantom `strand:stopped`.

`packages/cadre-core/test/strand-unpublish.spec.ts`:

- `collectStrandEvents` now also tracks `strand:started`.
- The `'stops a watched instance when the row vanishes from under it'` test no longer needs the
  publish-before-add ordering workaround that routed around this bug (its old comment named
  this ticket) — it now uses the normal add-then-publish order and asserts exactly one
  `strand:started` and zero `strand:discovered` for this node's own strand.
- New test: `'never emits strand:stopped for a strand this node published but never ran
  locally'` — publishes without `addStrand`, waits for `strand:discovered` (proves the
  watcher's `knownStrands` tracked the row), then `unpublishStrand`s it and asserts
  `strand:stopped` never fires. This exercises the `detachStrand` fix via the watcher-driven
  `forcePoll → handleStrandRemoved` path specifically — `unpublishStrand`'s own explicit-stop
  branch is separately gated on `getInstance(trimmed)` and does not reach `detachStrand` for
  this case.

# TODO

- Run `yarn workspace @serfab/cadre-core build` (or repo-root `yarn build` if that's the
  established gate) and confirm it's clean.
- Run `yarn workspace @serfab/cadre-core test test/strand-unpublish.spec.ts` (or the package's
  normal vitest invocation) and confirm all cases pass, in particular:
  - `'stops a watched instance when the row vanishes from under it (the sibling-side removal
    path)'` — the reordered one.
  - `'never emits strand:stopped for a strand this node published but never ran locally'` — new.
- Run `yarn lint` on the two touched source/test files (or the full lint gate, per repo
  convention) — no new rule violations expected, but unverified.
- Run the broader `packages/cadre-core` test suite (not just this one spec file) to catch any
  other test that implicitly relied on the old double-emit or phantom-stop behavior. A quick
  `grep -rl "strand:started"` across the repo (already run during fix-stage research) turned up
  these other referencing files, none obviously asserting an exact duplicate count, but none
  were read in depth — worth a skim if the cadre-core suite surfaces anything:
  `packages/integration-tests/src/scenarios/strand-unpublish-sibling-convergence.integration.ts`,
  `packages/cadre-core/test/cadre-node.spec.ts`, `packages/reference-app-rn/src/use-cadre.ts`,
  `packages/reference-app-web/src/lib/store.svelte.ts`, `packages/reference-app-ns/src/cadre-vm.ts`.
- If build/lint/test all pass, promote to `review/` with a `## Review findings` section (per
  the standard implement → review handoff). If a test fails, diagnose against the intended
  behavior above (each guard should ONLY skip its stop/emit or launch/emit when the strand
  manager's own instance-tracking state says so — a genuine restart, i.e. stop-then-start,
  must still emit both events normally) before altering the guard.
