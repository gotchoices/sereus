---
description: A new test now fails whenever a cadre-host command is missing from the command list in its README, and the five push-notification commands that were missing have been documented.
files: packages/cadre-host/src/bin/host.ts, packages/cadre-host/README.md, packages/cadre-host/src/bin/__tests__/cli-reference.test.ts, packages/cadre-host/src/__tests__/cli.smoke.test.ts
difficulty: medium
---

# Review: cadre-host `## CLI reference` drift guard

All four arms landed in one change set. Suite green, typecheck green, `yarn lint`
green.

## What changed

**`packages/cadre-host/src/bin/host.ts`** (3 edits, 24 insertions / 6 deletions)

- `export { program }` at the bottom, and the unconditional
  `void program.parseAsync()` is now gated behind a new `isEntryPoint()` helper
  that compares `pathToFileURL(realpathSync(process.argv[1])).href` against
  `import.meta.url` (so a package-manager bin symlink still matches). Imports
  gained `realpathSync` from `node:fs` and `pathToFileURL` from `node:url`.
- `readPackageVersionForStart()` → `readPackageVersion()`; its one existing call
  site in `start` (`host.ts:247`) updated.
- `.version('0.6.0')` → `.version(readPackageVersion())` — the hardcoded string
  was wrong (`package.json` says `0.11.0`).

**`packages/cadre-host/README.md`** (24 insertions / 1 deletion)

- Five `### cadre-host push …` entries added to `## CLI reference`, between
  `nat ddns external` and `start`. Prose sourced from
  `docs/cadre-host.md § Push credentials (FCM/APNs)` and cross-linked to it.
- Section preamble corrected: the "all commands except … talk to the running
  management API" sentence now lists the `push` group, and a new paragraph in the
  preamble states that push is the exception on both counts (no running service,
  **not** founder-role only). That paragraph sits in the preamble rather than
  beside the first `push` heading on purpose — a paragraph placed there renders
  as part of the preceding `### cadre-host nat ddns external` subsection.

**`packages/cadre-host/src/bin/__tests__/cli-reference.test.ts`** (new, 157 lines)

Four assertions, all with failure messages that name the offending command paths:

1. every visible leaf command has a `### ` heading
2. every documented path resolves to a real command (ghost check)
3. every `### ` heading in the section parses as
   ``### `cadre-host <path...> [flags]` ``
4. `program.version()` equals `package.json`'s `version`

## How to validate

```bash
yarn workspace @serfab/cadre-host build:server     # cli*.smoke.test.ts run dist/
yarn workspace @serfab/cadre-host test
yarn workspace @serfab/cadre-host typecheck
yarn lint
```

The `build:server` step is not optional: `src/__tests__/global-setup.ts`
deliberately does not freshness-check cadre-host's own `dist`, so a stale
`dist/bin/host.js` makes the three smoke tests assert against the previous build.

Last full run: **66 files, 605 passed, 4 skipped**. The 4 skips are pre-existing
(none added here). Vitest exited cleanly with `host.ts` imported — no open-handle
warning, confirming the module scope is inert.

## Negative cases actually exercised

Each was applied to the tree, run, then reverted — not reasoned about:

| Mutation | Result |
| --- | --- |
| delete `### cadre-host push status …` heading | fails, message names `cadre-host push status` |
| add heading `### \`cadre-host push nonesuch …\`` | ghost test fails, names `cadre-host push nonesuch` |
| add heading `### cadre-host push status` (no backticks) | malformed test fails, quotes the line |
| add `program.command('zzz')` | fails, names `cadre-host zzz` |
| add `program.command('zzz', { hidden: true })` | **passes** — hidden is allowed-but-not-required, as specified |

Entry-point gate verified directly against the build:
`node packages/cadre-host/dist/bin/host.js --help` prints the full command tree
(including the `push` group) and `--version` prints `0.11.0`.

## Design decisions a reviewer should push on

- **Presence only, never flags.** A heading's command path must name a real
  command and every leaf needs a heading; the flag list inside the heading is not
  compared against commander's options. This was the settled scope in the plan —
  validating flags would make a wording tweak fail the build — but it does mean a
  heading can advertise a flag that no longer exists. Recorded as a tripwire in
  the test's module comment.
- **Groups are exempt.** `push`, `grant`, `trust`, `nat`, `nat ddns` are group
  commands and need no heading (the README documents leaves only). They *are* in
  the allowed set, so documenting one later would not trip the ghost check.
- **Hidden-command handling uses `cmd.createHelp().visibleCommands(cmd)`** rather
  than poking commander's private `_hidden`. Visibility is inherited — a leaf
  under a hidden group is treated as hidden too. There are no hidden commands
  today, so this path is exercised only by the throwaway mutation above.
- **`isEntryPoint()` failure mode is a silent no-op CLI.** The counter-guard is
  `src/__tests__/cli.smoke.test.ts` (plus `cli-invite.smoke.test.ts` and
  `cli-nat.smoke.test.ts`), which spawn `dist/bin/host.js` as child processes and
  would go silent-and-red. Kept separate from the new test on purpose. Confirm
  the reviewer agrees that pairing is sufficient — a `realpathSync` throw is
  swallowed by the `catch` and returns `false`, which is the fail-silent
  direction.

## Known gaps

- The commander tree is read from `src` by the new test but from `dist` by the
  smoke tests. Nothing forces those to agree beyond running `build:server` first;
  the ticket's stated reason for not adding a freshness check for cadre-host's own
  `dist` still stands, but it is a real hole if someone runs `yarn test` cold.
- The push entries' prose was written against `host.ts:1013-1130` and
  `docs/cadre-host.md:345-361`. It is not machine-checked against either — only
  the headings are. Worth a skim for accuracy, particularly the claim that
  clearing `apns` also drops the bundle id / sandbox toggle from
  `host.config.json` (it does — `host.ts:1104-1112`).
- `host.ts`'s module docstring still opens with "Most subcommands are still stubs
  at this stage", which is stale and predates the push/nat/grant work. Left alone
  as out of scope.
- The doc cross-link `../../docs/cadre-host.md#push-credentials-fcmapns` was
  derived from GitHub's slug rules for the heading
  `## Push credentials (FCM/APNs)`, not clicked.
