description: A release no longer announces itself before npm can hand out all of its packages: it now waits until every package it published can really be downloaded, and only then pushes and creates the GitHub release.
architecture: docs/releasing.md
files: package.json, scripts/await-published.mjs, scripts/lib/published-visibility.mjs, scripts/await-published.test.mjs, scripts/lib/release-support.mjs, scripts/release-preflight.mjs, docs/releasing.md
----
# `yarn release` waits until every published package is installable

`review: skip` (maintainer, 2026-09-30); this went implement → complete with no review pass.

## What landed

- **`yarn release`** is now `preflight && bump --no-push && guard && pub && yarn await-published && release-finish`. The tag push, the GitHub release and the notes reset happen only once every package is installable. `release-finish.mjs` is unchanged.
- **`scripts/lib/published-visibility.mjs`** (pure; no fetch, no file reads, no exit):
  - `publishedPackageDirs(scripts)` follows the root `pub` `&&` chain (`yarn pub:<name>` steps are followed; `node scripts/publish-package.mjs <dir>` steps yield `<dir>`). Anything else throws and names the step. It reads the chain, not the `pub:*` keys, because a `pub:*` script outside the chain is never published by `yarn release`.
  - `expectedPackages(dirs, manifestAt)` returns name and version from each `packages/<dir>/package.json`.
  - `readPackumentAnswer({status, body}, spec, tag)`: 404 → not yet; other non-200 → not visible, reason `registry answered HTTP <n>`; 200 without the version → not yet; `dist-tags[tag ?? 'latest']` elsewhere → `dist-tag <tag> still points at <v>` (or `… is not set`); a tarball field that is not an http(s) URL → not visible, naming the field; otherwise `{ tarball }`. A 200 body that is not JSON or has no `versions` map throws.
  - `readTarballAnswer(status)`: 200 → visible, 404 → `tarball not downloadable yet`, other → `tarball answered HTTP <n>`.
  - `waitTimeoutMs(env)`: 600 s by default, or `SEREUS_PUBLISH_WAIT_SECONDS`. Anything but a positive finite number throws.
  - `waitForVisibility`, `specString`, `NOT_YET_VISIBLE`, `progressLine` and `successLine` are ported from optimystic/Fret with the same behaviour. `timeoutReport(stragglers, total, timeoutMs, { tag })` is sereus-specific. It prints the stragglers, says that npm accepted the publish, says "do NOT re-run `yarn release`", says that nothing has been pushed and no GitHub release exists, and lists `yarn await-published` then `node scripts/release-finish.mjs`. It adds a conditional line saying to run `yarn pub` first if a package was never published, and, when a tag is in use, says to keep `SEREUS_DIST_TAG=<tag>` set.
- **`scripts/await-published.mjs`** (entry):
  - The probe fetches the abbreviated packument (`accept: application/vnd.npm.install-v1+json`, `cache-control: no-cache`) from `registryUrl`, so it honours `SEREUS_NPM_REGISTRY` / `npm_config_registry`. Only once the packument lists the version under the tag does it GET the tarball with `no-cache` and cancel the body after reading the status.
  - Each fetch is bounded by `AbortSignal.timeout(30_000)`. A network error or timeout becomes the reason `could not reach <url>: <message> (<cause>)` and never throws.
  - The dist-tag comes from `resolveDistTag(argv, env)`. The script takes `--help`, prints progress every 5 s when something changes (and at least every 30 s), and exits 0 on success or 1 on timeout or setup failure.
  - The CDN `NOTE:` sits on the headers.
- **`scripts/lib/release-support.mjs`**: extracted `readPackumentJson(body, name)` (JSON parse plus the `versions`-map check, same messages as before). `interpretPackument` and `readPackumentAnswer` both use it. Updated the header's list of steps.
- **`package.json`**: new `await-published` and `test:await-published` scripts; `test:await-published` added to `test` after `test:release-finish`.
- **Docs**: `docs/releasing.md` changes:
  - the Quick Release table has six steps;
  - a new Step 5, "Wait until every package is installable", describes the three checks, the env var, and that the wait can be re-run safely; push/GitHub is now Step 6, and "until step 6" is updated;
  - there is a new recovery subsection, "`yarn await-published` timed out";
  - the "`yarn pub` failed partway" recovery now includes the wait;
  - the by-hand checklist includes the wait.

  The step-list header in `scripts/release-preflight.mjs` now says six steps.

