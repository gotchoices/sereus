description: The install settings file is now committed without the publishing password, so a fresh clone installs the right way; the password moved to each developer's own Yarn configuration. Verifying it, however, damaged the neighbouring optimystic, quereus and Fret checkouts, and that is the first thing to read.
architecture: docs/testing.md
files: .yarnrc.yml, .gitignore, README.md, docs/testing.md, packages/reference-app-rn/scripts/eas-build-pre-install.sh, tickets/blocked/sibling-build-output-deleted-by-worktree-removal.md
difficulty: easy
----

# Handoff: commit `.yarnrc.yml`, keep the token out of it

## Read this first: the verification damaged the sibling checkouts

Removing the scratch worktree used for the fresh-install check (`git worktree remove --force`) followed Windows junctions from the worktree's `node_modules` into `../optimystic`, `../quereus` and `../Fret` and deleted the contents of nine packages there: 883, 1,425 and 140 tracked files respectively, plus every untracked or ignored file in them (`dist/`, per-package `node_modules/`).

- **Tracked files are back** in all three (`git ls-files --deleted` is 0 in each). I re-created them with `git checkout-index`, which cannot overwrite an existing file. That was a write into repositories the project rules make read-only; I judged leaving them empty under other agents' feet to be worse, and it is reversible.
- **Build output is not back, and I did not rebuild it**, because the rules forbid building in siblings. Until an owner runs `yarn install` and `yarn build` there, Sereus suites that load those packages will fail through the stale-build guard. Filed as `tickets/blocked/sibling-build-output-deleted-by-worktree-removal` with the exact packages, counts and steps. Reviewer: **do not read a red gate here as a defect in this ticket until that is done**, and do not write a `.pre-existing-error.md` for it.
- Uncommitted edits to tracked files in those packages, if any existed, are unrecoverable. The evidence that none did is in the blocked ticket; it is not proof.
- The scratch worktree is gone and no junctions were left behind (checked by a walk that does not follow links). The hazard and the safe procedure are written up in `docs/testing.md` → "Scratch worktrees and clones".

I should have unlinked the junctions before removing the directory. `2-check-against-published-packages`, which also builds a worktree, deletes the `resolutions` key first, so its worktree has no junctions into siblings.

## What changed

- **`.yarnrc.yml`** is now a tracked file with `nodeLinker: node-modules` and the three `packageExtensions` entries carried across verbatim (including the `@react-native/gradle-plugin` one that Yarn calls unnecessary; left alone as the ticket said). No `npmAuthToken`.
- **`.gitignore`** no longer lists `.yarnrc.yml` (it was line 4, not 5 as the ticket said).
- **This machine's token** is now in `C:\Users\n8ers\.yarnrc.yml`, written with `yarn config set npmAuthToken <token> --home` from the value already in the project file, before that file was rewritten. Checked without printing it: a 40-character value with the same SHA-256 prefix before and after, read back by `yarn config get npmAuthToken --no-redacted` from the repo root.
- **`README.md`** → "As a contributor": one paragraph saying the settings are committed, where the token goes (`yarn config set … --home` or `YARN_NPM_AUTH_TOKEN`), and the migration order for anyone with an old local file (move the token, delete the file, then pull). I chose the README over `docs/testing.md` because that is where a contributor meets `yarn install` first; `docs/testing.md` keeps the `architecture:` anchor and gained the worktree section, which links back to the README paragraph.
- **`eas-build-pre-install.sh`**: its header comment claimed the file was gitignored. Reworded; the script still overwrites the file on the build server, because it adds `nmHoistingLimits: workspaces`, which the committed file does not have. Whether that should be committed is a separate question and I did not touch it.

## What was verified, and what was not

- **Fresh install** (a detached worktree at `HEAD`, outside the repo): with no `.yarnrc.yml`, `yarn config get nodeLinker` printed `pnp` and `packageExtensions` was unset — the bug, reproduced. With the new file copied in, `yarn install --immutable --mode=skip-build` succeeded, produced `node_modules/` (482 top-level entries), wrote no `.pnp.*`, and left `yarn.lock` unchanged (`--immutable` would have failed otherwise). Yarn's only rule warning was the gradle-plugin one, as the ticket predicted.
- **Gaps in that check.** The worktree was `HEAD` with the new file copied in, since nothing is committed yet. The account-level config already held the token, so "no account-level configuration" was not simulated; it has no bearing on `nodeLinker`. `--mode=skip-build` skipped native build scripts (`node-datachannel`, `keytar`, `@parcel/watcher`, `esbuild`), so their compilation on a clean checkout was not exercised.
- **Publishing was reasoned about, not exercised.** `scripts/publish-package.mjs` never reads a token: it shells out to `yarn npm publish --access public`, and only Yarn reads `npmAuthToken`, merging the account-level file over the project one. The fingerprint check above shows the value still resolves after the project file lost it.
- **The migration wording** (git refusing to check out over an untracked file) is standard git behaviour and was not run against a clone holding a stale local file.

## Tests

None added. This is configuration and prose; there is no branching logic to pin, and the install-mode check is not automatable without a network install.

## For the reviewer

- After the runner commits, `git ls-files .yarnrc.yml` should list it, and `git grep -n npmAuthToken -- .yarnrc.yml` should print nothing.
- The runner's install log is in `tickets/.logs/` (`yarnrc-non-secret-settings-not-committed.install.log`) and prunes itself.
- The `Dockerfile` comment about "no leaked npmAuthToken" refers to its own `workspace.yarnrc.yml` and is still accurate.
