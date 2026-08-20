description: A package we no longer publish or maintain (`@serfab/strand-proto`) has been removed from the build, the release process, and the repository, per a maintainer decision that nothing in the repo depends on it.
files: package.json, yarn.lock, eslint.config.mjs, knip.ts, scripts/test-typecheck-allowlist.json, AGENTS.md, README.md, packages/README.md, docs/testing.md, docs/architecture.md, docs/strands.md, docs/releasing.md, docs/reference-app-rn.md, packages/cadre-core/src/strand-formation-protocol.ts
difficulty: easy
----

# Review: removal of `@serfab/strand-proto`

Pure deletion + doc/comment rewrites, no behavior change to any live package. The five remaining
publishable workspaces (`quereus-plugin-sereus`, `cadre-core`, `cadre-cli`, `cadre-provider`,
`cadre-host`) are untouched except for wording in comments/docs that referenced the deleted package.

## What was deleted

- **`packages/strand-proto/`** — whole directory (source, tests, README, package.json, tsconfigs,
  vitest config). `dist/` and `node_modules/` under it were gitignored and went with the directory.
- **`docs/strand-proto.md`** — existed only to document this package.
- **`yarn.lock`** — ran `yarn install` after the workspace deletion; it dropped the
  `@serfab/strand-proto@workspace:...` entry plus the libp2p v4-era transitive deps
  (`@libp2p/crypto@^4.1.9`, `@libp2p/interface@^1.7.0`, `@libp2p/peer-id(-factory)@^4.2.4`,
  `@noble/curves@^1.4.0`, `@noble/hashes@^1.4.0`, `asn1js`, etc.) that only it pulled in — every
  live package is already on newer major versions of these, so nothing else in the tree was
  touched (109 lines removed, 4 added — reviewed the whole diff by hand).

## What was edited (build/release chain)

- **`package.json`**: `pub` script no longer runs `yarn pub:strand-proto` first; the
  `pub:strand-proto` script itself is gone. `pub` is now four `&&`-ed publishes, five with `pub`
  itself: `pub:quereus-plugin-sereus && pub:cadre-core && pub:cadre-cli && pub:cadre-provider && pub:cadre-host`.
- **`eslint.config.mjs`**: removed the `packages/strand-proto/**` global-ignore entry (it existed
  only because the package was carved out of lint).
- **`knip.ts`**: removed the `'packages/strand-proto': { entry: [...] }` workspace config block, and
  reworded the `reference-app-ns` comment that cross-referenced "strand-proto's test/manual" to
  stand on its own.
- **`scripts/test-typecheck-allowlist.json`**: now `{}` (was a single `@serfab/strand-proto` entry
  covering its three bit-rotted test files). Confirmed `check-test-file-typecheck-coverage.mjs`
  tolerates an empty allowlist — `yarn test:test-file-typecheck-coverage` passes all 30 cases
  including "no allowlist file at all is treated as an empty allowlist", and the live gate reports
  "0 allowlisted".

## What was edited (docs)

- **`AGENTS.md`** repo-orientation line: dropped the trailing "`strand-proto` deprecated." clause.
- **`README.md`**: removed the `@serfab/strand-proto` row from the package table.
- **`packages/README.md`**: removed the stale "Current: strand-proto/ ..." bullet (was the file's
  only content line beyond the folder description).
- **`docs/architecture.md`**: removed the "Bootstrap Protocol" reference-doc link and the
  `packages/strand-proto` bullet under "Existing Implementations"; rewrote the Strand Formation
  section's "replaces the deprecated `strand-proto`" clause to describe the native formation
  transport on its own terms; rewrote the `formStrand()` API bullet that said "full `strand-proto`
  SessionManager integration" (this line was already describing *current* `StrandFormationManager`
  code, not the deleted package — read `strand-formation-protocol.ts` and `cadre-node.ts` to
  confirm before rewording).
- **`docs/strands.md`**: reworded the "History" section so it no longer points at
  `sereus/packages/strand-proto/` and `sereus/docs/strand-proto.md`, both now-nonexistent paths.
