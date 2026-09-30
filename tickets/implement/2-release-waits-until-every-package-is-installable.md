description: A release can announce itself before npm will actually hand out all of its packages, so anyone who installs in the first minutes gets errors or a mix of old and new versions. Make the release wait until every package it published can really be downloaded before it pushes and creates the GitHub release.
architecture: docs/releasing.md
files: package.json (release, test, new await-published + test:await-published scripts), scripts/await-published.mjs (new), scripts/lib/published-visibility.mjs (new), scripts/await-published.test.mjs (new), scripts/lib/release-support.mjs (registryUrl, header comment), scripts/release-finish.mjs (read: FINISH_STEPS, reportUnfinished wording), scripts/publish-package.mjs (read: resolveDistTag), scripts/release-preflight.mjs (header comment step list), docs/releasing.md, ../optimystic/scripts/published-visibility.mjs and ../optimystic/scripts/await-published.mjs (read only: the pattern to port)
review: skip
----
# `yarn release` waits until every published package is installable

`review: skip` was set by the maintainer (2026-09-30). This is release infrastructure ported from a proven pattern. The implementer still runs `yarn test:await-published` and `yarn test:release-finish` before handing off.

## Why

After the 1.8.0 release (2026-09-30) the GitHub release was up while `cadre-core`, `cadre-host` and `quereus-plugin-sereus` 1.8.0 still answered 404. `cadre-cli` 1.8.0 depends on `@serfab/cadre-core ^1.8.0`, so a fresh CLI install failed for several minutes. The version records (`/<name>/<version>`) answered 200 before the tarballs did. So a check on the version record alone (what optimystic's and Fret's `npm view` wait does) would have reported success too early. optimystic-tend was told about this at plan time; nothing is owed there.

## Design

### Where it runs

```
release: node scripts/release-preflight.mjs && yarn bump --no-push && node scripts/release-guard.mjs && yarn pub && yarn await-published && node scripts/release-finish.mjs
await-published: node scripts/await-published.mjs
test:await-published: node --test scripts/await-published.test.mjs     (add to the `test` chain beside test:release-finish)
```

The wait sits between `pub` and `release-finish`. The tag push, the GitHub release and the notes reset therefore happen only once every package is installable. `release-finish.mjs` does not change. Its "npm publish succeeded — every package is on npm" message is now actually true when it runs inside `yarn release`.

### Files (sereus conventions: pure logic in `scripts/lib/`, entry script with a thin shell, `node:test` file in `scripts/`)

- `scripts/lib/published-visibility.mjs` holds the pure half. It runs no command, does no fetch, reads no file and never exits. Port the shape of `../optimystic/scripts/published-visibility.mjs`, with the differences listed below.
- `scripts/await-published.mjs` is the entry. It reads the root `package.json` and each package manifest, runs the fetch probes, prints progress, and exits 0 or 1. It supports `--help`. It takes the same argv/env dist-tag resolution as `release-finish.mjs`: `resolveDistTag(argv.slice(2), env)` imported from `publish-package.mjs`, with an unknown argument refused there. Wrap `main()` so that a setup failure prints one line (`await-published: <message>`) and exits 1.

### Which packages: the `pub` chain

`publishedPackageDirs(scripts)` follows the root `pub` script. `pub` is a chain of `&&` steps. Each step must be one of two things:
- `yarn pub:<name>`, which is followed into that script;
- `node scripts/publish-package.mjs <dir>`, which yields `<dir>`, relative to `packages/`.

Anything else throws. It names the script and the step, because a step this cannot read might publish a package the wait never asks about. A script that runs itself also throws, and so does a chain that publishes nothing. Port Fret's `publishedPackageDirs` / `publishStepDirs` / `stepDirs` (`../Fret` commit `d8e2846`, `scripts/published-visibility.js`), changing only the extension to `.mjs`.

