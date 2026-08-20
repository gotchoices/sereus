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
