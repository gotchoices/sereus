# Releasing

How a maintainer publishes a release of the `@serfab/*` packages to npm, how to finish a release that stopped partway, how to publish a prerelease, and what the two checks that install published packages do.

Related: [testing.md](testing.md) (the commands a release depends on), [gates.md](gates.md) (what each check covers), [cadre-host.md](../hosting/cadre-host.md) (the release-signing key and manifest for cadre-host updates).

## Packages and versions

Seven workspaces are published. The scripts in the root `package.json` are the list of record. The release guard and `yarn smoke:published` cover every package that has a `pub:<name>` script, and the registry wait covers the packages the `pub` chain names. A new publishable package needs both: its own `pub:<name>` script and a place in `pub`.

`yarn pub` publishes in dependency order: `config-check`, `quereus-plugin-sereus`, `cadre-core`, `cadre-cli`, `cadre-provider`, `cadre-host`, `cadre-rn`.

Every package in the repository carries the same version number. [bumpp](https://github.com/antfu/bumpp) sets it in all of them (`yarn bump` is `bumpp --recursive`), commits, and creates the tag `v{version}`. Do not edit a version by hand; the release guard refuses a release in which a publishable package's version differs from the root's.

## Checklist

- [ ] `yarn check` passes on the commit being released, or every failure is recorded in `tickets/.pre-existing-known.md` and you have read what it is. Run it now; a statement in a document or a ticket that the suite is green describes an earlier commit.
- [ ] The working tree is clean and the branch is not behind origin. The preflight warns about both and does not refuse.
- [ ] `.release-notes.pending.md` holds this release's notes. It becomes the body of the GitHub release.
- [ ] `gh auth status` succeeds, because the release creates the GitHub release page.
- [ ] For a prerelease, `SEREUS_DIST_TAG` is set ([Prerelease](#prerelease)).
- [ ] `yarn release`.

## Quick release

```bash
yarn release
```

No commit or tag is pushed until every package is on npm. Every check that can refuse a release runs before the publish and before the push, so a refusal costs a local `git reset` and nothing else. `yarn release` is six commands chained with `&&`, and a failure stops the chain at a known point:

| # | Command | What it does | What it can refuse |
|---|---|---|---|
| 1 | `node scripts/release-preflight.mjs` | Reports the tree, branch, dist-tag and GitHub state, then asks for confirmation | No confirmation; `gh` missing or logged out; pending notes missing or empty |
| 2 | `yarn bump --no-push` | Prompts for the version, commits and tags locally | Nothing |
| 3 | `node scripts/release-guard.mjs` | Checks the bumped state | A package the bump missed; a prerelease without a dist-tag; a tag that is missing or not at `HEAD`; a version already fully published |
| 4 | `yarn pub` | Cleans, builds and publishes each package in order | A prerelease without a dist-tag; the cadre-host placeholder release key; a build failure |
| 5 | `yarn await-published` | Waits until every package can be installed from npm | Nothing; it exits non-zero when its deadline passes |
| 6 | `node scripts/release-finish.mjs` | Pushes the commit and tag, creates the GitHub release, resets the notes file | Nothing |

Steps 1 to 3 run before anything is published or pushed. A failure in step 5 or 6 happens after an irreversible publish, so it leaves an unfinished release, not a failed one: see [Recovering](#recovering).

Do not append arguments to `yarn release`. Yarn passes an appended argument to the last command of the chain only, `release-finish.mjs`. The first five steps run as if the argument were absent, and the finish step then refuses any flag other than `--notes-only` and `--tag <name>`, after the packages are published. `yarn release --yes` therefore still stops at the preflight prompt. Options for the whole chain are environment variables:

| Variable | Effect |
|---|---|
| `SEREUS_DIST_TAG=<tag>` | Publishes under that npm dist-tag instead of `latest`. Required for a prerelease. |
| `SEREUS_GH_RELEASE=0` | Skips the GitHub release. The preflight stops checking `gh` and the notes, the finish step pushes and stops, and the pending notes are left untouched. |
| `CI=1` | Skips the preflight's confirmation prompt. |
| `SEREUS_PUBLISH_WAIT_SECONDS=<n>` | Changes the registry wait's deadline from 600 seconds. |
| `SEREUS_NPM_REGISTRY=<url>` | The registry the wait and the already-published checks read. Defaults to `npm_config_registry`, then the public registry. |

### Preflight confirmation

The preflight does not run the checks. It lists what `yarn check` covers and requires the word `checked` to be typed at its prompt, as confirmation that `yarn check` passed. Letter case and surrounding spaces are ignored. Any other answer, `y` and `yes` included, aborts with nothing bumped or published.

`CI=1` or `CI=true` in the environment skips the prompt; no other value of `CI` does. So does `--yes` or `-y`, but only when the script is run on its own (`node scripts/release-preflight.mjs --yes`), because `yarn release` does not pass arguments to it. Without a terminal and without a bypass the script aborts instead of assuming consent; its message suggests `--yes`, and inside `yarn release` the bypass that works is `CI=1`. The bypass skips only the prompt. The refusals for `gh` and for the release notes still apply; only `SEREUS_GH_RELEASE=0` removes them.

### Bump

`yarn bump --no-push` prompts for the release type. `--no-push` keeps the release commit and its tag on this machine until the last step, so a refusal in the guard or a failure in the publish leaves nothing public to clean up. To choose the version without the prompt, run the steps by hand and pass `--release`:

```bash
yarn bump --no-push --release patch      # or minor, major, or an exact version
```

### Publish

`yarn pub` runs one `pub:<package>` script per package, and each can be run alone. Before building, a package's script asks the registry whether its `name@version` already exists and skips the package if so, which makes `yarn pub` safe to run again after a failure partway. A registry that cannot be reached is a failure, never a "not published" answer.

`cadre-host` refuses to publish while the release key compiled into it is the all-zero placeholder, because that build would reject every authentic update manifest. Provision a real key as [cadre-host.md](../hosting/cadre-host.md) describes, or publish the other packages and hold `cadre-host` back. `CADRE_HOST_ALLOW_PLACEHOLDER_KEY=1` bypasses the refusal for testing the publish path, and must not be used for a real release.

### Wait

`npm publish` returning does not mean the package can be installed: the registry starts serving each package, and each version's record and tarball, at different moments. For every published package, `yarn await-published` asks the registry every five seconds until a single probe finds that the package's metadata lists the version, that the dist-tag (`SEREUS_DIST_TAG`, or `latest`) points at it, and that the tarball downloads. When the deadline passes first, it names each package still missing, with the reason. It only reads the registry, so it can be run again at any time.

### Finish

`release-finish.mjs` is the first step that changes the git remote or GitHub. In order:

1. `git push origin HEAD`, then `git push origin v{version}`. The tag is pushed by name, so no unrelated local tag is pushed with it.
2. `gh release create v{version} --verify-tag --notes-file .release-notes.pending.md`. It adds `--prerelease` for a prerelease version, and `--latest=false` when the packages went out under a dist-tag other than `latest`, so GitHub's "Latest" label agrees with what `npm install` returns.
3. Resets `.release-notes.pending.md` to its empty header, commits that, and pushes.

`--notes-only` runs the third step alone.

## Recovering

### The guard refused

Nothing is published and nothing is pushed. The bump commit and its tag are local. Fix what the guard named and run `yarn release` again, or undo the bump first with the two commands the guard prints:

```bash
git tag -d v{version}
git reset --keep HEAD~1
```

`--keep`, not `--hard`: it refuses instead of discarding uncommitted work that is unrelated to the release.

### `yarn pub` failed partway

Some packages are on npm. Fix the cause, then run the remaining steps. Do not run `yarn release`, which would bump a second version on top of the first.

```bash
yarn pub                          # skips what is already on npm
yarn await-published
node scripts/release-finish.mjs
```

The registry can report a version published seconds ago as absent. `yarn pub` run again immediately may then try to publish a package that did land, and npm refuses to publish over an existing version. Nothing is harmed; wait a few minutes and run it again.

### `yarn await-published` timed out

Every package was accepted by npm, nothing is pushed and no GitHub release exists. Do not run `yarn release`. Once the registry serves the packages:

```bash
yarn await-published
node scripts/release-finish.mjs
```

If a package the report names was never published, run `yarn pub` before those two.

### `release-finish.mjs` failed

The packages are on npm and cannot be withdrawn. The script prints the commands still to run, starting at the step that failed.

- **Push rejected** because someone pushed to `master` in the meantime: rebase or merge, then run `node scripts/release-finish.mjs` again. No GitHub release was created, because `--verify-tag` refuses a tag that is not on origin.
- **`gh release create` failed:** run the printed `gh` command, then `node scripts/release-finish.mjs --notes-only`.
- **The notes reset failed:** `node scripts/release-finish.mjs --notes-only`.

For a release under a dist-tag, keep `SEREUS_DIST_TAG` set for every recovery command. The wait checks that tag, and the finish step reads it from the environment to decide GitHub's "Latest" label. A resumed `yarn pub` under a different tag would leave the packages split between two tags.

## Prerelease

A prerelease version (`1.24.0-rc.0`) must be published under a dist-tag. Without one it becomes `latest`, the version a plain `npm install <package>` returns. The release guard refuses a prerelease without a tag right after the bump, and each `pub:*` script refuses it again at publish time, for a publish run by hand. Both use the same check.

Set the tag in the environment for the whole release:

```bash
SEREUS_DIST_TAG=rc yarn release
```

```powershell
$env:SEREUS_DIST_TAG = 'rc'; yarn release
```

At the bump prompt choose a prerelease type. By hand, the bump is `yarn bump --no-push --release prerelease --preid rc`, followed by the guard, `yarn pub`, `yarn await-published` and the finish script, all with the variable set.

The environment variable, not `--tag`, is what tags the whole chain. `yarn pub` is a chain of per-package publishes joined with `&&`, and a `--tag` appended to it reaches only the last package. `--tag` works on a single package's script: `yarn pub:cadre-core --tag rc`.

`SEREUS_DIST_TAG=latest` publishes a prerelease as `latest` on purpose. An explicit `latest` is treated as a decision, and an absent tag as an oversight.

Moving a published prerelease to `latest` later needs no new publish:

```bash
npm dist-tag add @serfab/cadre-core@1.24.0-rc.0 latest
```

## Published-package checks

Every suite in this repository resolves `@optimystic/*` and `@quereus/quereus` to sibling checkouts through the root `resolutions`. A passing suite therefore says nothing about the packages on npm. The [declared-range check](gates.md#declared-dependency-ranges) proves a declared range admits the linked version, and installs nothing. Two commands install. Neither is part of `yarn test`, because both need the npm registry.

| | `yarn smoke:published` | `yarn check:published` |
|---|---|---|
| Question it answers | Do our packages, as packed, install and run in a consumer's project? | Do our own suites pass against the sibling versions on npm? |
| What comes from where | Our packages from tarballs packed here; everything else from npm | Our packages from the working tree; sibling packages from npm |
| What it runs | One scenario | `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` |
| When to run | Before every release. It is the last step of `yarn check`. | Before a release when the maintainer wants it, and with `--skip-gates` after raising a sibling range |
| Cost | Tens of seconds after the build | Minutes with `--skip-gates`; a full run repeats every gate, the integration suite included |

### `yarn smoke:published`

`scripts/smoke-published-install.mjs` builds, then packs every package that has a `pub:*` script. Packing rewrites `workspace:` ranges to real versions, so the tarballs are what a publish would upload. It installs them with npm into a scratch project under the operating system's temporary directory, outside the repository, so that no `resolutions` and no workspace settings reach the install. It then:

- prints the version and path of every `@serfab/*`, `@optimystic/*` and `@quereus/*` package as installed, and every nested copy that a package resolves instead of the hoisted one;
- fails if npm took one of our own packages from the registry instead of from its tarball, which would test the previous release;
- fails if an installed package's `exports` names a file its tarball lacks;
- runs `scripts/lib/published-smoke-scenario.mjs`: a lone device's control database, from first start through a restart alone over the peer rows a vanished cohort left on disk.

`--skip-build` reuses the existing `dist` directories and is refused when one is missing or older than its sources. `--keep` keeps the scratch project; a failing run always keeps it and prints its path.

Never install a missing dependency into the scratch project to make the run pass. A package that fails to import from a registry install is the defect this check exists to find, and the fix belongs in the package that omitted the dependency, here or upstream. To confirm the scenario itself is sound while the check is red, run `node scripts/lib/published-smoke-scenario.mjs` inside the repository. That proves the scenario, not the registry install.

### `yarn check:published`

`scripts/check-published.mjs` adds a detached git worktree at `HEAD` under the temporary directory, deletes the `resolutions` key from its root `package.json`, runs `yarn install --no-immutable` there, reports which version each sibling package resolved to, runs the four root commands, and removes the worktree.

- **A working tree that differs from `HEAD` is refused,** because the worktree is built from `HEAD`. `--allow-dirty` proceeds, and the uncommitted changes are not checked.
- **`--skip-gates` stops after the report.** It answers the question that fails most often, whether the published siblings resolve and at which versions, and it is the only form short enough to run inside a ticket.
- **`--keep`** leaves the worktree in place.

A failure has one of three causes, and the report at the top of the output says which:

- **A sibling resolved from npm at a version older than the linked checkout.** The declared range is behind: run `yarn upgrade:optimystic` or `yarn upgrade:quereus`.
- **A real defect against the published sibling at that version.** Fix it here or upstream.
- **A test that assumed the linked layout.** That is a defect in the test. A test whose expectation depends on a package being linked decides it from `linkedResolutions` in `test-harness/build-targets.ts`.

During the install Yarn may report that the optional native package `cpu-features` could not be built. That is not a failure and does not affect the run.
