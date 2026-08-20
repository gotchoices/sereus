----
description: A test now fails whenever a cadre-host command is missing from the command list in its README, and the five push-notification commands that were missing have been documented.
files: packages/cadre-host/src/bin/host.ts, packages/cadre-host/README.md, packages/cadre-host/src/bin/__tests__/cli-reference.test.ts, packages/cadre-host/src/__tests__/cli.smoke.test.ts, packages/cadre-host/src/__tests__/global-setup.ts
----

# Complete: cadre-host `## CLI reference` drift guard

The README's command list is now machine-checked against the real command tree,
in both directions, and the previously-undocumented `cadre-host push` group is
written up. Shipped as planned across four arms.

## What shipped

**`packages/cadre-host/src/bin/host.ts`**

- `export { program }`, with the previously-unconditional `void
  program.parseAsync()` gated behind `isEntryPoint()` — a comparison of
  `pathToFileURL(realpathSync(process.argv[1])).href` against `import.meta.url`,
  so a package-manager bin shim still matches. This is what makes the command
  tree importable from a test without running the CLI.
- `readPackageVersionForStart()` renamed `readPackageVersion()` and fed to
  `.version(...)`, replacing a hardcoded `'0.6.0'` that had drifted from
  `package.json`'s `0.11.0`.

**`packages/cadre-host/README.md`**

Five `### cadre-host push …` entries under `## CLI reference`, plus a preamble
paragraph recording that the `push` group is the exception on two counts: it
needs no running management service, and it is *not* founder-role only.

**`packages/cadre-host/src/bin/__tests__/cli-reference.test.ts`** (new)

Walks the commander tree, slices the README between `## CLI reference` and the
next `## ` heading, and asserts: every visible leaf command has a heading; every
documented path names a real command; every `### ` heading in the section parses
as ``### `cadre-host <path...> [flags]` ``; and `program.version()` equals
`package.json`'s `version`. Failure messages name the offending command paths.

## Review findings

### Verified rather than taken on trust

The implement handoff listed five mutation tests it had run. Rather than accept
that table, the load-bearing one was re-run independently: renaming
`### \`cadre-host nat test [--json]\`` to `nat tset` fired *both* directions —
the missing-heading assertion named `cadre-host nat test`, the ghost assertion
named `cadre-host nat tset`. The README was restored from a byte copy and
`git diff` confirmed clean before any review edits. The guard has teeth.

Three further checks the handoff did not make:

- **Commander internals, probed against the built bundle.** The implicit `help`
  command is *not* present in `.commands` on commander 14 — it is synthesized
  inside `visibleCommands()` — so the `IMPLICIT_HELP` filter is inert today.
  Harmless and correctly defensive; left in place. More importantly,
  `visibleCommands(cmd)` returns the *same object references* as `cmd.commands`
  (10/10 identity match at the top level), which is what the hidden-command
  handling depends on. Had commander returned copies, `visibleChildren.has(child)`
  would be false for every command, `requiresHeading` would be false everywhere,
  and the missing-heading test would have passed vacuously forever.
- **Vacuous-pass analysis of the reverse case.** If `collectCommands` ever
  returned an empty list, the missing-heading test would pass on an empty set —
  but the ghost test would then reclassify all 21 documented paths as ghosts and
  go red. The two assertions cover each other; no extra sanity assertion needed.
- **The entry-point gate through paths the handoff didn't exercise.** It was
  validated only as `node dist/bin/host.js --help`. Also checked here: a
  lowercase drive letter (`node c:/projects/.../host.js`), a relative path
  (`node ./dist/bin/host.js`), and — the case the docstring actually claims to
  handle — the real yarn bin shim, `.\node_modules\.bin\cadre-host.cmd --version`
  → `0.11.0`. All print. That closes the handoff's stated open question about
  whether the shim matches on Windows.

### Prose checked against code, not skimmed

All five `push` README entries were read against `host.ts:1013-1130` and
`docs/cadre-host.md:334-377`. Accurate, including the specific claim the handoff
flagged for verification — clearing `apns` does drop the bundle id and sandbox
toggle from `host.config.json` (`host.ts:1105-1112`).

The section preamble's exception list was checked command by command rather than
assumed: `status`, `invite`, `trust *`, `grant *`, `nat *` all build a loopback
URL and issue HTTP; `install`, `uninstall`, `start`, `ui`, `push *` do not. The
list is correct as amended.

The doc cross-link was resolved rather than trusted: `docs/cadre-host.md` carries
`## Push credentials (FCM/APNs)` at line 334, whose GitHub slug is
`push-credentials-fcmapns`, and `../../docs/` from `packages/cadre-host/` reaches
the repo root. Both halves of the link are right.

Coverage tallies: 21 visible leaf commands, 21 `### ` headings in the section.

### Minor findings — fixed in this pass

- **`host.ts`'s module docstring was stale and actively misleading.** It opened
  with "Most subcommands are still stubs at this stage" (nothing is a stub; nat,
  installer and local-UI all landed) and claimed only `invite` and `trust` talk
  to the management API (five command groups do, and `push` deliberately does
  not). The handoff called this out and left it as out of scope; it is a one-line
  doc lie in a file this change already edits, so it was rewritten to match
  reality and to point at the new guard.
