----
description: One package's README has a section listing every command the tool accepts, but nothing checks that the list stays complete, and a whole group of commands is already missing from it.
files: packages/cadre-host/README.md, packages/cadre-host/src/bin/host.ts
tradeoffs: A maintainer may find a mechanical README-vs-code check brittle — headings are prose, and a test that fails on a wording tweak is a test people learn to work around rather than a real guard.
----

# Nothing keeps cadre-host's CLI reference in sync with its CLI

## The instance

`packages/cadre-host/README.md` has a `## CLI reference` section that documents
each command under its own `### ` heading. The `cadre-host push` group —
`push fcm`, `push apns`, `push options`, `push clear`, `push status`, defined in
`packages/cadre-host/src/bin/host.ts` from roughly line 1009 — has no entry at
all. A reader of the README has no way to learn those commands exist.

## The class

That gap is not interesting on its own; the interesting part is that nothing
noticed it. The reference is hand-maintained prose sitting next to a
commander-based CLI that knows its own full command list at runtime, so the two
drift silently and the next command added drifts the same way.

A guard closes the class: walk the commander program's registered commands and
subcommands, and assert each one appears in the README's CLI reference. That is
a handful of lines, runs in the existing vitest suite, and fails the moment a new
command lands undocumented rather than months later when someone reads the file.

Scope decisions for whoever picks this up: whether the check is
presence-of-heading only (cheap, robust) or also validates the flag list (much
stricter, much more brittle), and whether documenting `push` accurately is part
of this ticket or a prerequisite commit. Note that push credentials are resolved
on *every* node spawn, donated nodes included — so the group is not
founder-role-only and should not be documented as if it were.

## Why it is filed rather than fixed inline

Found during the review of the donor-first README rewrite, which deliberately
changed only the framing of existing content. Documenting five undocumented
subcommands with their flags is separate work from that correction.