## Where this differs from the plan

- `readTarballAnswer` takes only `status`, because the planned `spec` argument would have been unused.
- A setup failure prints the one `await-published: <message>` line, then two more lines. They say that inside `yarn release` the packages are already published, that you should not re-run `yarn release`, and what to run instead. Inside the chain, every failure of this script comes after an irreversible publish, so one bare line risked a second version bump.
- One test reads the real root `package.json`: "this repository's own `pub` chain is readable". The plan said no files. The reason: `publishedPackageDirs` refusing the real chain would otherwise surface only after a real publish. With the test, `yarn test` (part of `yarn check`, which the preflight asks about) catches it first.
- The success and progress lines say "installable from npm" rather than "visible on npm", to match what is actually checked.
- A dist-tag that is absent from the packument (rather than pointing elsewhere) gets its own reason, `dist-tag <tag> is not set`.

## Tests added (`scripts/await-published.test.mjs`, 16 tests, offline)

- `publishedPackageDirs`: follows `pub` → `pub:a`, `pub:b` in order, and ignores a `pub:*` outside the chain. A `yarn build` step throws and names it. The repo's own `pub` chain parses.
- `readPackumentAnswer`:
  - under `alpha`, with `latest` elsewhere, the result is `{ tarball }`, which covers the prerelease-tag case;
  - 404 → not yet;
  - a missing version → not yet;
  - tag pointing at 1.7.0 → the exact reason;
  - 503 → reason with the status;
  - a non-JSON 200 throws.
- `readTarballAnswer`: 200 visible, 404 not yet.
- `waitForVisibility` (fake clock):
  - a package that has been seen is not asked again;
  - stragglers at the deadline come back with their latest reason, and the final round runs at exactly the deadline (asked at 0, 5 000, 10 000 and 12 000 ms);
  - a package that appears on the deadline round counts as seen.
- `timeoutReport`:
  - it names the stragglers, says npm accepted the publish, says "Do NOT re-run", lists await-published before release-finish, and mentions no tag when there is none;
  - with `alpha` it says to keep `SEREUS_DIST_TAG=alpha` set.
- `waitTimeoutMs`: unset → 600 000, `'90'` → 90 000, and `'0'`, `'-5'` and `'abc'` throw.

The entry's probe composition (packument, then tarball) and the network-error path have no test, as the plan said. Both were checked by running the script (below).

## Validation

- `yarn test:await-published` passed 16 tests, `yarn test:release-support` 13, `yarn test:release-finish` 16, `yarn test:release-guard` 11, `yarn test:release-preflight` 15 and `yarn test:publish-package` 20. `yarn lint` exits 0. `scripts/` is excluded from both eslint and knip, so lint does not cover the new files.
- Manual runs against the live registry. Each one only reads; nothing was published or pushed.
  - `node scripts/await-published.mjs` printed `all 7 packages published and installable from npm at 1.8.0` in about 0.9 s and exited 0.
  - `SEREUS_DIST_TAG=alpha SEREUS_PUBLISH_WAIT_SECONDS=6` timed out after 6 s. Every package showed `dist-tag alpha is not set`, the full report printed including the tag paragraph, and it exited 1.
  - `SEREUS_NPM_REGISTRY=http://127.0.0.1:9` kept waiting with the reason `could not reach … fetch failed (bad port)` and did not throw.
  - `SEREUS_PUBLISH_WAIT_SECONDS=abc`, and a stray argument, were each refused at start-up with the extra lines, and exited 1.
  - `--help` exited 0.
- Not exercised: a real release in which a tarball actually lags. That can only be seen during the next publish.

## Review findings

The review pass was skipped. The implementer recorded these tripwires:

- **CDN edges.** `cache-control: no-cache` may see the origin before every CDN edge does. Parked as a `NOTE:` at `NO_CACHE` in `scripts/await-published.mjs`.
- **Setup runs after the publish.** Inside `yarn release`, the wait's setup checks (the `pub` chain parse, `SEREUS_PUBLISH_WAIT_SECONDS`, the dist-tag) run after the publish, so a refusal stops a release that is already published. Parked as a `NOTE:` in `main()` of `scripts/await-published.mjs`: if one ever refuses a real release, run those checks from `release-guard.mjs` too. The test that reads the real `pub` chain and the extra lines in the failure message reduce the risk today.