- **`CommandNode.leaf`'s doc comment did not describe its value.** The comment
  said "True when the command has no subcommands of its own", but the field also
  encoded visibility (`subcommands.length === 0 && childVisible`). Renamed
  `requiresHeading` with a comment that matches — the name now states the rule
  the test enforces.
- **`cli.smoke.test.ts`'s version assertion had no teeth.** It checked only
  `stdout.trim().length > 0`, which passes on `0.0.0-unknown` — the exact value
  `readPackageVersion()` falls back to when the `package.json` read fails. Since
  arm 3 made the version dynamic, that fallback is now a reachable silent
  degradation on the shipped binary. Tightened to compare against
  `package.json`'s `version`. This is stale-`dist`-safe: the built CLI reads
  `package.json` at *runtime*, so the assertion holds regardless of build
  freshness.
- **The README's push paragraph overstated the file-store's protection.** It said
  private keys land in "the `0600` fallback" with no qualifier, while
  `FileSecretsStore`'s own docstring and `docs/cadre-host.md:332` both record that
  `chmod` is a no-op on Windows — a platform this README's own service table
  lists as supported. Since this is a security claim in user-facing docs, the
  POSIX-only caveat was added inline.

### Tripwires — recorded at the site, no tickets filed

- **Flag lists in headings are never validated.** A heading can advertise a flag
  the CLI no longer accepts. This was the settled scope (validating flags turns a
  wording tweak into a red build), and the handoff noted it — but the note gave
  no revisit condition. Now a `NOTE:` in the test's module comment saying to
  compare against `cmd.options` *if* that drift is ever observed.
- **No non-command `### ` heading may live in the CLI reference section.** The
  malformed-heading assertion is a hard failure by design, so a future author
  adding e.g. `### Notes` there gets a red build with no hint why. `NOTE:` in the
  test's module comment directing such prose to the preamble or another `## `
  section.
- **`isEntryPoint()` fails silently.** A false negative is a CLI that exits 0
  having printed nothing. The plan weighed and rejected the `process.env.VITEST`
  alternative; that decision lived only in the ticket, which no future reader of
  `host.ts` will see. Recorded as an accepted-tradeoff `NOTE:` at the function,
  naming the counter-guard (`cli.smoke.test.ts`'s non-empty-stdout assertion) and
  the revisit condition (that smoke test being weakened or removed).
- **cadre-host's own `dist` is deliberately not freshness-checked.** The new test
  reads the commander tree from `src` while the smoke tests read `dist`; nothing
  forces agreement. The handoff listed this as a "known gap" — on inspection it
  is a decision already documented in prose at
  `src/__tests__/global-setup.ts`, so it is not a new finding. The prose was
  retagged `NOTE: accepted tradeoff` (making it greppable with the rest of the
  set) and extended with the consequence for this specific pair of tests and a
  revisit condition: a stale `dist` producing a false green rather than merely a
  weaker check. Worth stating plainly: staleness cannot make the *new* guard pass
  wrongly — it reads `src` — it only weakens the counter-guard for the
  entry-point gate.

### Major findings — none

No ticket was filed, and the two candidates were weighed rather than waved past:

- **`src/bin/host.ts` is large** — 1317 lines by `wc -l`. Measured against the
  rest of the repo with
  `find packages -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*__tests__*' -exec wc -l {} + | sort -rn`:
  it ranks 11th, well inside the band of `cadre-core/src/control-database.ts`
  (2406) and `cadre-core/src/types.ts` (1349), and far from
  `cadre-core/src/cadre-node.ts` (5485), which already has its own size ticket.
  This change added 24 lines to it. Filing a size ticket here would single out a
  file that is not the outlier, so it was declined rather than queued.
- **Sibling package READMEs have the same drift exposure** —
  `packages/cadre-cli` and `packages/cadre-provider` document commands as
  topic-organized prose with nothing checkable. Already filed as
  `backlog/debt-cli-reference-drift-guard-sibling-packages`, so this is evidence
  for an existing ticket, not a new one.

A site-claim grep over `tickets/{backlog,fix,plan,implement,review}` for
`bin/host.ts` and `cadre-host/README.md` turned up only that sibling ticket and
two unrelated `backlog/later/` entries. No accepted-tradeoff `NOTE:` existed at
any finding site before this pass.

### Gates

Run from a clean tree after the review edits, with `build:server` first (the
smoke tests execute `dist/`):

| Gate | Result |
| --- | --- |
| `yarn workspace @serfab/cadre-host build:server` | exit 0 |
| `yarn workspace @serfab/cadre-host typecheck` | exit 0 |
| `yarn workspace @serfab/cadre-host test` | 66 files, 605 passed, 4 skipped |
| `yarn lint` | exit 0 |

The 4 skips are pre-existing and unchanged from the pre-review run; none were
added by either stage, and nothing was skipped, disabled, or loosened to get a
green run. No `.pre-existing-error.md` was written — no test failed.