Read the `pub` chain, not the `pub:*` keys that `publishableWorkspaces` in `scripts/lib/published-smoke-support.mjs` reads. A `pub:x` script that is not in the chain is never published by `yarn release`, so waiting on it would always time out. The two lists answer different questions ("what could be published" and "what this release publishes"), so there is no duplication to remove.

`expectedPackages(dirs, manifestAt)` returns `{ name, version }` for each directory, from `packages/<dir>/package.json`. It throws on a missing or implausible name or version. Port Fret's version, including its `PACKAGE_NAME_RE` and `VERSION_RE`.

### What "installable" means: three checks, all over HTTPS fetch

Use fetch, not `npm view`. The reason is the one `registryHasVersion` in `release-support.mjs` gives: node will not spawn `npm.cmd` on Windows without a shell. It also removes optimystic's Windows child-process kill NOTE entirely.

A package counts as visible when all three of these are true in one probe:
1. The **abbreviated packument** at `registryUrl(name, env)` lists the version. Request it with `accept: application/vnd.npm.install-v1+json` (the document installers read) and `cache-control: no-cache`. This is what a `^1.8.0` range resolves against. A packument without the version means the installer picks an older version, or fails with `ETARGET`.
2. The packument's `dist-tags[tag ?? 'latest']` equals the version. This is what `npm install @serfab/cadre-cli` with no range returns. It is the same document, so the check costs one comparison. The release-finish "Latest" badge already assumes it.
3. A **GET of that version's `dist.tarball`** (sent with `cache-control: no-cache`) answers 200. Cancel the response body as soon as the status is read (`await response.body?.cancel()`), so no probe downloads a tarball. Use GET rather than HEAD so nothing depends on whether the registry's CDN supports HEAD on tarballs. The GET succeeds at most once per package, because a package that has been seen is not probed again.

Bound each fetch with `AbortSignal.timeout(30_000)`, so one stalled request cannot outlast the deadline.

Pure deciders in the lib, used by the entry's `probe(spec)`:

```js
/** @returns {{ visible: false, reason: string } | { tarball: string }} */
export function readPackumentAnswer({ status, body }, spec, tag)
/** @returns {{ visible: true } | { visible: false, reason: string }} */
export function readTarballAnswer(status, spec)
```

`readPackumentAnswer` behaves as follows:
- **404** → `NOT_YET_VISIBLE`. This covers a package's first-ever release (`config-check` in 1.8.0) and an existing package whose version is missing.
- **Any other non-200** → not visible, with reason `registry answered HTTP <status>`, and the wait keeps going. This is unlike `interpretPackument`, which throws: the wait's job is to keep asking.
- **200** with the version absent → `NOT_YET_VISIBLE`.
- **200** with the version present but the dist-tag elsewhere → reason `dist-tag <tag> still points at <other>`.
- **200** with the version present and its `dist.tarball` not an `http(s):` URL string → not visible, with a reason naming the field.
- **200** whose body is not JSON, or has no `versions` map → **throw**. The registry was not answering the question asked. This follows optimystic's `readViewAnswer`.

Do not reuse `interpretPackument` itself. It answers a different question (true/false for the guard, throwing on any unknown status). If parsing the JSON and the `versions` map is the only shared part, extract a small `readPackumentJson(body, name)` in `release-support.mjs` for both to use. Leave both as they are if the extraction does not make either one clearer.

`readTarballAnswer`: 200 means visible. 404 means reason `tarball not downloadable yet`. Any other status gives reason `tarball answered HTTP <status>`.

A network error or a timeout during either fetch is caught in the entry and becomes `{ visible: false, reason: 'could not reach <url>: <message>' }`. It never throws out of the wait.

### Waiting, progress, reports

Port these from optimystic, keeping their tested semantics: `waitForVisibility({ expected, probe, timeoutMs, intervalMs, now, sleep, onProgress })`, `specString`, `NOT_YET_VISIBLE`, `progressLine`, `successLine`, and the entry's `progressPrinter` heartbeat (30 s). The semantics that matter:
- probes within a round run in parallel;
- a package that has been seen is not asked again;
- the last round runs at the deadline;
- the result is the list of stragglers at the deadline.

