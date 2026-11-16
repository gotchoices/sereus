description: When the release command is run without an interactive terminal, its first step stops and tells the operator to re-run with a "yes" flag, but the release command cannot deliver that flag to the step that wants it, and adding it makes the last step fail after the packages are already published.
architecture: docs/contributing/releasing.md#preflight-confirmation
files: scripts/release-preflight.mjs, scripts/release-preflight.test.mjs, scripts/release-finish.mjs, scripts/publish-package.mjs, package.json, docs/contributing/releasing.md
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The releasing guide already says not to append arguments and names the environment variable that works, releases are run by one or two people who know this, and the fix is a sentence in a message.
----

# The release preflight recommends `--yes`, which `yarn release` cannot pass to it

## Arm 1: the no-terminal message

`yarn release` is six commands joined with `&&` in the root `package.json`, and `scripts/release-preflight.mjs` is the first. Yarn appends extra arguments to the end of a script's command line, so an argument given to `yarn release` reaches only the last command, `scripts/release-finish.mjs`. The header of `scripts/publish-package.mjs` records the same behaviour for `yarn pub`.

In `main()` of the preflight, when standard input is not a terminal and no bypass is set, the script prints:

```
No interactive terminal available, and no --yes flag. Aborting rather than
assuming consent to publish. Re-run with `--yes` if this is intentional.
```

An operator who follows that and runs `yarn release --yes` gets one of two results, both read from the code and not run:

- **Without a terminal:** the preflight never sees the flag and prints the same message again.
- **With a terminal:** the preflight prompts as usual. After the confirmation, the bump, the guard, the publish and the wait all run. Then `release-finish.mjs` receives `--yes`, hands it to `resolveDistTag` (`publish-package.mjs`), which throws `unknown flag "--yes"`. The packages are on npm, and nothing is pushed and no GitHub release exists until the operator runs the recovery steps in `docs/contributing/releasing.md` → "`release-finish.mjs` failed".

The bypass that works inside the chain is `CI=1` in the environment (`resolveBypass`). `docs/contributing/releasing.md` → "Preflight confirmation" says so, and says the script's message suggests the wrong thing.

### Expected behaviour

The message names a bypass that works for the way the script was started: `CI=1` for `yarn release`, and `--yes` only for `node scripts/release-preflight.mjs` run directly. The script's header comment ("Bypass for automation") carries the same two options and needs the same distinction.

The preflight also reads `--tag` from its arguments (`resolvePlannedDistTag`), which `yarn release` cannot deliver either. Its warning text already recommends `SEREUS_DIST_TAG`, so only the flag's reachability is affected.

### To confirm at run time

Run `yarn release < /dev/null` with `SEREUS_GH_RELEASE=0` on a scratch clone and read the message; then `yarn release --yes < /dev/null` and see the same abort. The with-terminal path publishes, so confirm it by reading `release-finish.mjs`, or by running `node scripts/release-finish.mjs --yes` and stopping at the thrown error, which comes before any push.

## Arm 2: the description of `yarn lint` in the printed check list

`CHECK_STEPS` is the list the preflight prints under "Run `yarn check` first if you have not already. It covers:". It holds the five commands the root `check` script chains (`yarn lint`, `yarn build`, `yarn typecheck`, `yarn test`, `yarn smoke:published`), each with a short purpose.

No step is missing. `yarn lint` is now `eslint . && yarn check:docs`, so the documentation check (`scripts/check-docs.mjs`) runs inside a step the list already names. Only the purpose text is behind: it says "eslint across the monorepo" and does not mention the documentation check. This is cosmetic.

One related observation at the same site: the spec named "the advertised check steps match the scripts a release actually depends on" (`scripts/release-preflight.test.mjs`) compares `CHECK_STEPS` with a literal list, not with the `check` script in `package.json`. A sixth step added to `yarn check` would leave the spec green and the printed list short. Reading the `check` script in the spec would make the name true.
