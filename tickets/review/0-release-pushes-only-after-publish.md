description: The release used to push its version tag to GitHub before it knew whether npm would accept the packages, so a refused publish left a public tag for a version that never shipped. The release now publishes first and pushes last, a half-finished publish can be resumed, and the GitHub release page is created automatically from the pending notes file.
files: package.json, scripts/lib/release-support.mjs, scripts/release-support.test.mjs, scripts/release-preflight.mjs, scripts/release-preflight.test.mjs, scripts/release-guard.mjs, scripts/release-guard.test.mjs, scripts/publish-package.mjs, scripts/publish-package.test.mjs, scripts/release-finish.mjs, scripts/release-finish.test.mjs, docs/releasing.md
difficulty: medium
----

# Review: nothing leaves the machine until npm has the packages

## What changed

`yarn release` was `preflight && yarn bump && yarn pub`. `bumpp` pushes by default, so the tag reached origin before the publish had a chance to refuse. On 2026-09-10 it refused (a prerelease with no dist-tag) and a `v1.0.0-beta.1` tag had to be deleted from origin by hand.

It is now five separate commands:

```
node scripts/release-preflight.mjs
  && yarn bump --no-push
  && node scripts/release-guard.mjs
  && yarn pub
  && node scripts/release-finish.mjs
```

Everything that can refuse a release runs in steps 1–3, while the release commit and its tag exist only on the operator's machine. Step 5 is the first thing that touches the outside world, and it runs only once npm has every package.

### New files

- **`scripts/lib/release-support.mjs`** — the decisions more than one step needs, so they cannot disagree: the `SEREUS_GH_RELEASE` hatch, what counts as written release notes, whether the notes file is already reset, and whether `name@version` is on the registry.
- **`scripts/release-guard.mjs`** — refuses after the bump, before the publish: a package the bump missed, a prerelease with no dist-tag (reusing `assertDistTagForPrerelease` from `publish-package.mjs`), a missing tag or one not at `HEAD`, and a version that is already fully published. Prints the undo commands rather than running them.
- **`scripts/release-finish.mjs`** — pushes the commit then the tag (explicitly, never `--follow-tags`), creates the GitHub release from `.release-notes.pending.md`, and reopens that file. `--notes-only` runs the last step alone.

### Changed files

- **`scripts/release-preflight.mjs`** — two new hard refusals: `gh` unusable or logged out, and pending notes that are still just their header. `SEREUS_GH_RELEASE=0` skips both. Report and warnings reworded now that the bump no longer pushes.
- **`scripts/publish-package.mjs`** — asks the registry whether `name@version` exists before `yarn clean && yarn build`, and skips it if so, which is what makes a partial publish resumable. A registry that cannot be reached throws.
- **`package.json`** — the five-step `release` script, plus `test:release-support`, `test:release-guard` and `test:release-finish` wired into `test`.
- **`docs/releasing.md`** — the five steps and what each refuses, step 3 no longer pushes, step 5 is automated, a new "Recovering a half-finished release" section, an updated checklist, and the stale last-release line (was `v0.11.0`, now `v0.13.0` / 2026-09-10).

## Design decisions a reviewer should weigh

**The registry probe is an HTTPS fetch, not `npm view`.** Node refuses to spawn the `npm.cmd` shim without a shell on Windows (it answers `EINVAL`), and this repo's primary shell is PowerShell. Routing a package name through a shell to work around that is exactly what the rest of the chain avoids, so `registryHasVersion` fetches the abbreviated packument from `registry.npmjs.org` and reads its `versions` map. `SEREUS_NPM_REGISTRY` (then `npm_config_registry`) overrides the host. A 404 is a real "never published"; every other non-200 throws.

**Preflight refusals run before the `--yes` / `CI` bypass.** The bypass skips the interactive prompt, not the refusals. Consequence worth a look: a CI release on a machine where `gh` is not logged in now fails at preflight instead of failing after the publish. `SEREUS_GH_RELEASE=0` is the way out.

**"Empty notes" is a structural rule, not a length threshold** — no non-blank line after the first heading. A file containing only a `## v0.14.0` sub-heading therefore counts as written notes. Deliberate: the check is "did someone type something", not a quality judgement.

