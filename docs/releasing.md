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

## Quick Release

```bash
yarn release
```

This runs `yarn bump` (interactive version prompt, commits, tags, pushes) then `yarn pub` (clean +
build + publish each package). `yarn pub` publishes under the `latest` dist-tag — see
"Prerelease / RC" below for why that is often the wrong thing.

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

### 3. Bump, commit, tag, and push

```bash
# Interactive — prompts for version type (major / minor / patch / prerelease)
yarn bump

# Or specify the release type directly
yarn bump --release patch
yarn bump --release minor
yarn bump --release major
```

`bumpp` will:
1. Update `version` in all `package.json` files (recursive)
2. Commit the changes
3. Create an annotated tag: `v{version}`
4. Push the commit and tag to `origin`

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

### 5. Create a GitHub release

```bash
gh release create v{version} --notes-file <notes>
```

## Prerelease / RC

```bash
yarn bump --release prerelease --preid alpha   # e.g. 0.10.0-alpha.0
yarn bump --release prerelease --preid rc      # e.g. 0.2.0-rc.0
```

A prerelease **must** be published under a dist-tag, or it becomes what `npm install <pkg>` returns
and the prerelease label buys nothing. `scripts/publish-package.mjs` refuses to publish a prerelease
version under no tag at all, so this cannot happen by accident — publish under a tag deliberately:

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
- [ ] `yarn bump` (choose the dist-tag deliberately if this is a prerelease)
- [ ] `yarn pub` (prefix `SEREUS_DIST_TAG=<tag>` for a prerelease), or per-package
      `yarn pub:<name> --tag <tag>`
- [ ] GitHub release created with real notes

## Where the last release landed

The most recent release is `v0.11.0`, published to `latest` on 2026-08-18. The go/no-go reasoning
for it, and the two standing constraints it left behind, are in
[`tickets/complete/cut-the-interim-release.md`](../tickets/complete/cut-the-interim-release.md).

> **Never take a release-readiness claim from a document.** Any statement about what is green is
> stale the moment the next fix lands, and a downstream team once held a multi-device project for
> two weeks on exactly that. Measure against the suite and
> [`tickets/.pre-existing-known.md`](../tickets/.pre-existing-known.md) at the time you cut.