Interval 5 s. Deadline: 600 s by default, overridden by `SEREUS_PUBLISH_WAIT_SECONDS`. That must be a positive finite number of seconds, and anything else throws at start-up. Put the parsing in the lib as `waitTimeoutMs(env)` so it can be read without a process.

`timeoutReport(stragglers, total, timeoutMs, { tag })` is the sereus-specific part and must say, in this order:
1. how many of how many packages are still not installable after N s, then one line per straggler: `  <name>@<version> — <reason>`;
2. that **npm already accepted the publish**, so this is an unfinished release. **Do not re-run `yarn release`**, because that would bump a second version;
3. that nothing has been pushed and no GitHub release was created;
4. the remaining commands, in order: `yarn await-published`, then `node scripts/release-finish.mjs`. When a straggler's reason shows it was never published at all (it stays 404 well past the deadline), `yarn pub` goes first: it is resumable and skips what is already on npm. Print that as a conditional line, not as a guess from the reason text;
5. when `tag` is defined: keep `SEREUS_DIST_TAG=<tag>` set for both commands. `release-finish` re-resolves the tag from the environment (see its NOTE on dist-tag), and a lost tag would let a stable `next` release claim GitHub's Latest badge.

Do not import `remainingCommands` from `release-finish.mjs`. From the wait's point of view the remaining finish work is always "all of release-finish", and that is the one command `node scripts/release-finish.mjs`. Listing its internal steps here would duplicate its recovery text.

### Docs

`docs/releasing.md` is the release doc. `AGENTS.md` does not describe release steps, so leave it alone. Make these changes:
- Quick Release: the table grows to six steps. Add `yarn await-published` as step 5 (it refuses nothing, and it exits non-zero naming the stragglers after the deadline). Finish becomes step 6. Update the "five separate commands" count and the "Step 5 runs only once npm has every package" sentence.
- Add a Step-by-Step section for the wait, placed between publish and push. It should say what the three checks are. The one-line reason for checking the tarball is that the version record and the tarball become visible at different moments, as seen in 1.8.0. Also cover `SEREUS_PUBLISH_WAIT_SECONDS`, and that it is safe to re-run on its own at any time.
- Recovering: add a subsection titled "`yarn await-published` timed out", listing the same commands the report prints. Change "`yarn pub` failed partway" to `yarn pub`, then `yarn await-published`, then `node scripts/release-finish.mjs`.
- Checklist: the by-hand sequence gains `yarn await-published`.
- Update the comments that list the step chain: the header of `scripts/release-preflight.mjs` ("five steps"), and the header of `scripts/lib/release-support.mjs` (it lists the four step scripts it serves; add the wait, which uses `registryUrl`).

## Edge cases & interactions