- **`docs/reference-app-rn.md`**: fixed the stale "dials Party A's cadre via `strand-proto`" line
  (formation is native to `cadre-core`; this was already inaccurate before this ticket, per
  `docs/architecture.md`'s existing wording at the time).
- **`docs/testing.md`**: dropped `strand-proto` from the type-check-coverage package list, from the
  "ignored" list in the lint-coverage section, and removed the whole "Shippable source only" bullet
  that existed to explain the now-deleted allowlist entry. Recounted and fixed **two** workspace
  totals from 10 → 9, plus a **third stale count I found while verifying** (not in the original
  ticket body): "The seven `tsconfig.typecheck.json` files are near-identical" → six, confirmed by
  `Glob packages/*/tsconfig.typecheck.json` (cadre-cli, cadre-core, cadre-host, cadre-provider,
  integration-tests, quereus-plugin-sereus).
- **`docs/releasing.md`**: full rework per the ticket's itemized list — six→five publishable
  packages throughout, publish-order chain, individual-publish code block, prerelease chain-length
  mention, the bold recommendation line, and the "which packages ship" subsection (now explains the
  package is gone from the repo entirely rather than merely excluded from one release). Runbook
  step 6 simplified from five explicit per-package `--tag alpha` commands back to
  `SEREUS_DIST_TAG=alpha yarn pub`, since `yarn pub` itself only publishes five packages now.

## One fix beyond the ticket's file list

`packages/cadre-core/src/strand-formation-protocol.ts` (not in the ticket's `files:` header) had a
doc comment pointing at `docs/strand-proto.md "Security & Privacy"` — a genuinely broken reference
once that file is deleted. Removed the dangling pointer, left the rest of the comment (including
the historical "`@serfab/strand-proto`" package-name mentions, which aren't broken links, just
history) alone. Flagging here since it's outside the ticket's stated scope, in case that's an
unwanted addition to the diff.

## Left alone (checked, not touched)

- `packages/reference-app-rn/README.md:225` matched a `strand-proto` grep but is actually
  `formstrand-protocol-thread-consent-and-provision` — a scenario/test name substring, not a
  reference to the package. No change needed.
- `tickets/blocked/cut-the-interim-release.md` still references this ticket by its old path and the
  "five, not six" framing — it's a human's inbox item in `blocked/`, explicitly out of scope per the
  ticket. `docs/releasing.md` is already corrected for whoever picks that up next.
- `../optimystic` / `../quereus` linked workspaces — confirmed no `strand-proto` references.

## Validation performed

All from repo root, all green:

| Command | Result |
| --- | --- |
| `yarn lint` | exit 0 |
| `yarn build` | all workspaces build clean |
| `yarn typecheck` | all 9 workspaces + both coverage gates pass |
| `yarn test:test-file-typecheck-coverage` | 30/30 tests pass |
| `yarn test:vitest-typecheck-coverage` | 16/16 tests pass |
| `yarn test:dep-ranges` | 9/9 tests pass |
| `yarn test:publish-package` | 20/20 tests pass |
| `yarn test:release-preflight` | 8/8 tests pass |
| `yarn install` (after workspace deletion) | clean, only pre-existing peer-dep warnings unrelated to this change (reference-app-ns / react-native, present before this ticket) |

## Known gaps

- **Full `yarn test` and `yarn smoke:published` were not run.** Both are documented release-time
  gates needing the network and real time (`docs/testing.md`, `docs/releasing.md`); `integration-tests`
  in particular runs real multi-process libp2p scenarios. Given this ticket is a mechanical
  deletion + doc sweep touching no live runtime logic (aside from the one comment fix above), the
  gates actually run (lint/build/typecheck/coverage/dep-ranges/publish-package/release-preflight)
  cover the change's real blast radius. A reviewer with more time budget may still want
  `yarn smoke:published` since it's the one gate that would catch the publish-chain script edit
  (`pub` script, now four `&&`-ed calls) breaking in a way unit tests on `publish-package.mjs`
  wouldn't — that script only unit-tests `resolveDistTag`/`publishCommand`/`readManifest`, not the
  root `package.json` script wiring itself.
- **No pre-existing test failures encountered** — nothing written to `tickets/.pre-existing-error.md`.
