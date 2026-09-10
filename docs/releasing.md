# Release Process

## Overview

Sereus uses [bumpp](https://github.com/antfu/bumpp) for version bumping and follows semver.
Tags use the `v` prefix (e.g. `v0.1.0`). All packages in the monorepo share one version number.

Five workspaces are publishable, and the `pub:*` scripts in the root `package.json` are the list of
record — `yarn smoke:published` derives its set from them, so a package becomes covered the moment
it gets a `pub:*` script:

`quereus-plugin-sereus`, `cadre-core`, `cadre-cli`, `cadre-provider`, `cadre-host`.

Publish order matters and `yarn pub` already encodes it (dependency chain first):
`quereus-plugin-sereus` → `cadre-core` → `cadre-cli` → `cadre-provider` → `cadre-host`.

## Prerequisites

- `yarn build` succeeds
- `yarn test` passes, or every failure is a *known* one recorded in
  `tickets/.pre-existing-known.md` and you have read what it is
- `yarn smoke:published` passes — this is the one that installs the packages the way a customer
  does. It is not part of `yarn test` (it needs the network). See
  [`testing.md`](testing.md#installing-what-a-customer-installs--yarn-smokepublished-a-release-step-not-a-test).
- Clean working tree (`git status` shows no uncommitted changes)
- `.release-notes.pending.md` contains this release's notes. It is the body of the GitHub release,
  and the preflight refuses to start a release while it is still just its header.
- `gh` is installed and logged in (`gh auth status`), because the release creates the GitHub release
  page itself

## Quick Release

```bash
yarn release
```

**Nothing leaves this machine until every package is on npm.** That is the rule the whole chain is
built around: every check that can refuse a release runs before the push and before the publish, so
a refusal costs nothing but a `git reset`. `yarn release` is five separate commands, and a failure
stops the chain at a known point:

| # | Command | What it can refuse |
|---|---------|--------------------|
| 1 | `node scripts/release-preflight.mjs` | you have not confirmed `yarn check` passed; `gh` is missing or logged out; `.release-notes.pending.md` is empty |
| 2 | `yarn bump --no-push` | nothing — it commits and tags **locally only** |
| 3 | `node scripts/release-guard.mjs` | a package the bump missed; a prerelease with no dist-tag; a missing tag, or one not at `HEAD`; a version already fully published |
| 4 | `yarn pub` | the `cadre-host` placeholder release key; anything the build catches |
| 5 | `node scripts/release-finish.mjs` | nothing — it pushes, creates the GitHub release, and reopens the notes file |

Steps 1-3 all run before anything is published or pushed. Step 5 runs only once npm has every
package, so a failure there is an *unfinished* release rather than a failed one — see
"Recovering a half-finished release".

`yarn pub` publishes under the `latest` dist-tag unless told otherwise — see "Prerelease / RC" below
for why that is often the wrong thing.

`SEREUS_GH_RELEASE=0` skips the GitHub release entirely: the preflight stops checking `gh` and the
notes, the finish step pushes and stops, and the pending notes are left alone because nothing
consumed them.

## Step by Step

### 1. Ensure a clean working tree

```bash
git status          # no uncommitted changes
git pull origin master
```

### 2. Prove the published artifact actually installs

```bash
yarn smoke:published
```

Packs every publishable workspace, installs the tarballs plus registry dependencies into a scratch
project outside this repo, and runs a solo-device control-database scenario against them — a cadre
of one, plus a device restarting alone on the peer rows a vanished cohort left on disk. This is
the only gate that can see a defect which exists solely in the *published* dependency graph. Do not
skip it, and do not paper over a failure by installing something into the scratch project by hand.

### 3. Bump, commit, and tag — locally

```bash
# Interactive — prompts for version type (major / minor / patch / prerelease)
yarn bump --no-push

# Or specify the release type directly
yarn bump --no-push --release patch
yarn bump --no-push --release minor
yarn bump --no-push --release major
```

`bumpp` will:
1. Update `version` in all `package.json` files (recursive)
2. Commit the changes
3. Create an annotated tag: `v{version}`

**It does not push.** `--no-push` is what makes the rest of this reversible: until step 5 the release
commit and its tag exist only on your machine, so a refusal in step 3.5 or a failure in step 4 leaves
nothing public to clean up. On 2026-09-10 a `v1.0.0-beta.1` tag was pushed to origin and the publish
then correctly refused it for having no dist-tag; the stray tag had to be deleted from origin by
hand. That is the failure this ordering removes.

### 3.5 Guard the bumped state

```bash
node scripts/release-guard.mjs
```

Now that the version exists, the guard re-asks everything the preflight could only warn about, and
refuses while nothing is public: every publishable package carries the root version, a prerelease
carries a dist-tag, the tag `v{version}` exists and is at `HEAD`, and the release still has something
to publish. On a refusal it prints the two commands that undo the unpushed bump — it does not run
them, because undoing a commit is your call.

### 4. Publish to npm

```bash
# Publish all public packages (clean + build + publish each)
yarn pub
```

Or publish individually:

```bash
yarn pub:quereus-plugin-sereus
yarn pub:cadre-core
yarn pub:cadre-cli
yarn pub:cadre-provider
yarn pub:cadre-host
```

**`cadre-host` refuses to publish while its embedded release key is the all-zeros placeholder.**
The guard is in `scripts/publish-package.mjs`. Either provision a real key, or publish the other
four and hold `cadre-host` back. The escape hatch `CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1` exists for
testing the publish path and should not be used for a real release — an installer signed with a
key everyone has is an installer nobody can trust.

`yarn pub` is resumable. Before cleaning and building anything it asks the registry whether
`name@version` is already there and skips it if so, so re-running after a mid-chain failure picks up
exactly where it stopped. A registry that cannot be reached is a loud failure, never a silent
"not published" — the two answers are different, and conflating them would either skip a publish that
never happened or attempt one that did.

### 5. Push and create the GitHub release

```bash
node scripts/release-finish.mjs
```

This is the first step that touches anything outside this machine, and it runs only once npm has
every package. In order it:

1. `git push origin HEAD`, then `git push origin v{version}` — explicit, never `--follow-tags`, so an
   unrelated local tag is never pushed along for the ride.
2. `gh release create v{version} --verify-tag --notes-file .release-notes.pending.md`, adding
   `--prerelease` for a semver prerelease and `--latest=false` when the packages went out under a
   dist-tag other than `latest`, so GitHub's "Latest" badge agrees with what `npm install` returns.
3. Resets `.release-notes.pending.md` to its empty header and commits that as
   `chore: open release notes after v{version}`, ready for the next release.

Write the notes into `.release-notes.pending.md` *before* releasing. The preflight refuses to start
while that file is still just its header, which is what turns "GitHub release created with real
notes" from a checklist item you remember into one you cannot skip.

## Recovering a half-finished release

### The guard refused (nothing published, nothing pushed)

The bump commit and its tag are local only. Fix whatever the guard named and re-run `yarn release`,
or undo the bump first:

```bash
git tag -d v{version}
git reset --keep HEAD~1
```

`--keep`, not `--hard`: it refuses rather than discarding uncommitted work that has nothing to do
with the release.

### `yarn pub` failed partway (some packages on npm)

Fix the cause, then re-run the publish and finish steps — **not** `yarn release`, which would bump a
second version on top of the first:

```bash
yarn pub                          # skips what is already on npm
node scripts/release-finish.mjs
```

### `release-finish.mjs` failed (everything is on npm)

The packages are published and cannot be unpublished, so this is an unfinished release, not a failed
one — finish it rather than starting over. The script prints the exact commands still left to run,
starting at the step that failed. Typical cases:

- **Push rejected** (someone pushed to `master` meanwhile): rebase or merge, then re-run
  `node scripts/release-finish.mjs`. No GitHub release will have been created against a tag that is
  not on origin — `--verify-tag` sees to that.
- **`gh release create` failed**: run the printed `gh` command, then
  `node scripts/release-finish.mjs --notes-only` to reopen the notes file.
- **The notes reset failed**: `node scripts/release-finish.mjs --notes-only` on its own.

## Prerelease / RC

```bash
yarn bump --no-push --release prerelease --preid alpha   # e.g. 0.10.0-alpha.0
yarn bump --no-push --release prerelease --preid rc      # e.g. 0.2.0-rc.0
```

A prerelease **must** be published under a dist-tag, or it becomes what `npm install <pkg>` returns
and the prerelease label buys nothing. Two places refuse to let that happen by accident:
`scripts/release-guard.mjs` right after the bump, while the tag is still local, and
`scripts/publish-package.mjs` at publish time as a backstop for a hand-run `yarn pub`. Both share the
same check, so they cannot disagree. Set the tag deliberately, for the whole release:

```bash
# POSIX
SEREUS_DIST_TAG=alpha yarn release

# PowerShell (this repo's primary shell)
$env:SEREUS_DIST_TAG = 'alpha'; yarn release
```

Or, publishing by hand:

```bash
# POSIX
SEREUS_DIST_TAG=alpha yarn pub

# PowerShell (this repo's primary shell)
$env:SEREUS_DIST_TAG = 'alpha'; yarn pub
```

The environment variable, not `--tag`, is what tags the whole `yarn pub` chain: `yarn pub` is five
`&&`-ed publishes, and a `--tag` flag appended to the `yarn pub` invocation reaches only the last
command in that chain. `--tag` works for a single package's own script, where there is no chain to
lose the flag partway through:

```bash
yarn pub:cadre-core --tag alpha
```

Promoting a prerelease to `latest` later needs no republish:

```bash
npm dist-tag add @serfab/cadre-core@0.10.0-alpha.0 latest
```

## Version Alignment

All packages in the monorepo share the same version number. The `--recursive` flag in the bump
script ensures this stays in sync. Do not manually edit version numbers in individual
`package.json` files.

## Checklist

- [ ] `yarn build` succeeds
- [ ] `yarn test` passes, or every failure is known and recorded
- [ ] `yarn smoke:published` passes
- [ ] Clean working tree
- [ ] `.release-notes.pending.md` holds this release's notes (the preflight refuses an empty one)
- [ ] `gh auth status` is happy (the preflight refuses a logged-out `gh`)
- [ ] `yarn release` — or, by hand: `yarn bump --no-push` (choose the dist-tag deliberately if this
      is a prerelease), `node scripts/release-guard.mjs`, `yarn pub` (prefix
      `SEREUS_DIST_TAG=<tag>` for a prerelease), `node scripts/release-finish.mjs`

## Where the last release landed

The most recent release is `v0.13.0`, published to `latest` on 2026-09-10. The go/no-go reasoning
for the `v0.11.0` release before it, and the two standing constraints it left behind, are in
[`tickets/complete/cut-the-interim-release.md`](../tickets/complete/cut-the-interim-release.md).

> **Never take a release-readiness claim from a document.** Any statement about what is green is
> stale the moment the next fix lands, and a downstream team once held a multi-device project for
> two weeks on exactly that. Measure against the suite and
> [`tickets/.pre-existing-known.md`](../tickets/.pre-existing-known.md) at the time you cut.