- **A package's first-ever version.** The packument is 404 until visible, which reads as "not yet" and not as an error. Checked by the `readPackumentAnswer` test.
- **A resumed release, where `pub` skipped packages already on npm.** Those pass on the first round. Checked by inspection.
- **Prerelease under `SEREUS_DIST_TAG=alpha`.** The dist-tag check compares `dist-tags.alpha`, not `latest`. Checked by the `readPackumentAnswer` test.
- **Tag lost between shells.** Someone runs the wait by hand without the env var the publish used. The wait then times out with the reason `dist-tag latest still points at <old>`, which says exactly what went wrong. Checked by inspection, and covered by the report wording in item 5 above.
- **The packument shows the version but the tarball is 404** (the 1.8.0 case). This must be "keep waiting". Checked by a test of the probe composition, or by the `readTarballAnswer` test plus inspection of the entry's `probe`.
- **Registry 5xx, network failure or fetch timeout.** These keep waiting and appear as the reason. None of them throws out of the loop. Checked by inspection. The 5xx branch is in the `readPackumentAnswer` test.
- **A malformed 200 body.** This throws. It aborts the wait with exit 1 and the setup-failure line. Checked by the `readPackumentAnswer` test.
- **The `pub` chain gains a step that is neither form** (`yarn build && ...`, a `--tag` on a `pub:` script). This throws at start-up and names the step. Checked by the `publishedPackageDirs` test.
- **The wait has no private registry auth.** `registryUrl` honours `SEREUS_NPM_REGISTRY` / `npm_config_registry`, the same as the guard, and the packages are public. Checked by inspection.
- **CDN edges.** `cache-control: no-cache` may let the wait see the origin before every CDN edge does. Leave a `NOTE:` at the fetch: if a customer install is ever seen to resolve an old version after the wait reported success, drop `no-cache` (so the wait sees what an ordinary client sees) or add a short settle delay.
- **`SEREUS_GH_RELEASE=0`.** The wait does not read it. `release-finish` handles the hatch. Checked by inspection.
- **Deadline arithmetic.** The last round runs at the deadline, and a sleep never overshoots it. Checked by the `waitForVisibility` test.

## Tests (`scripts/await-published.test.mjs`, `node:test`, no network, no files)

One test per behaviour:
- `publishedPackageDirs` on a fixture shaped like the real root scripts (`pub` → `yarn pub:a && yarn pub:b`, each `node scripts/publish-package.mjs <dir>`) returns `['a', 'b']` in order. An unreadable step throws and names it.
- `readPackumentAnswer`:
  - version listed, tag matches → `{ tarball }`;
  - 404 → not visible;
  - 200 without the version → not visible;
  - tag pointing at an older version → reason names the tag and both versions;
  - 503 → not visible with the status;
  - non-JSON 200 → throws.
- `readTarballAnswer`: 200 visible, 404 not.
- `waitForVisibility` with a fake clock, sleep and probe:
  - a package seen once is not probed again;
  - stragglers still missing at the deadline are returned;
  - a package that appears on the round at the deadline counts as seen.
- `timeoutReport`:
  - names each straggler;
  - says npm accepted the publish;
  - says not to re-run `yarn release`;
  - lists `yarn await-published` before `node scripts/release-finish.mjs`;
  - with a tag, mentions `SEREUS_DIST_TAG=<tag>`.
- `waitTimeoutMs`: unset → 600 000. `'0'`, `'-5'` and `'abc'` throw.

No test for `successLine`, `progressLine` or the entry's wiring.

## TODO

- Write `scripts/lib/published-visibility.mjs`:
  - chain parsing and `expectedPackages` (ported from Fret);
  - `readPackumentAnswer`, `readTarballAnswer` and `waitTimeoutMs`;
  - `waitForVisibility`, the progress and success lines, and the sereus `timeoutReport` (ported from optimystic).
- Optionally extract `readPackumentJson` in `scripts/lib/release-support.mjs`, but only if it makes both callers clearer.
- Write `scripts/await-published.mjs`:
  - the fetch-based `probe`: packument, then tarball, with no-cache headers, a timeout on each fetch, and the body cancelled;
  - the CDN `NOTE:`;
  - dist-tag resolution through `resolveDistTag`;
  - the progress printer, `--help`, and exit codes.
- Update `package.json`: add `await-published` and `test:await-published`, add the test script to `test`, and insert `yarn await-published` into `release` between `yarn pub` and `node scripts/release-finish.mjs`.
- Write `scripts/await-published.test.mjs` with the tests listed above.
- Update `docs/releasing.md` (table, step section, recovery, checklist), and the step-list header comments in `scripts/release-preflight.mjs` and `scripts/lib/release-support.mjs`.
- Run `yarn test:await-published`, `yarn test:release-finish`, `yarn test:release-support` and `yarn lint`.
- Optional manual check, which needs the network: `yarn await-published` against the current published 1.8.0. It should print the success line within one round, and it must not publish or push anything.
