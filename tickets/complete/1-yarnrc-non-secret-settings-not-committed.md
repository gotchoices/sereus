description: The Yarn install settings file is now committed without the publishing password, so a fresh clone installs the right way; the password lives in each developer's own Yarn configuration instead. Verifying it damaged the neighbouring optimystic, quereus and Fret checkouts, which is tracked separately and still open.
architecture: docs/testing.md
files: .yarnrc.yml, .gitignore, README.md, docs/testing.md, packages/reference-app-rn/scripts/eas-build-pre-install.sh, tickets/blocked/sibling-build-output-deleted-by-worktree-removal.md
----

# Complete: `.yarnrc.yml` is committed, the publish token is not

## What landed

- **`.yarnrc.yml` is tracked** and carries `nodeLinker: node-modules` plus the three `packageExtensions` peer-dependency patches, verbatim from the previously untracked file. No `npmAuthToken`. A comment at the top says why the linker is pinned (Yarn 4's Plug'n'Play default breaks native build steps and the stale-build guard's `node_modules` walk) and that the token is deliberately elsewhere.
- **`.gitignore`** no longer lists it.
- **The token** moved to the account-level config (`yarn config set npmAuthToken <token> --home`) before the project file was rewritten. Only Yarn reads it, at publish time; `scripts/publish-package.mjs` shells out to `yarn npm publish` and never touches the value itself.
- **`README.md` → "As a contributor"** explains the split, where the token goes, and the migration order for anyone holding an old local file (move the token, delete the file, then pull).
- **`docs/testing.md`** gained "Scratch worktrees and clones", recording the Windows hazard the verification hit and the safe procedure.
- **`packages/reference-app-rn/scripts/eas-build-pre-install.sh`** no longer regenerates the whole file on the build server; it appends the one setting the React Native build needs on top of the committed ones.

## Verification

`yarn lint` passes. `yarn config get nodeLinker` prints `node-modules` and `yarn config get packageExtensions` prints all three entries, so the committed file is what Yarn actually reads. `git grep npmAuthToken` finds no token anywhere in the tree, and `git log --all -- .yarnrc.yml` shows one commit, so no token was ever committed. The fresh-install check (a worktree with no `.yarnrc.yml` resolving `nodeLinker` to `pnp`, then installing correctly with the file present) was run in the implement pass.

**Tests could not be run at all.** Every suite's vitest `globalSetup` calls the stale-build guard, which aborts before any test because `../optimystic` and `../Fret` have no compiled output — the damage recorded in `tickets/blocked/sibling-build-output-deleted-by-worktree-removal`. Confirmed on `@serfab/reference-app-web`: five `@optimystic/*` packages reported "not built (missing dist/…)". That is the blocked ticket's, not a defect here, and no `.pre-existing-error.md` was written for it. Nothing in this ticket's diff is executable code, so there is nothing a suite would have exercised; the gate remains genuinely unrun until the siblings are rebuilt.

## Review findings

**Fixed in this pass (minor).**

- *The change introduced a duplicate copy of the settings.* `packages/reference-app-rn/scripts/eas-build-pre-install.sh` overwrote the root `.yarnrc.yml` with a heredoc restating `nodeLinker` and all three `packageExtensions` entries, only to add `nmHoistingLimits: workspaces`. That was harmless while the real file was gitignored and absent on the build server; now that it is committed and present, the heredoc is a second copy that silently goes stale the first time anyone edits the committed one — and the copy the RN build would use. The script now fails loudly if the committed file is missing and otherwise appends just the hoisting line, guarded so a re-run cannot write a duplicate YAML key. Exercised against the real committed file: run once it appends, run twice it appends once, and the result is equivalent to what the heredoc produced.
- *The README sentence said the wrong thing.* "it selects the `node-modules` linker (Yarn 4's default, Plug'n'Play, breaks native modules…)" parses on first read as *node-modules* being Yarn 4's default, which is the opposite of the point. Reworded.
- *`docs/testing.md` pointed at a README section without linking it,* although the handoff described it as a cross-link. Now an actual link.
- *`.yarnrc.yml` carried no reason for its own contents.* A developer editing it would have had to find the README to learn why Plug'n'Play is refused and why there is no token in it. Three comment lines added at the site.

**Checked and found correct — no change.**

- No token leaked: not in the working file, not in any tracked file, and not in the file's single commit.
- The account-level config holds the key (verified by presence, without printing the value), so publishing still resolves a token.
- The stale-build guard really does walk `node_modules` (`test-harness/build-freshness.spec.ts`), so the README's justification for pinning the linker is accurate rather than folklore.
- No other file assumes the old arrangement: `git grep yarnrc` finds only the README, `docs/testing.md`, the EAS hook and the Dockerfile, and there is no CI configuration in this repo. The Dockerfile's comment ("the Docker-specific `.yarnrc.yml` carries only `nodeLinker: node-modules` — no leaked `npmAuthToken`, no RN `packageExtensions`") is still factually true; its separate file is now justified by the second clause rather than the first, which is not worth an edit.
- `.gitignore`'s remaining `.yarn` entry is a different path and does not shadow the newly tracked file.

**Tests: none added, and none of the implementer's to cut** (they added none). The diff is configuration and prose with no branching logic. A test asserting the file is tracked and token-free would restate a constant, and the behaviour that actually matters — which linker a clean clone installs with — needs a real network install. The one piece of new logic, the hook's append guard, was exercised directly rather than pinned by a test that would only re-run a shell fragment no suite loads.

**Tripwires recorded (not tickets).** The RN build needs `nmHoistingLimits: workspaces` and the repo does not commit it, because it would change every workspace's install layout for everyone. That predates this ticket and is now stated in the EAS hook's header comment, at the one site that depends on it.

**Nothing filed.** The one open question — whether the hoisting limit belongs in the committed file — is conditional and parked as above, not a defect. The sibling-checkout damage already has its own ticket in `blocked/`, correctly categorised as work outside this repository, so re-filing it here would duplicate it.

## Still open, for whoever picks this up

`tickets/blocked/sibling-build-output-deleted-by-worktree-removal` must be worked before any Sereus suite can run: `../optimystic` and `../Fret` need `yarn install` and `yarn build` by their owners. Until then every test run in this repo stops in the stale-build guard, regardless of which ticket is being worked.
