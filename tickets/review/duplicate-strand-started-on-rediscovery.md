description: When an app starts a shared workspace and then announces it to the rest of the group, the app was told twice that the workspace started (and, in a related case, told it stopped for a workspace it never ran) — fix is implemented, built, and tested green.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-unpublish.spec.ts, packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts
difficulty: easy
----

# What changed

`packages/cadre-core/src/cadre-node.ts`:

- `launchStrand` (shared by `addStrand` and the watcher's `handleStrandAdded`) now returns
  the existing instance early when `this.strandManager.getInstance(strand.Id)` is already
  set, before deriving the transport key or calling `resolveCohortSeed` (the control-mesh RPC
  fan-out). Stops the normal add→publish founding sequence from re-emitting `strand:started`
  when this node's own `StrandWatcher` rediscovers the row it just published.
- `detachStrand` (shared by `stopStrand` and the watcher's `handleStrandRemoved`) now skips
  `strandManager.stopStrand` and the `strand:stopped` emit when
  `this.strandManager.hasStrand(strandId)` is false. `hibernationManager.untrackStrand` and
  `sAppConfigs.delete` stay unconditional (no-ops when nothing tracked), so a launch that
  failed before an instance existed still gets its stray sApp config cleared. Stops a party
  owner that published a strand's row but never ran it locally (or an explicit `stopStrand`
  for an id never started) from emitting a phantom `strand:stopped`.

`packages/cadre-core/test/strand-unpublish.spec.ts`:

- `collectStrandEvents` now also tracks `strand:started`.
- `'stops a watched instance when the row vanishes from under it'` no longer needs the
  publish-before-add ordering workaround that routed around this bug — uses the normal
  add-then-publish order and asserts exactly one `strand:started` and zero `strand:discovered`
  for this node's own strand.
- New test: `'never emits strand:stopped for a strand this node published but never ran
  locally'` — publishes without `addStrand`, waits for `strand:discovered`, then
  `unpublishStrand`s it and asserts `strand:stopped` never fires. Exercises the `detachStrand`
  fix via the watcher-driven `forcePoll → handleStrandRemoved` path.

# Fixed during build/test verification (beyond the original fix-stage diff)

1. **Stale test assertion in the reordered test.** The trailing republish assertion still read
   `expect(events.discovered).toEqual([strandId, strandId])` — a leftover from the *old* test
   body, where the first `publishStrand` (before `addStrand` existed) legitimately produced one
   `discovered` event, so the republish made two. The reordering to add-then-publish makes the
   first `discovered` count zero (that's the whole point of the fix), so after the republish
   the correct total is one. Fixed the assertion to `toEqual([strandId])`; verified this is a
   test bug, not a product regression, by reasoning through `handleStrandAdded`'s branch (only
   emits `discovered` when no `sAppConfig` is registered) — matches actual observed behavior.
2. **Broken fake in an unrelated spec.** `cadre-node-strand-launch-key.spec.ts`'s
   `injectFakeStrandManager` stubs `node.strandManager` with only `startStrand`, no
   `getInstance` — the new `launchStrand` guard calls `getInstance` first and threw
   `TypeError: this.strandManager.getInstance is not a function` across all 7 tests in that
   file. Added `getInstance: () => undefined` to the fake (it never tracks a running instance,
   so every call is correctly a fresh launch).

# Environment note (not a sereus defect)

Both `../quereus` and `../optimystic` sibling workspaces (linked via root `package.json`
`resolutions`, used for reference/debug per `AGENTS.md`) had uncommitted in-flight edits that
tripped the cross-repo stale-build guard (`test-harness/build-freshness.ts`) when running
`packages/cadre-core`'s test suite: `@quereus/quereus` and `@optimystic/db-p2p` dist was stale
relative to src. Ran `yarn workspace @quereus/quereus build` and
`yarn workspace @optimystic/db-p2p build` in those sibling repos to clear the guard — both built
clean. This matches the pattern already logged in `tickets/.pre-existing-known.md` ("stale build
drift from live sibling work, not a sereus defect"); no ticket needed, just a note for whoever
next hits it.

# Verification performed

- `yarn workspace @serfab/cadre-core build` — clean, exit 0.
- `yarn workspace @serfab/cadre-core test` (full suite) — **83/83 test files, 1327 passed, 1
  skipped (pre-existing win32 skip in `key-store.spec.ts`), 0 failed.**
- `yarn lint` (repo-wide) — exit 0, no violations.

# Suggested focus for review

- Confirm the `launchStrand`/`detachStrand` guards only skip their emit/action when the strand
  manager's own instance-tracking state says so — a genuine restart (stop-then-start) must
  still emit both `strand:started` and `strand:stopped` normally. Covered by the existing full
  suite pass (1327 tests including restart-shaped scenarios elsewhere in the file) but worth an
  explicit read of `launchStrand`/`detachStrand` against that invariant.
- The two out-of-scope fixes above (stale assertion, fake stub) were mechanical and covered by
  green reruns — but are net-new changes beyond the original fix-stage diff, so worth a quick
  read.
- Not run: `packages/integration-tests` scenario
  `strand-unpublish-sibling-convergence.integration.ts` and the reference-app files
  (`reference-app-rn/src/use-cadre.ts`, `reference-app-web/src/lib/store.svelte.ts`,
  `reference-app-ns/src/cadre-vm.ts`) that reference `strand:started`/`strand:discovered`.
  These were grepped during fix-stage research; none appeared to assert an exact duplicate
  count, and none are exercised by the `cadre-core` package's own test run above. The
  integration scenario in particular touches several tickets already tracked as
  flaky/blocked in `tickets/.pre-existing-known.md` and was not re-run here (out of scope for
  this ticket's `difficulty: easy` sizing, cross-repo, real-network, slow). If review wants
  stronger coverage there, that's a fresh (fast, cheap) check rather than a re-open of this fix.
