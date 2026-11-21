description: On Windows, when a linked sibling repository's folder is spelled with different capital letters than this repo's links use, tests load a second copy of the storage library and fail in ways that look like real bugs. The test setup should refuse such a run and say how to fix it, as it already does for a lowercase drive letter.
architecture: docs/contributing/testing.md#windows-start-from-an-uppercase-drive-letter
files: test-harness/working-directory.ts (assertUppercaseDriveLetter, the model), packages/*/test/global-setup.ts (each calls it), package.json (resolutions: link:../optimystic/..., link:../quereus/...), docs/contributing/testing.md, packages/cadre-core/src/control-read-retry.ts (isCohortUnreachableRead: an instanceof check that a second copy breaks)
repro: verified
----

# A linked sibling loaded under two path spellings

## What happens

Root `resolutions` link `@optimystic/*` to `../optimystic/packages/*`, so `node_modules/@optimystic/db-core` is a junction to `C:\Projects\optimystic\packages\db-core`. On the maintainer's machine the folder is spelled `C:\Projects\Optimystic`. Optimystic's own install (2026-11-19) gave each of its packages a nested link, such as `quereus-plugin-optimystic/node_modules/@optimystic/db-core -> C:\Projects\Optimystic\packages\db-core`.

Node keys its module cache by the resolved path string, and resolving a junction keeps the spelling stored in it. So `@optimystic/db-core` imported from Sereus and the same package imported from inside `@optimystic/quereus-plugin-optimystic` are two module instances of the same files. Every `instanceof` across that boundary is false: an error the plugin throws is not an instance of the class Sereus imported.

## Reproduction (2026-11-20, Optimystic 1.29.0 linked)

`yarn test` in `packages/cadre-core`, started from `C:\Projects\sereus`. Two failures came from this:

- `strand-instance-manager.spec.ts` → "keeps a launch whose seed is unreachable syncing on its running node, retrying only the database": `BlockUnavailableError … (cohort-unreachable)` escaped `startStrand`, because `isCohortUnreachableRead` did not recognise it. The stack shows frames from `../Optimystic/packages/db-core` and `../optimystic/packages/quereus-plugin-optimystic` together.
- `control-database-solo-warm-start.spec.ts` → "start() then addStrand() with THREE vanished prior-cohort peers on disk": `ensureOwnerKey() (genesis) timed out after 15000ms`.

Both passed (27 of 27) after only Sereus's own `node_modules/@optimystic/*` junctions were repointed at `C:\Projects\Optimystic\packages\*`. That repointing is still in place on the maintainer's machine; the next `yarn install` recreates the lowercase junctions and brings the failures back.

Metro met the same two spellings and is already fixed: `withCadreMetro` resolves each `linkedRoots` entry to the directory on disk, because the app named `../../../optimystic` while the repointed junctions led to `C:\Projects\Optimystic` and the Android export then could not resolve `@optimystic/db-core` at all. Whatever this ticket settles on, that resolution step stays correct: it is about the app's own spelling of a root, not about which spelling the junctions hold.

## Expected behaviour

A test run in which any linked sibling package resolves to two different path strings refuses to start, from each package's global setup, beside `assertUppercaseDriveLetter`. The message names the two spellings and the fix: make the sibling folder's spelling match the `resolutions` paths (rename the folder; if the sibling's own nested links then still hold the old spelling, that sibling's owner reinstalls it), or repoint Sereus's junctions.

The check has to compare resolved paths, not folder names: resolve each linked package from Sereus and from each linked sibling package that depends on it, and compare the real paths as strings. It must not write in the sibling (`tickets/rules/sibling-repos.md`).

Document it in `docs/contributing/testing.md` next to "Windows: start from an uppercase drive letter", which is the same class of problem: one file loaded under two path spellings.

## Edge cases

- Non-Windows, or no `link:` resolutions (`yarn check:published` drops them): the check passes trivially.
- A sibling with no nested links (all hoisted): nothing to compare; passes.
- `@quereus/quereus` is linked the same way (`../quereus`; the folder on disk is `C:\Projects\Quereus`). Cover it with the same check, although no failure from it has been seen.
