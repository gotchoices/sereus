description: A fresh clone of this repository installs its dependencies the wrong way, because the one file that tells the package manager how to install is deliberately not committed — it holds a publishing password alongside the settings. Split the settings from the password so the settings can be committed.
architecture: docs/testing.md
files: .yarnrc.yml (untracked), .gitignore, docs/testing.md, package.json
difficulty: easy
----

# The install settings are not committed, because a secret shares their file

## What is true today

`.yarnrc.yml` at the repo root is listed in `.gitignore` (line 5) and is untracked — `git ls-files .yarnrc.yml` returns nothing. It is ignored because it holds a publishing credential. Its contents on this machine are three things:

- `nodeLinker: node-modules` — makes Yarn install into a real `node_modules` tree instead of its default Plug'n'Play mode.
- `npmAuthToken: <secret>` — the credential. It is only used to *publish* (`yarn npm publish`, driven by `scripts/publish-package.mjs`); installing from the public registry needs no token.
- `packageExtensions:` — three peer-dependency patches: `react-native` is declared to want `@babel/core` and `@babel/runtime`, and `@react-native-community/cli-platform-android` to want `@react-native/gradle-plugin`.

Two of those three are ordinary project settings that every clone needs. Only the middle one is a secret, and it is the reason none of them are committed.

## Why it matters

A clone that does not already have the file gets neither setting:

- **Wrong install mode.** Yarn 4 defaults to Plug'n'Play. Packages with native build steps (`node-datachannel`, `keytar`, `@parcel/watcher`, `esbuild`) and anything that resolves by walking `node_modules` — which includes this repo's own stale-build guard, `test-harness/build-freshness.ts` — do not work that way. Every CI checkout, container build, and agent worktree starts from a clone, so every one of them is a clone that is wrong until someone hand-copies a file they cannot get from the repository.
- **Missing peer-dependency patches.** Without `packageExtensions`, the `react-native` entries stop applying. In a full-workspace install performed for this ticket *with* the file present, Yarn reported the `@react-native/gradle-plugin` rule as no longer needed but did not report the two `react-native` ones, which means those two are still doing work.

This surfaced while checking the repository against published dependency packages: a fresh worktree had to have `.yarnrc.yml` copied into it by hand before anything would install.

## What the work is

Split the file. The settings are project configuration and belong in git; the token is per-developer and belongs in the developer's own account-level configuration.

- **Commit `.yarnrc.yml`** with `nodeLinker` and `packageExtensions` only, and remove its line from `.gitignore`.
- **Move the token out.** Yarn reads an account-level `~/.yarnrc.yml` and merges it over the project one, and it also reads the `YARN_NPM_AUTH_TOKEN` environment variable. Either works. `yarn config set npmAuthToken <token> --home` writes the account-level file.
- **Say so in the docs.** `docs/testing.md` does not mention `.yarnrc.yml` anywhere today, and neither does any other document (`grep -rn yarnrc docs/ scripts/ AGENTS.md` finds nothing). Whichever document a new contributor reads first to set up needs one short paragraph: the settings are committed, the publish token is yours to place, here is the command.

**Migration, for anyone who already has the file.** Their working copy has an untracked `.yarnrc.yml` sitting exactly where the committed one lands. Git will refuse to check it out over their file, so the instruction has to be explicit: move your token to the account-level config first, then delete your local `.yarnrc.yml`, then pull. Put that in the same paragraph as the setup note.

**Leave the third `packageExtensions` entry alone.** Yarn's "you may not need this rule anymore" for `@react-native/gradle-plugin` says only that nothing in the current dependency tree requested it. Removing it is a separate judgement about the React Native toolchain and is not this ticket's business; carry it across verbatim.

## Verify

A clone with no account-level Yarn configuration and no local `.yarnrc.yml` must install into `node_modules`, not `.pnp.cjs`. The cheapest check is to add a worktree (outside the repo), run `yarn install` in it, and confirm `node_modules/` appears and no `.pnp.*` file does. Publishing is not checkable here — it needs the real token — so confirm by reading `scripts/publish-package.mjs` that the token is only read at publish time, and say in the ticket handoff that the publish path was reasoned about rather than exercised.

## TODO

- [ ] Write the committed `.yarnrc.yml`: `nodeLinker: node-modules` plus the three `packageExtensions` entries, verbatim, and no `npmAuthToken`.
- [ ] Remove `.yarnrc.yml` from `.gitignore`.
- [ ] Move this machine's token to `~/.yarnrc.yml` (`yarn config set npmAuthToken <token> --home`) before deleting the local project file, so the working copy does not lose it.
- [ ] Confirm `yarn install` still resolves identically afterwards — the lockfile must not change.
- [ ] Add the setup + migration paragraph to `docs/testing.md` (or to whichever setup document the reviewer judges a contributor reads first) and cross-link it.
- [ ] Add a worktree outside the repo, `yarn install` there with no local `.yarnrc.yml`, and confirm `node_modules/` rather than `.pnp.cjs`.