**The guard runs its local checks before any network call**, so a broken bump is reported without five round-trips first, and a registry outage cannot mask a failure that could have been fixed offline.

## How to exercise it

**Already verified live on this tree** (results below are what actually happened, not predictions):

- `node scripts/release-guard.mjs` → refused with `tag v0.13.0 points at b95f0045, but HEAD is 440dfdb5`, printed the undo commands, exit 1. (The tag-vs-HEAD arm is the one this tree happens to trip.)
- `CI=1 node scripts/release-preflight.mjs` → refused: `.release-notes.pending.md has nothing beyond its header`, exit 1.
- `CI=1 SEREUS_GH_RELEASE=0 node scripts/release-preflight.mjs` → warned prominently about the hatch, proceeded, exit 0.
- `node scripts/publish-package.mjs cadre-core` → `@serfab/cadre-core@0.13.0 is already on npm — skipping.`, exit 0, and `packages/cadre-core/dist` was left intact (no `yarn clean`, no build).
- The registry probe against all five publishable packages at `0.13.0` → all `true`; `@serfab/cadre-core@1.0.0-beta.1` → `false`, which is the 2026-09-10 version that was tagged but never published.
- `yarn bump --version` prints `bumpp/10.4.0`, and `yarn lint --no-push` reaches eslint — so yarn does pass the extra flag through, and bumpp's `cli.mjs` reads `push: args.push`, which is what cac sets to `false` for `--no-push`.

**Worth exercising that I could not:**

- A real release. `release-finish.mjs`'s `main()` pushes and creates a GitHub release, so only its pure decisions are covered. The pushes, the `gh` invocation, the notes reset, and the `git diff --cached` guard around the commit have never run.
- The guard's happy path and its "already fully published" refusal end to end — on this tree the tag-vs-HEAD arm fires first, so both were covered by unit tests only.
- The publish path itself after a skip decision (i.e. a package that is *not* yet published proceeding to clean/build/publish).

## Known gaps, honestly

- **`release-finish` re-resolves the dist-tag from argv/env rather than reading it back from the registry.** Inside `yarn release` that is the same value the publish used, because one environment runs the whole chain. Publish by hand in one shell and finish in another and it is lost — a *stable* version published under `next` would then be created without `--latest=false` and take the GitHub "Latest" badge. Parked as a `NOTE:` at the site in `scripts/release-finish.mjs`, and the resolved tag is now printed so a wrong one is visible before `gh` runs.
- **A resumed `yarn pub` skips on version alone, not on dist-tag.** Re-running a resume under a different `SEREUS_DIST_TAG` leaves the already-published packages on the original tag. `NOTE:` at the site in `scripts/publish-package.mjs`.
- **Workspace test suites were not run.** Nothing under `packages/` changed — the diff is `scripts/`, root `package.json` scripts, and `docs/`. Everything that does cover the diff was run: `yarn lint` clean, and all ten root-level `node --test` suites pass (73 tests across the five release-related files).
- **`../optimystic` and `../quereus` almost certainly have the same ordering problem.** `docs/releasing.md` in this repo notes their release scripts share this shape. Out of scope per the ticket; not touched, not verified.

## Review checklist

- The line-ending handling in `resetPendingNotes` — `core.autocrlf=true` with no `.gitattributes` means a fresh checkout hands back CRLF for a file git stores with LF. `notesAreReset` normalizes, and there is a second guard on nothing being staged. Both are there to stop a post-publish false failure; check the reasoning holds.
- Every `git` / `gh` / registry call passes arguments as argv arrays (`execFileSync` / `spawnSync` / `fetch`), never as an interpolated shell string. Confirm nothing slipped through, especially anywhere a dist-tag is involved.
- The recovery text in `remainingCommands` must name only the steps still left to do. A reader who is told to re-push after a successful push starts wondering whether the publish worked.
- `assertDistTagForPrerelease` and `resolveDistTag` are unchanged, and `scripts/publish-package.test.mjs` still passes as it stood — the `SEREUS_DIST_TAG=latest` hatch, the argv-beats-env precedence, and the refusals of a bare word / empty `--tag` / semver-shaped tag all still hold.
- The `cadre-host` placeholder-release-key guard and the preflight's no-TTY-no-consent refusal are untouched.
