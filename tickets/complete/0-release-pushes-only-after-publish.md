description: The release used to push its version tag to GitHub before it knew whether npm would accept the packages, so a refused publish left a public tag for a version that never shipped. The release now publishes first and pushes last, a half-finished publish can be resumed, and the GitHub release page is created automatically from the pending notes file.
files: package.json, scripts/lib/release-support.mjs, scripts/release-support.test.mjs, scripts/release-preflight.mjs, scripts/release-preflight.test.mjs, scripts/release-guard.mjs, scripts/release-guard.test.mjs, scripts/publish-package.mjs, scripts/publish-package.test.mjs, scripts/release-finish.mjs, scripts/release-finish.test.mjs, docs/releasing.md
----

# Nothing leaves the machine until npm has the packages

## What shipped

`yarn release` was `preflight && yarn bump && yarn pub`. `bumpp` pushes by default, so the version tag reached origin before the publish had any chance to refuse it. On 2026-09-10 the publish did refuse — a prerelease with no dist-tag — and a `v1.0.0-beta.1` tag had to be deleted from origin by hand.

It is now five separate commands, and everything that can refuse a release runs in the first three, while the release commit and its tag exist only on the operator's machine:

```
node scripts/release-preflight.mjs
  && yarn bump --no-push
  && node scripts/release-guard.mjs
  && yarn pub
  && node scripts/release-finish.mjs
```

Step 5 is the first thing that touches the outside world, and it runs only once npm has every package.

- **`scripts/lib/release-support.mjs`** — the decisions more than one step needs, so they cannot disagree: the `SEREUS_GH_RELEASE` hatch, what counts as written release notes, whether the notes file is already reset, and whether `name@version` is on the registry. The registry probe is an HTTPS fetch of the abbreviated packument rather than `npm view`, because node refuses to spawn the `npm.cmd` shim without a shell on Windows. A 404 means "never published"; every other non-200 throws rather than guessing.
- **`scripts/release-guard.mjs`** — refuses after the bump and before the publish: a package the bump missed, a prerelease with no dist-tag (reusing `assertDistTagForPrerelease`), a missing tag or one not at `HEAD`, and a version that is already fully published. Local checks run before any network call. On refusal it prints the undo commands rather than running them.
- **`scripts/release-finish.mjs`** — pushes the commit then the tag explicitly (never `--follow-tags`), creates the GitHub release from `.release-notes.pending.md`, and reopens that file. `--notes-only` runs the last step alone. Every failure here prints "npm publish succeeded" first and then only the steps still left, because a failure after the publish is an unfinished release, not a failed one.
- **`scripts/release-preflight.mjs`** — two new hard refusals ahead of the `--yes`/`CI` bypass: `gh` unusable or logged out, and pending notes still just their header.
- **`scripts/publish-package.mjs`** — asks the registry whether `name@version` exists before `yarn clean && yarn build` and skips it if so, which is what makes a partial publish resumable.
- **`docs/releasing.md`** — the five steps and what each refuses, a "Recovering a half-finished release" section, an updated checklist, and the corrected last-release line.

## Review findings

### Checked

The full implement diff (11 files) read before the handoff summary; every new script and test read end to end. Argv-array discipline across every `git` / `gh` / registry call. The CRLF reasoning in the notes reset. The accuracy of the recovery text. `resolveDistTag` / `assertDistTagForPrerelease` / the `cadre-host` placeholder-key guard / the no-TTY-no-consent refusal, all confirmed unchanged and still covered. `docs/releasing.md` against the code it describes, and `docs/testing.md` and `knip.ts` for lists the new files should have joined (neither has one — `docs/testing.md` documents individual guards, and root `scripts/**` is knip-ignored with `scripts/*.mjs` as entries).

Ran: `yarn lint` clean; all root `node --test` suites — 157 tests, 0 failures (75 across the five release-related files, including two new ones). Exercised live on this tree: `node scripts/release-guard.mjs` refused with `tag v0.13.0 points at b95f0045, but HEAD is ac449e69` and exit 1; `CI=1 node scripts/release-preflight.mjs` refused the header-only notes at exit 1 and reported `gh ok`, so the `gh auth status` spawn works unshelled on this machine; the registry probe answered `true` for `@serfab/cadre-core@0.13.0`, `false` for `@serfab/cadre-core@1.0.0-beta.1`, and `false` (via 404) for a scope member that has never existed.

### Major findings

