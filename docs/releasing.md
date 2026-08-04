# Release Process

## Overview

Sereus uses [bumpp](https://github.com/antfu/bumpp) for version bumping and follows semver.
Tags use the `v` prefix (e.g. `v0.1.0`). All packages in the monorepo share one version number.

Six workspaces are publishable, and the `pub:*` scripts in the root `package.json` are the list of
record — `yarn smoke:published` derives its set from them, so a package becomes covered the moment
it gets a `pub:*` script:

`strand-proto`, `quereus-plugin-sereus`, `cadre-core`, `cadre-cli`, `cadre-provider`, `cadre-host`.

Publish order matters and `yarn pub` already encodes it (dependency chain first):
`strand-proto` → `quereus-plugin-sereus` → `cadre-core` → `cadre-cli` → `cadre-provider` →
`cadre-host`.

## Prerequisites

- `yarn build` succeeds
- `yarn test` passes, or every failure is a *known* one recorded in
  `tickets/.pre-existing-known.md` and you have read what it is
- `yarn smoke:published` passes — this is the one that installs the packages the way a customer
  does. It is not part of `yarn test` (it needs the network). See
  [`STATUS.md`](STATUS.md#installing-what-a-customer-installs--yarn-smokepublished-a-release-step-not-a-test).
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
project outside this repo, and runs a single-node control-database scenario against them. This is
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
yarn pub:strand-proto
yarn pub:quereus-plugin-sereus
yarn pub:cadre-core
yarn pub:cadre-cli
yarn pub:cadre-provider
yarn pub:cadre-host
```

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
and the prerelease label buys nothing.

`scripts/publish-package.js` currently runs a bare `yarn npm publish --access public`, which always
tags `latest`. Passing a tag through is `tickets/implement/0.2-release-publish-dist-tag`; until that
lands, publish a prerelease by hand from each package directory:

```bash
cd packages/<name> && yarn clean && yarn build && yarn npm publish --access public --tag alpha
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
- [ ] `yarn pub`, or per-package `yarn npm publish --tag <tag>`
- [ ] GitHub release created with real notes

---

# The interim release — recommendation and runbook (drafted 2026-08-03)

Everything below concerns the next release specifically. It is a recommendation with reasons, not a
menu; the actual go/no-go and the outward-facing publish are
`tickets/blocked/cut-the-interim-release`.

## Recommendation

**Version `0.10.0-alpha.0`, published under the `alpha` dist-tag, for five of the six packages
(everything except `strand-proto`), with the declared dependency floors moved to `^0.19.0`.**

### Why a minor bump, not a patch

The change set since 0.9.0 is not a patch. The declared minimum for the underlying
database/networking layer moved five minor versions (`^0.14.1` → `^0.19.0`), which changes what a
consumer's dependency tree resolves to; the control-database schema gained tables; push delivery and
node donation are new subsystems. `0.9.1` would understate all of that.

### Why a prerelease under `alpha`, not `latest`

Cross-machine replication is known-broken with a traced root cause (see
[`STATUS.md`](STATUS.md#release-readiness--measured-2026-08-03)). `latest` is what
`npm install @serfab/cadre-core` returns and therefore means "this is the version to use" — which,
for a library whose whole premise is multiple devices sharing data, would be a claim we cannot
support. The tag costs the one consumer who is waiting on this nothing: the reply drafted in
`tickets/blocked/report-dependency-floor-bump-to-embedding-app` already asks them to **pin** to the
new version rather than track `latest`.

Leaving `latest` at 0.9.0 also has a concrete benefit: 0.9.0 resolves to the pre-defect `0.14.1`
line of the sibling packages, so it at least imports. Anything published from current HEAD does not
(see the blocker below).

Once the coordinator fix lands upstream and multi-machine goes green, promote with
`npm dist-tag add`, no republish required.

### Which packages ship: five, not six

Drop `strand-proto` from this release. It is called deprecated in `AGENTS.md`, `eslint.config.mjs`
and `STATUS.md`; nothing in this repo depends on it; nothing in it has changed since the 0.9.0
release commit except a type-check config edit. Publishing a new version of it would ship a
version-number change and nothing else, while adding a workspace to every `yarn smoke:published`
run.

This is deliberately the *narrow* call. Not publishing a new version is not unpublishing: 0.9.0
stays on npm and keeps resolving for any external consumer this repo cannot see. The permanent
question — keep shipping it or stop for good — remains
`tickets/blocked/publish-deprecated-strand-proto-decision`.

### Dependency floors: moved to `^0.19.0` (landed 2026-08-03)

`../optimystic` cut `v0.19.0` on 2026-08-03 and it is on npm as `latest`, so that is now both what
this repo links and what a consumer installing the sibling packages gets. Because these are `0.x`
versions, `^0.18.0` meant `>=0.18.0 <0.19.0` and *excluded* it, so `yarn check:dep-ranges` was red on
22 ranges. All 24 declared `@optimystic/*` ranges moved to `^0.19.0` on 2026-08-03
(`tickets/complete/0.15-bump-optimystic-floors-to-0.19`) — the 22 the gate covers plus the two
`db-p2p-storage-fs` ones it does not (that package is not a `link:` target); the gate now reports
zero too-old ranges.

This is not a speculative bump to a version nobody can install. `0.19.0` is a
**version-numbers-only** release (`git show --stat 9b86eb3` in that repo is twelve `package.json`
files, one line each) sitting directly on the commit every measurement above was taken against — so
it is the same code, published.

It carries neither of the two fixes this release cares about: not the coordinator fix that
cross-machine replication needs, and not the `chai` import chain that blocks publishing at all. If a
*fixed* sibling release appears before this release is cut, take that one instead, and re-measure
the "not ready" section of the notes below rather than reprinting it.

## The blocker that must clear first

**A release built from current HEAD cannot be imported by anyone who installs it.**
`@optimystic/quereus-plugin-optimystic` imports a test-only entry point of `@optimystic/db-p2p` from
its shipped runtime code, and one file behind that entry point imports `chai`, which is a
development dependency and is therefore not installed for consumers. Loading
`@serfab/cadre-core` from a registry install throws `ERR_MODULE_NOT_FOUND` before running a line of
our code. Verified by real tarball install; present in every published `0.16.2` and later,
**including `0.19.0`**, and still unfixed at `../optimystic`'s HEAD.

Full analysis, and the three concrete upstream sites,
are in `tickets/blocked/optimystic-testing-barrel-breaks-consumer-install`.

**Recommended route: fix it upstream and wait for a `0.18.1`.** The change is small and belongs
where the defect is. The alternative — declaring `chai` as a real dependency of our own packages —
does work (verified), but it ships a test-assertion library to every customer to cover another
project's bug, and it is easy to forget to remove. If it is chosen, time-box it: it should be a
declared dependency on `@serfab/cadre-core` and `@serfab/quereus-plugin-sereus` with a `NOTE:`
naming this ticket, plus a `backlog/debt-` ticket to remove it.

## Draft release notes — `v0.10.0-alpha.0`

Paste as the GitHub release body and adjust the version if it changes. Re-measure before publishing
if more than a few days have passed; the numbers are the point.

> ## `@serfab/*` 0.10.0-alpha.0
>
> This is an **interim, single-machine release**, published under the `alpha` dist-tag. It does not
> become what `npm install @serfab/cadre-core` returns — install it explicitly, and pin it.
>
> ### Why it exists
>
> The published 0.9.0 declares a minimum version of its underlying database and networking layer
> (`@optimystic/*`) that is two minor versions behind the one we actually build and test against.
> An app installing 0.9.0 from npm therefore gets a lower layer nobody here has ever tested on — and
> ends up with two incompatible copies of the SQL engine loaded in one process. This release
> declares the tested versions, so an install resolves to a single, coherent set.
>
> ### What is tested and working
>
> Everything on this list is covered by tests that pass at the released commit:
>
> - **A single node, on its own** — a "cadre of one", the first-run state of every embedding app.
>   Control reads and writes complete from local state without consulting a network it knows is
>   empty, across both node profiles and across a restart. Verified against the packages as
>   actually published, installed from the registry into a clean project.
> - **A node whose known peers are all unreachable** — answers control reads and writes from local
>   rows rather than hanging.
> - **The control database** — ownership and validation keys, peer records, device tokens, strand
>   records, formation invitations and their redemption (including approval-gated redemption over a
>   real HTTP approver), revocation, and the authorization rules over all of it.
> - **Strand formation and membership**, including closed strands, invitation binding, single-use
>   and multi-use invitations, cancellation, and manager promotion — proven over real libp2p between
>   processes on one machine.
> - **Node enrollment and seeding** — owner-signed seeds, cold-start trust anchoring, pinned owner
>   keys, rejection of tampered, expired, and self-asserted seeds.
> - **Connection-level membership gating** — strangers refused at the connection layer, members and
>   invitees admitted, delegates admitted narrowly.
> - **Push-wake and hibernation** — strand hibernation, check-in wake, push-wake over a real direct
>   dial and over a circuit relay, and the FCM/APNs delivery layer.
> - **Self-hosting and multi-tenant hosting** — `cadre-host` node donation, grant tokens, the
>   trust-circle flow, respawn of a crashed donated node, and `cadre-provider` per-tenant container
>   provisioning and credential isolation.
>
> ### What is NOT ready — read this before building on it
>
> **Cross-machine replication does not work in this release.** This is not "experimental" or "under
> active development". It is a known defect with a traced root cause, and it will bite you:
>
> - When a second machine joins, a read of a shared table can be answered "nothing was ever saved
>   here" by whichever machine the lookup routes to, even when another machine in the group holds
>   the data. That machine never asks its peers before answering.
> - Once that happens, the writing machine refuses every subsequent write to that table with
>   `holds committed revision N, but its header block read as absent`. **The state is permanent for
>   that collection, not transient** — the routing does not change back.
> - It is a routing race, so it does not fail on every run. A green run proves nothing.
>
> The fault is a single line in `@optimystic/db-p2p`, not in this project, and no code change here
> can work around it. It is fixed by a new `@optimystic/*` release, not by a new `@serfab/*` one.
>
> Concretely, **do not** build on: data shared between two or more devices, a phone syncing with a
> home server, donated or provider-hosted nodes carrying a copy of your data, or any read that is
> expected to reach a row written on a different machine. Do build on: a single node holding its
> own data, and everything in the working list above.
>
> Two smaller known issues: owner-signed revocation re-issue fails on a defect in the SQL engine's
> handling of an update that does not touch the primary key, and a small number of strand-mesh
> operations between two peers hit the same absent-block routing race described above.
>
> ### Upgrading from 0.9.0
>
> Pin the exact version — this is a prerelease and will not be matched by a `^0.9.0` range. If you
> added manual timeouts around single-node control reads or writes as a workaround, remove them and
> tell us whether anything still hangs; we were not able to reproduce a single-node freeze at either
> version.

## What the human has to run, in order

Nothing below can be done by an agent: step 1 is another team's repo, and steps 5–8 are
outward-facing and irreversible.

1. **Get the `chai` import chain fixed upstream and published.** In `../optimystic`, stop
   `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts` importing
   `@optimystic/db-p2p/testing` from shipped runtime code (or drop
   `packages/db-p2p/src/testing/raw-storage-conformance.ts` from that barrel), then publish — likely
   `0.19.1`. Nothing else on this list is worth starting until an installable version exists.
   *If you instead choose the local workaround, see "The blocker that must clear first" above.*
2. **Point the floors at whatever that publishes.** They already sit at `^0.19.0` (landed
   2026-08-03) and the gate is green; if the fix ships as something later, move them again:
   ```bash
   yarn upgrade:optimystic && yarn install && yarn check:dep-ranges
   ```
   This gate must report zero too-old ranges before going further.
3. **Re-measure.** The numbers in the notes above are from 2026-08-03 and the multi-machine
   failures are races:
   ```bash
   yarn build
   cd packages/integration-tests && npx vitest run          # expect ~8 files red, all multi-machine
   ```
4. **Prove the published artifact imports.** This is the gate that was red:
   ```bash
   yarn smoke:published
   ```
5. **Bump.** Choose prerelease / `alpha`:
   ```bash
   yarn bump --release prerelease --preid alpha             # → 0.10.0-alpha.0
   ```
6. **Publish five packages under the `alpha` tag** — not `yarn pub`, which tags `latest` and
   includes `strand-proto`. Once `tickets/implement/0.2-release-publish-dist-tag` has landed this is
   `yarn pub --tag alpha` minus that package; until then, from the repo root, per package
   (`quereus-plugin-sereus`, `cadre-core`, `cadre-cli`, `cadre-provider`, `cadre-host`, in that
   order):
   ```bash
   cd packages/<name> && yarn clean && yarn build && yarn npm publish --access public --tag alpha
   ```
   `cadre-host` additionally refuses to publish while its embedded release key is the all-zeros
   placeholder — see `scripts/publish-package.js`. Resolve that before its turn, or publish the
   other four and hold it back.
7. **Confirm `latest` did not move:**
   ```bash
   npm view @serfab/cadre-core dist-tags     # expect latest: 0.9.0, alpha: 0.10.0-alpha.0
   ```
8. **Send the reply** drafted in
   `tickets/blocked/report-dependency-floor-bump-to-embedding-app`, with the real version number in
   it, and record where it went so the next person has the channel.
9. **Cut the GitHub release** with the notes above:
   ```bash
   gh release create v0.10.0-alpha.0 --notes-file <notes> --prerelease
   ```
