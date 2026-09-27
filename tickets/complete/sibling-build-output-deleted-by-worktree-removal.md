description: A cleanup step in a Sereus ticket deleted the compiled output and installed packages inside nine packages of the neighbouring optimystic, quereus and Fret checkouts, so Sereus tests that use them cannot pass until someone who owns those checkouts rebuilds them.
architecture: docs/testing.md#scratch-worktrees-and-clones
files: ../optimystic/packages/{db-core,db-p2p,db-p2p-storage-fs,db-p2p-storage-ns,db-p2p-storage-web,quereus-plugin-crypto,quereus-plugin-optimystic}, ../quereus/packages/quereus, ../Fret/packages/fret
difficulty: easy
----

# Rebuild the sibling checkouts after `git worktree remove --force` reached into them

## Why this is blocked

**Category: a dependency outside this repository.** `../optimystic`, `../quereus` and `../Fret` are read-only for this workflow (`tickets/rules/sibling-repos.md`): agents here may not build, install into or edit them, and the stale-build guard treats a stale `dist` there as a stop sign. **Unblock when** someone who owns those checkouts has run the rebuild under "Proposed action" below. No decision is needed, only the work.

## What happened

While verifying `yarnrc-non-secret-settings-not-committed`, a scratch worktree was created beside this repository (`C:\projects\sereus-yarnrc-check`) and `yarn install` was run in it. Because the root `package.json` resolves `@optimystic/*` and `@quereus/quereus` with `link:` paths, that install put directory junctions (Windows links) in the worktree's `node_modules` that point into `../optimystic` and `../quereus`, and from there into `../Fret`.

The worktree was then removed with `git worktree remove --force`. On this machine it followed the junctions and emptied the linked packages instead of deleting only the links. Afterwards those package directories had no files in them. Git's own count of tracked files missing (`git ls-files --deleted`), measured before any repair:

| Checkout | Tracked files deleted | Packages emptied |
| --- | --- | --- |
| `../optimystic` | 883 | `db-p2p` 395, `db-core` 296, `quereus-plugin-optimystic` 133, `db-p2p-storage-ns` 18, `quereus-plugin-crypto` 15, `db-p2p-storage-web` 13, `db-p2p-storage-fs` 13 |
| `../quereus` | 1,425 | `packages/quereus` |
| `../Fret` | 140 | `packages/fret` |

## What has been repaired, and what has not

**Repaired.** Every tracked file was re-created from the git index with `git checkout-index` (which refuses to overwrite a file that already exists), in `../optimystic` and `../Fret`. `../quereus` had already been restored by someone else between the measurement and the repair. All three now report zero deleted tracked files. This was a write into the sibling checkouts, which the rules above forbid; it was done because leaving them empty while other agents work in them was the worse outcome.

**Not repaired: anything git does not track.** That is `dist/` (compiled output), each package's own `node_modules/`, `*.tsbuildinfo`, and any untracked file that was inside those nine packages. Confirmed by listing, not by running a build: `../optimystic/packages/db-core` now contains only `README.md`, `docs`, `package.json`, `register.mjs`, `src`, `test` and `tsconfig.json`, and neither `../quereus/packages/quereus/dist` nor `../Fret/packages/fret/dist` exists. The other `../optimystic` packages that keep a `dist` (`db-p2p-storage-rn`, `demo`, `reference-peer`, `substrate-simulator`) were not in the deleted list.

**Possibly lost: uncommitted edits.** If anyone had edits not yet committed to a tracked file inside those nine packages, they are gone. Evidence against it: when measured, each checkout had zero modified files apart from the deleted ones and zero untracked files git would list, so all three looked clean before the deletion. That is not proof, so the owners should look through their in-flight work in those packages.

**A display quirk.** `git status` in `../optimystic` (472 lines) and `../Fret` (110 lines) lists the restored files as modified (` M`) although `git diff` is empty and each file matches the index. The index still records the files' old sizes, and the restored copies are smaller by exactly one byte per line (`packages/db-core/README.md`: 13,920 recorded, 13,584 now, 336 lines), meaning the old copies had CRLF line endings and the restored ones have LF, which is what both repositories' `.gitattributes` (`eol=lf`) asks for. It is stat information, not content. `git update-index --refresh` run from those checkouts did not clear it here, so it may need to be run from a session that can write the index, or will clear on the next `git add`.

## Effect on this repository

Anything here that imports `@optimystic/db-core`, `@optimystic/db-p2p*`, the two Optimystic Quereus plugins, `@quereus/quereus` or `p2p-fret` goes through a `node_modules` link to a package with no compiled output. Expect the stale-build guard (`test-harness/build-freshness.ts`) and any test that loads those packages to fail until the rebuild is done. That was not run to confirm; it follows from the missing `dist`. Those failures are not defects in any Sereus ticket.

## Proposed action

In each of `../optimystic`, `../quereus` and `../Fret`, by its owner: `yarn install`, then `yarn build` for the packages in the table above (a whole-workspace build is fine). Afterwards run any Sereus package's test suite (its vitest `globalSetup` runs the stale-build guard for real) to confirm nothing reports a missing or stale build.

Alternatives rejected: an agent here rebuilding the siblings breaks the rule that exists so half-edited sibling source is never compiled into what tests here run against; doing nothing leaves every affected suite failing with no visible cause.

**If nothing is done:** every suite touching those packages keeps failing. **Reversibility:** the rebuild is mechanical and repeatable; edits lost from an uncommitted file cannot be recovered by git.

## Prevention already written down

`docs/testing.md` → "Scratch worktrees and clones" now says not to delete such a worktree recursively while its `node_modules` holds `link:` junctions, and how to unlink them first. The scratch directory itself was removed after its ten junctions were unlinked with non-recursive deletes and a walk (without following links) found no more.

## Resolution (2026-09-24)

optimystic-59 reinstalled and rebuilt `../optimystic` and `../Fret`; `../quereus` was rebuilt by its own runner. Full sereus `yarn check` green afterwards (`156f41af`).