None. The ordering, the refusal placement, and the resumability all hold up, and the shared-decisions module is the right shape for keeping the five steps in agreement.

### Fixed in this pass (minor)

- **A `--notes-only` recovery could strand the reset commit and still report success.** `resetPendingNotes` returned early when the file was already reset. So: the reset commits, its push is rejected (someone pushed to `master` meanwhile — the exact case `docs/releasing.md` calls out), the operator is told to re-run `--notes-only`, and that re-run finds the file reset, prints "nothing to commit", and exits 0 with `Released v{version}: pushed, published, …` while the commit sits on the machine. The push is now unconditional (`git push` with nothing to send is a no-op). Extracted the ordering into an exported `notesResetCommands(version, hasStagedChange)` — the same argv-builder shape as `ghReleaseArgs` and `remainingCommands` — and added two tests, one of which pins the "push even with nothing to commit" case.
- **`scripts/release-finish.mjs` had no top-level `.catch`,** unlike the guard. Anything thrown ahead of the first step (an unreadable root manifest, a dist-tag `resolveDistTag` refuses) surfaced as an unhandled-rejection stack trace. Now reported as `Release finish could not start: …` with exit 1.
- **`gitState` and `gitFacts` ran git in the process working directory** while reading the version from `repoRoot`, which both scripts resolve from their own file location. Run from another repo's directory the guard would have compared this repo's version against that repo's `HEAD`. Both now pass `cwd: repoRoot`.
- **`docs/releasing.md` step 5.3 did not mention that the notes reset is pushed** — updated, along with why the push runs even when there is nothing to commit.

### Tripwires recorded (not filed)

- `gh` is spawned without a shell, so a `gh` installed as a `.cmd`/`.ps1` shim rather than a real executable would answer EINVAL on Windows and read as "missing" — the same shim problem that kept `npm view` out of `release-support.mjs`. Not reachable today (the official installers ship `gh.exe`, and `gh auth status` was verified working here), and the failure lands at preflight rather than after a publish. `NOTE:` at `ghAuthState` in `scripts/release-preflight.mjs`.

### Documented, not filed

- **The sibling repos still have the original ordering.** Verified statically: `../optimystic` and `../quereus` both still run `yarn bump && yarn pub`, and `bumpp` pushes by default, so releasing either can still leave a public tag for a version npm goes on to refuse. That is work for those repos, not this board, so it is recorded as a note in `docs/releasing.md` next to the 2026-09-10 story, with the by-hand workaround (`--no-push`).

### Considered and not filed

- **Comment density in the new scripts is high**, but the comments carry rationale rather than restating the code, the functions are short and named for what they decide, and this matches `scripts/publish-package.mjs` as it already stood. Left alone.
- **`publishCommand` interpolates the dist-tag into a shell string** for `execSync`. Pre-existing and unchanged by this diff, and `assertPlausibleTag` gates the tag through `^[a-z0-9][a-z0-9._-]*$` plus a semver refusal before it can get there. No shell-reachable metacharacter survives that.
- **`alreadyFullyPublishedFailure`'s empty-package branch is unreachable** — `publishableWorkspaces` throws when no `pub:*` script exists. It is defensive only and already has a test; not worth removing.

### Not exercised

- **Workspace suites were not run.** Nothing under `packages/` changed — the diff is `scripts/`, root `package.json` scripts, and `docs/` — and `yarn test` runs the real-network integration scenarios, which exceeds the ten-minute budget an agent can hold. Everything that does cover the diff was run and is green.
- **A real release.** `release-finish.mjs`'s pushes, its `gh release create`, and the notes-reset commit have still never run for real; only their decisions are covered by tests. Unchanged from the implement handoff, and unavoidable without publishing a version.
- **The guard's happy path and its "already fully published" refusal end to end.** On this tree the tag-vs-HEAD arm fires first, so both remain unit-tested only.

## Known limits carried forward

- **`release-finish` re-resolves the dist-tag from argv/env rather than reading it back from the registry.** Inside `yarn release` that is the same value the publish used, because one environment runs the whole chain; publish by hand in one shell and finish in another and it is lost, and a stable version published under `next` would then take the GitHub "Latest" badge. `NOTE:` at the site, and the resolved tag is printed before `gh` runs.
- **A resumed `yarn pub` skips on version alone, not on dist-tag.** Re-running a resume under a different `SEREUS_DIST_TAG` leaves the already-published packages on the original tag. `NOTE:` at the site in `scripts/publish-package.mjs`.
