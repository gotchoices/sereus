----
description: Two other command-line tools in this repo document their commands as topic-organized prose, so nothing can check that the documentation still matches what the tools actually accept.
prereq: debt-cadre-host-cli-reference-drift-guard
files: packages/cadre-cli/README.md, packages/cadre-provider/README.md
tradeoffs: The topic-organized prose in these READMEs is arguably friendlier to a first-time reader than a mechanical command-by-command list, so a maintainer may reasonably decline to restructure them purely to make an automated check possible.
----

# Extend the CLI-reference drift guard to cadre-cli and cadre-provider

The cadre-host ticket named in `prereq:` adds a test that walks the tool's
command tree and asserts every command appears in its README. That guard only
works because `packages/cadre-host/README.md` has a `## CLI reference` section
with one heading per command, giving the test something mechanical to match
against.

The sibling command-line tools have no equivalent:

- `packages/cadre-cli/README.md` organizes its `## Usage` section by topic —
  *Start a Node*, *Check Status*, *Enroll New Peers*, *Strands*, *Approver Keys*
  — with commands shown inside example blocks rather than under per-command
  headings.
- `packages/cadre-provider/README.md` has a short `### CLI Usage` block and
  otherwise documents HTTP endpoints and configuration.

So neither can be checked, and both drift the same way cadre-host's did.

Two ways forward, and choosing between them is part of this ticket:

1. Give each README a per-command reference section alongside the existing
   topic-organized prose, then point the same guard at it. Costs a second place
   to keep prose, gains a mechanical check.
2. Loosen the guard to "every command name appears somewhere in the README",
   with no heading structure required. Much weaker — it passes on a command
   mentioned only in passing — but needs no restructuring.

Worth doing only once the cadre-host guard has lived long enough to show whether
it catches real drift or just annoys people.

## State after the doc rewrite

The prerequisite has landed: the cadre-host guard is `packages/cadre-host/src/bin/__tests__/cli-reference.test.ts`.

What now exists for cadre-cli: `packages/cadre-cli/README.md` has a `## Command reference` section with one heading per command (`### cadre init`, `#### cadre enroll add`, and so on), beside the task-organized sections. A reviewer's two-way comparison during the rewrite found all 18 leaf commands under a heading and 79 of the 80 options documented. So option 1 above is done for cadre-cli by hand, and nothing keeps it true.

What this ticket still needs for cadre-cli:

- **The guard test.** The same two-way check as cadre-host's: every heading names a real command, and every visible leaf command has a heading.
- **An importable command tree.** `packages/cadre-cli/src/bin/cadre.ts` keeps `program` in a module-local constant and calls `program.parse()` when the module loads, so a spec cannot import the tree as the cadre-host spec imports `program` from `host.ts`.
- **A heading shape the guard can read.** cadre-cli's headings are bare command paths, and parent commands (`### cadre enroll`) have headings too. cadre-host's are whole usage lines in backticks, for leaf commands only. The guard's heading parser needs to accept one or be shared.

cadre-provider is unchanged in kind: its README has a `## Commands` section with one table row per command (`start`, `check`) and a table of flags, not headings. With two commands, the weaker "each command name appears in the Commands table" check may be all it needs.
