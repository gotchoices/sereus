description: A release can announce itself before npm will actually hand out all of its packages, so anyone who installs in the first minutes gets errors or a mix of old and new versions. Make the release wait until every package it published can really be downloaded before it creates the GitHub release.
files: package.json (release, pub, a new await-published script), scripts/release-finish.mjs, scripts/lib/release-support.mjs (registryHasVersion, interpretPackument), scripts/publish-package.mjs, ../optimystic/scripts/await-published.mjs and ../optimystic/scripts/published-visibility.mjs (read only: the pattern to port), ../Fret commit d8e2846 (read only: the same port)
----
# `yarn release` waits until every published package is installable

**Planner: give the implement ticket(s) you write from this one the header `review: skip`** (maintainer, 2026-09-30). This is release infrastructure ported from a proven pattern, and a review pass costs more than it is worth. The implementer still runs the new `node:test` file and `yarn test:release-finish` before handing off.

## What happened (1.8.0, 2026-09-30)

`yarn release` finished at about 18:35 UTC and created the GitHub release. At 18:38:
- `cadre-core`, `cadre-host` and `quereus-plugin-sereus` 1.8.0 returned 404 from the registry, packument and tarball alike;
- `cadre-cli`, `cadre-provider`, `cadre-rn` and `config-check` 1.8.0 were live.

`cadre-cli` 1.8.0 depends on `@serfab/cadre-core ^1.8.0`, so for those minutes a fresh install of the CLI failed. The version records (`/<name>/<version>`) all answered 200 by 18:40. The tarballs of the three lagging packages were still 404 after that: the packument and the tarball become visible at different moments. The tender at first took this for a partial publish.

## The pattern to port

optimystic `50435c72` / `618f3ed8`, ported to Fret as `d8e2846`:
- `yarn release` runs `yarn await-published` after `yarn pub`.
- `scripts/await-published.mjs` lists what `pub` publishes, polls `npm view <name>@<version>` until each is visible or a deadline passes (default 600 s, overridable by env), and prints one summary line.
- On timeout it names the missing packages and says npm already accepted the publish. It tells the operator to finish with `await-published` plus the remaining steps, not to re-run the release.
- The pure logic lives in a separate module tested with `node:test`.

## Differences for sereus

- **Where it goes:** `release` is `release-preflight && bump --no-push && release-guard && pub && release-finish`. The wait goes between `pub` and `release-finish`, so the tag push, GitHub release and notes reset happen only once everything is installable. `release-finish`'s failure messages (tested in `release-finish.test.mjs`) must still list the right remaining steps when the wait times out.
- **The package list:** read it from the root `pub` script's `pub:<name>` chain, as optimystic reads its own pub set. That keeps a new package, like `config-check` this release, covered without a second list.
- **Check the tarball, not only the version record.** Poll the manifest's `dist.tarball` URL with a GET or HEAD until it answers 200. 1.8.0 showed that `npm view` succeeds while `npm install` still fails. Reuse `registryUrl` from `release-support.mjs` and send `cache-control: no-cache`.
- **Env name:** `SEREUS_PUBLISH_WAIT_SECONDS`, matching `SEREUS_DIST_TAG`.
- **Tests:** a `node:test` file for the pure parts, in `yarn test` like the other `test:release-*` scripts: the package list parsed from `pub`, deciding visible, missing or keep waiting, and the timeout report. No network in tests.
- Document it in `AGENTS.md` or wherever the release steps are described, the way Fret's port did.

Tell optimystic-tend about the tarball finding, since optimystic's and Fret's versions only check `npm view`.
