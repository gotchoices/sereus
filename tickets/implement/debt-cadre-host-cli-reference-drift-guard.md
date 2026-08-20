----
description: Add a test that fails whenever a command the cadre-host tool accepts is missing from the command list in its README, and fill in the five commands that are already missing.
files: packages/cadre-host/src/bin/host.ts, packages/cadre-host/README.md, packages/cadre-host/src/bin/__tests__/cli-reference.test.ts, packages/cadre-host/src/__tests__/cli.smoke.test.ts, docs/cadre-host.md
difficulty: medium
----

# Keep cadre-host's `## CLI reference` honest against the real CLI

`packages/cadre-host/README.md` carries a `## CLI reference` section with one
`### ` heading per command. Nothing checks it against the commander program in
`packages/cadre-host/src/bin/host.ts`, and it has already drifted: the whole
`cadre-host push` group (`fcm`, `apns`, `options`, `clear`, `status`, defined
from `host.ts:1009`) has no entry. The same file also hardcodes
`.version('0.6.0')` (`host.ts:84`) while `package.json` says `0.11.0` — a second
hand-maintained copy of a fact the code already knows, already wrong.

Four arms, one commit — the guard and the missing docs must land together or the
suite is red on arrival.

## Arm 1 — make the command tree importable

`host.ts` today builds a module-local `const program` and ends with an
unconditional `void program.parseAsync()`, so importing it from a test runs the
CLI. Export the program and gate the parse on being the process entry point:

```ts
import { realpathSync } from 'node:fs';                   // add to the existing node:fs import
import { fileURLToPath, pathToFileURL } from 'node:url';  // pathToFileURL is new

/**
 * True when this module is the process entry point rather than an import.
 * `import.meta.url` is already realpath-resolved by Node's ESM loader, so
 * `process.argv[1]` gets the same treatment before comparing — a package-manager
 * bin symlink otherwise fails to match.
 */
function isEntryPoint(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return pathToFileURL(realpathSync(entry)).href === import.meta.url;
	} catch {
		return false;
	}
}

export { program };

if (isEntryPoint()) void program.parseAsync();
```

**Tradeoff, decided:** the failure mode of a wrong `isEntryPoint()` is a CLI that
silently does nothing. The counter-guard already exists —
`src/__tests__/cli.smoke.test.ts` spawns `dist/bin/host.js --help` as a child
process and asserts on its output, so a broken entry-point check fails loudly
there. Keep that test; do not fold it into the new one. Its blind spot is
same-package staleness (it runs `dist`, which `src/__tests__/global-setup.ts`
deliberately does not freshness-check), so run
`yarn workspace @serfab/cadre-host build:server` before the suite when validating
this ticket. The alternative — gating on `process.env.VITEST` — was rejected: a
test-runner env var has no business in shipped CLI source.

Verify the import is inert: `host.ts`'s module scope only builds the commander
tree, and nothing calls `process.exit`, binds a port, or starts a timer until an
action fires. If the new test leaves vitest with open handles, that assumption
broke — find the offender rather than working around it.

## Arm 2 — the drift guard

New file `packages/cadre-host/src/bin/__tests__/cli-reference.test.ts` (the
suite's `include` glob is `src/**/__tests__/**/*.test.ts`, so it is picked up
with no config change).

Walk the commander tree from the exported `program`, collecting a space-joined
path per command (`push fcm`, `nat ddns set`). Slice the README from the
`## CLI reference` heading to the next `## ` heading, pull out the `### `
headings, and compare.

Scope decision, settled: **presence of a heading only.** A heading's command path
must name a real command, and every leaf command must have a heading. Flag lists
inside the heading are *not* validated — that is the brittleness the original
ticket's `tradeoffs:` line warned about, and it would make a wording tweak fail
the build.

Both directions are checked, because both drift:

- **Missing** — every *leaf* command (one with no subcommands) must have a
  heading. Group commands (`push`, `grant`, `trust`, `nat`, `nat ddns`) are
  exempt; the README documents leaves only today.
- **Ghost** — every documented path must resolve to a real command, group or
  leaf. Catches a renamed or deleted command leaving a stale entry behind.

Heading shape: ``### `cadre-host <path...> [flags]` ``. Extract the backticked
inline code, drop the leading `cadre-host`, and take tokens until the first one
starting with `<`, `[`, or `-`. A `### ` heading inside the section that does
*not* match that shape should fail the test saying so, rather than being skipped
— silent skipping is how the section rots.

Failure messages must name the offending commands (`cadre-host push fcm` and
friends), not assert a bare boolean.

## Arm 3 — version from `package.json`

`host.ts` already has `readPackageVersionForStart()` (`host.ts:508`) resolving
`../../package.json` — correct from both `dist/bin/` and `src/bin/`. Rename it
`readPackageVersion()`, update its existing call site in `start`, and feed it to
`.version(...)`. Function declarations hoist, so its position below the program
construction is fine. Assert in the new test that `program.version()` equals
`package.json`'s `version`.

## Arm 4 — document the `push` group

