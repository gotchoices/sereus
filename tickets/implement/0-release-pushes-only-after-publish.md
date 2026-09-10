----
description: A release pushed its version tag to GitHub and then refused to publish, leaving a public tag for a version that never existed on npm. It also never creates the GitHub release page, and the release notes file is read by nothing. Reorder the release so nothing leaves the machine until npm has the packages, make a half-finished publish resumable, and finish the job by creating the release page from the pending notes.
files: package.json, scripts/release-preflight.mjs, scripts/release-preflight.test.mjs, scripts/publish-package.mjs, scripts/publish-package.test.mjs, docs/releasing.md, .release-notes.pending.md
difficulty: medium
tradeoffs: pushing after publishing means a published version can briefly exist without its tag on GitHub if the push fails; the reverse order — today's — leaves a public tag for a version that may never publish, which is worse and harder to undo
likelihood: certain
----

# The release pushes before it knows it can publish

## What happened (2026-09-10)

The owner cut a release with `yarn release` and chose `1.0.0-beta.1` at bumpp's prompt.

1. `release-preflight.mjs` ran. It can only *warn* that no dist-tag is set, because the version does
   not exist yet — it is chosen inside the next step.
2. `yarn bump` (bumpp: commit, tag, **push** are all on by default) committed `d1e0c38`, tagged
   `v1.0.0-beta.1`, and pushed both to origin.
3. `yarn pub` → `publish-package.mjs quereus-plugin-sereus` → `assertDistTagForPrerelease` refused:
   a prerelease with no dist-tag. Correct refusal. Nothing reached npm.

The guard was right and fired first thing inside `pub`. It was simply too late: the tag was
already public. The owner then re-released as `0.13.0`, and the stray `v1.0.0-beta.1` tag had to be
deleted from origin by hand afterwards.

Separately, **no GitHub release has ever been created** for this repo (`gh release list` is empty).
`docs/releasing.md` step 5 leaves `gh release create` as a manual step, and
`.release-notes.pending.md` exists but nothing reads it. The v0.13.0 page was created by hand after
the fact.

## The rule this ticket establishes

**Nothing leaves the machine until every package is on npm.** Every check that can refuse a
release must run before anything is pushed, and before anything is published.

## Design

Rewrite the root `release` script as five steps, each a separate command so a failure stops the
chain at a known point:

```
node scripts/release-preflight.mjs
  && yarn bump --no-push
  && node scripts/release-guard.mjs
  && yarn pub
  && node scripts/release-finish.mjs
```

### 1. Preflight (before the version exists) — `release-preflight.mjs`, extended

Keep everything it does. Add two refusals, because both are things that would otherwise fail
*after* npm publish, when they can no longer stop anything:

- **GitHub CLI not authenticated** (`gh auth status` non-zero) → refuse, naming the command to fix it.
- **`.release-notes.pending.md` missing or containing no content beyond its header** → refuse. The
  checklist already says "GitHub release created with real notes"; this is where that becomes
  enforced rather than remembered.

One escape hatch covers both: `SEREUS_GH_RELEASE=0` skips the GitHub release entirely (and so skips
both checks). Report it prominently when set. Do not add a separate hatch per check.

Keep the existing no-dist-tag *warning* — at this point it is still only a warning, because the
version is not yet known.

### 2. Bump locally only — `yarn bump --no-push`

bumpp 10.4.0 supports `--no-push` (commit and tag stay on). The release commit and its tag now
exist only locally until step 5.

### 3. Guard (after the version exists, before anything is published) — new `scripts/release-guard.mjs`

Reads the now-bumped state and refuses with an exact local undo if any of these fail:

- **Every publishable package carries the same version as the root `package.json`.** The publishable
  set is the `pub:*` scripts in the root `package.json` — `docs/releasing.md` names that the list of
  record, and `yarn smoke:published` already derives its set from it. Derive it the same way; do not
  hard-code five names.
- **A prerelease version has a dist-tag.** Reuse `assertDistTagForPrerelease` and `resolveDistTag`
  from `publish-package.mjs` — they are already exported for exactly this — so the guard and the
  publish cannot disagree. This is the check that would have caught the `1.0.0-beta.1` case with
  nothing pushed.
- **The tag `v{version}` exists and points at `HEAD`.** bumpp made it; if it did not, stop.
- **Not already fully published.** If *every* package already has this exact version on npm, the
  release has nothing to do — refuse rather than proceed to a finish step that would push and create
  a page for an old release.

On refusal, print the exact commands to undo the unpushed bump, and **print them rather than running
them** — undoing a commit is the operator's decision:

```
git tag -d v{version}
git reset --keep HEAD~1
```

`--keep`, not `--hard`: it refuses rather than discarding uncommitted work.

### 4. Publish — `yarn pub`, made resumable

`publish-package.mjs` today cannot resume. If package three of five fails its build, packages one and
two are already on npm, and re-running `yarn pub` fails on package one because npm refuses to publish
over an existing version.

Before `yarn clean && yarn build`, check whether `name@version` already exists on the registry
(`npm view <name>@<version> version`). If it does, log that it is already published and skip it —
exit 0. Then re-running `yarn pub` after a fix picks up exactly where it stopped.

**A registry lookup that fails must fail loudly, never read as "not published".** "Could not reach
the registry" and "this version does not exist" are different answers; conflating them turns an
outage into an attempted republish, or worse, a skipped publish.

### 5. Finish (after npm has everything) — new `scripts/release-finish.mjs`

In order:

1. `git push origin HEAD` then `git push origin v{version}` — explicit, not `--follow-tags`, so an
   unrelated local tag is never pushed as a side effect.
2. Unless `SEREUS_GH_RELEASE=0`: `gh release create v{version} --verify-tag --notes-file .release-notes.pending.md`,
   adding `--prerelease` when the version is a semver prerelease, and `--latest=false` when a
   dist-tag other than `latest` was used — so the GitHub "Latest" badge matches what `npm install`
   returns.
3. Reset `.release-notes.pending.md` to its empty header, commit it as
   `chore: open release notes after v{version}`, and push.

**Every failure here happens after npm publish, so it must not read as a failed release.** Print
"npm publish succeeded" first, then the exact remaining commands from the step that failed onward,
and exit non-zero. The operator's job at that point is to finish, not to start over.

## What must not change

- `assertDistTagForPrerelease`'s semantics, including `SEREUS_DIST_TAG=latest` as the deliberate way
  to put a prerelease on `latest`.
- `resolveDistTag`'s argv-beats-env precedence, and its refusals of a bare word, an empty `--tag`, and
  a semver-shaped tag. The existing tests in `scripts/publish-package.test.mjs` pin these; they must
  all still pass unchanged.
- The `cadre-host` placeholder-release-key guard.
- The preflight's refusal to assume consent without a TTY or `--yes` / `CI`.
- `../optimystic` and `../quereus`. Their release scripts have the same shape and very likely the
  same ordering problem, but they are not this repo. Note it in the review handoff; do not edit them.

## Edge cases & interactions

- **The exact 2026-09-10 case, end to end:** prerelease chosen, no `SEREUS_DIST_TAG` → the guard
  refuses after bump, nothing pushed, nothing published, undo commands printed.
- **Partial publish:** package three fails to build → fix → `yarn pub` again skips one and two,
  publishes three to five, and `release-finish` then runs normally.
- **Registry unreachable during the already-published check** → loud failure, no skip, no publish.
- **Push rejected after publish** (someone pushed to master meanwhile) → "npm publish succeeded",
  then the recovery commands; no GitHub release is created against a tag that is not on origin.
  `--verify-tag` enforces that last part; keep it.
- **`gh release create` fails after the push** → the tag is on origin, packages are on npm; print
  the one remaining `gh` command plus the notes-reset step.
- **`SEREUS_GH_RELEASE=0`** → preflight skips both new checks, finish pushes and stops, and the
  pending notes are left untouched rather than reset — they were not used, so wiping them would lose
  them.
- **Pending notes containing only the header** → preflight refuses. "Only the header" must be
  decided by a real rule (for example: no non-blank line after the first heading), not by a
  byte-length threshold that a trailing newline can defeat.
- **A dist-tag set but the version stable** (e.g. `0.14.0` under `next`) is legitimate — the existing
  test "a stable version under a non-latest tag is legitimate" says so — and the finish step must
  then pass `--latest=false`.
- **Running `yarn bump` / `yarn pub` by hand**, outside `yarn release`, keeps working exactly as
  `docs/releasing.md`'s step-by-step describes. Only the `release` composition changes, plus
  `publish-package`'s resumability, which benefits both paths.
- **Windows.** `docs/releasing.md` calls PowerShell this repo's primary shell. Pass arguments to
  `git` / `gh` / `npm` as argv arrays (`execFileSync`), never as an interpolated shell string — which
  also keeps a dist-tag value out of a shell.

## Tests

Follow the existing pattern: pure, exported decision functions, tested with `node --test`, with the
side-effecting `main()` behind the same `import.meta.url` guard both scripts already use. Wire any new
test file into the root `test` script the way `test:release-preflight` and `test:publish-package` are
— that script lists them explicitly, so a test file not added there never runs.

At minimum:

- guard: mismatched package version; prerelease with no tag; tag missing, or not at `HEAD`; every
  package already published; the happy path; and that the undo text names the right version.
- publish: already-published → skip; not published → proceed; registry error → throw, never skip.
- finish: `gh` arguments for stable, prerelease, and non-`latest`-tag stable versions; the recovery
  text after each failure point names only the steps still left to do.
- preflight: `gh` unauthenticated → refuse; notes missing, header-only, or header-plus-whitespace →
  refuse; `SEREUS_GH_RELEASE=0` → neither check runs.

## Docs

`docs/releasing.md` must describe the new flow:

- **Quick Release**: the five steps and what each one can refuse.
- **Step 3**: bumping no longer pushes.
- **Step 5**: the GitHub release is automated.
- **Checklist**: updated to match.
- **A new "Recovering a half-finished release" section**: undo after a guard refusal, resume after a
  partial publish, finish after a post-publish failure.
- **The stale "Where the last release landed"** (it still says `v0.11.0`): now `v0.13.0`, published
  to `latest` on 2026-09-10.

## TODO

- [ ] Extend `release-preflight.mjs` with the `gh auth` and pending-notes refusals and the
      `SEREUS_GH_RELEASE=0` hatch.
- [ ] Add `scripts/release-guard.mjs`, reusing `publish-package.mjs`'s exported helpers.
- [ ] Make `publish-package.mjs` skip an already-published version, and fail loudly on a registry
      error.
- [ ] Add `scripts/release-finish.mjs`: explicit push, `gh release create`, notes reset.
- [ ] Rewrite the root `release` script to the five-step composition.
- [ ] Tests for every decision above, wired into the root `test` script.
- [ ] Update `docs/releasing.md`, including the recovery section and the stale last-release line.