Write the five missing `### ` entries. `docs/cadre-host.md:347-354` already
documents this group accurately — source the prose from there and cross-link
rather than inventing a second description.

Facts that must come through:

- **Not founder-role only.** `host.ts:288-292` wires `pushResolver` into the
  `HostProcessOrchestrator` unconditionally, outside the `ownCadre.enabled`
  branch, and `host-process-orchestrator.ts:380` resolves it on *every* node
  spawn — donated nodes included. Do not mark these commands
  **founder role only**.
- **No running service required.** These commands write straight to the data
  dir's secret store and `host.config.json`. The section's preamble currently
  reads "All commands except `install`, `uninstall`, `start`, and `ui` talk to
  the running cadre-host management API over loopback" — that sentence is now
  false and must gain the `push` group.
- **Credentials take effect on the next node spawn**, so a service restart
  applies them immediately.
- Private keys land in the OS keychain when available, otherwise the 0600
  file-store fallback; the non-secret bits (APNs bundle id / sandbox toggle,
  cooldown, debounce) land in `host.config.json`.

Headings to add (flags read off `host.ts:1013-1130`):

```
### `cadre-host push fcm --project-id <id> --client-email <email> [--private-key-file <path>] [--private-key <pem>] [--data-dir <path>]`
### `cadre-host push apns --key-id <id> --team-id <id> --bundle-id <id> [--private-key-file <path>] [--private-key <pem>] [--production] [--data-dir <path>]`
### `cadre-host push options [--cooldown-ms <ms>] [--debounce-ms <ms>] [--data-dir <path>]`
### `cadre-host push clear <target> [--data-dir <path>]`
### `cadre-host push status [--data-dir <path>]`
```

`push clear`'s `<target>` is one of `fcm` | `apns` | `all`. `push apns` targets
the sandbox host by default; `--production` switches it. Both `fcm` and `apns`
take the key either as a file path or inline, and reject the call when neither is
given.

## Edge cases & interactions

- **Commander's implicit `help` command.** `cadre-host --help` lists
  `help [command]`, and each group lists its own. Confirm whether it appears in
  `.commands` on commander 14 and filter by name regardless — an unfiltered
  `help` would demand a README entry that should not exist.
- **Hidden commands.** None today. Treat a `.hidden()` command as not-required
  but allowed, so hiding a command does not force its removal from the README.
- **Aliases.** None today. Match on `.name()`; an alias must not be mistaken for
  a separate undocumented command.
- **Section slicing.** The README has `### ` headings outside the CLI reference
  (`### Global install (binary on PATH)` and others under `## Install`) that must
  never be scanned. The section terminates at ``## What `cadre-host start` does
  today`` — a `## ` heading containing backticks, so anchor the stop pattern on
  `^## `.
- **Existing heading shapes must all still parse**: ``cadre-host install
  [...flags]`` (first non-path token starts with `[`), ``cadre-host invite
  <label> [--ttl <duration>]``, ``cadre-host ui [--no-browser]``, and the
  three-segment ``cadre-host nat ddns set <provider> --hostname <h> [--token
  <t>]``.
- **Line endings.** Split the README on `/\r?\n/`; this repo is developed on
  Windows and a lone `\n` split leaves `\r` glued to every heading.
- **Empty or renamed section.** If `## CLI reference` is absent, fail with that
  message rather than vacuously passing on an empty heading set.
- **Entry-point regression.** After the `host.ts` change,
  `yarn workspace @serfab/cadre-host build:server` followed by
  `node dist/bin/host.js --help` must still print help — exactly what
  `cli.smoke.test.ts` asserts. `cli-invite.smoke.test.ts` and
  `cli-nat.smoke.test.ts` spawn the same binary and would also go silent.

## Expected test outcomes

- Suite green once the `push` headings land.
- Delete any `### ` heading from the CLI reference → failure naming that command
  path.
- Add a throwaway `program.command('zzz')` → failure naming `cadre-host zzz`.
- Leave a heading for a command that no longer exists → ghost failure naming it.
- `program.version()` equals `package.json`'s `version` (`0.11.0` today), and
  `node dist/bin/host.js --version` prints the same.

## TODO

- Export `program` from `host.ts` and gate `parseAsync()` behind `isEntryPoint()`.
- Rename `readPackageVersionForStart()` → `readPackageVersion()`, update the
  `start` call site, and feed it to `.version(...)`.
- Add the five `### cadre-host push …` entries to the README's CLI reference and
  correct the section preamble's "talks to the management API" exception list.
- Write `src/bin/__tests__/cli-reference.test.ts`: leaf-commands-documented,
  no-ghost-headings, malformed-heading, and version-matches-package assertions,
  with failure messages that name commands.
- Confirm the implicit `help` command is filtered at every level of the tree.
- Validate: `yarn workspace @serfab/cadre-host build:server`, then
  `yarn workspace @serfab/cadre-host test`,
  `yarn workspace @serfab/cadre-host typecheck`, `yarn lint`.
- Confirm vitest exits cleanly (no open handles) with `host.ts` imported.
