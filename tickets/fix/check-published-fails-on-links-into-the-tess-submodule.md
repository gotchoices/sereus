description: `yarn check:published` fails at its lint step because four doc links point into the `tess` submodule, which the clean worktree the check creates never checks out. The same links are dead on GitHub.
files: README.md, docs/contributing/testing.md, scripts/check-published.mjs, scripts/check-docs.mjs
----

## Symptom

`yarn check:published` (2026-11-21, at d8cef963) stopped at `yarn lint` in its worktree:

```
README.md:67: link target does not exist: tess/agent-rules/tickets.md
docs/contributing/testing.md:39: link target does not exist: ../../tess/agent-rules/tickets.md
docs/contributing/testing.md:109: link target does not exist: ../../tess/agent-rules/tickets.md
docs/contributing/testing.md:123: link target does not exist: ../../tess/agent-rules/tickets.md
check-published: FAILED — yarn lint exited with code 1
```

## Cause

`tess` is a git submodule (`.gitmodules`, gitlink 160000). `check-published.mjs` makes its tree with `git worktree add --detach <dir> <head>` (line ~219), which does not populate submodules, so `tess/` is empty there and `check-docs` reports the links as missing. In the main checkout the submodule is present, so `yarn lint` passes and nothing caught it. The links came in with `6f888ae9` (docs restructure, 2026-11-16), after v1.23.0, so this is the first `check:published` run to meet them.

The links are also dead for any reader on GitHub, where a relative path into a submodule does not resolve to a file.

## Expected

`check:published` passes on a clean tree, and the docs' links to the tess rules resolve for a reader on GitHub.

## Direction

Prefer fixing the links rather than the check: point them at the tess repository's URL (`https://github.com/gotchoices/tess/blob/<branch>/agent-rules/tickets.md`, the URL in `.gitmodules`), and have `check-docs` refuse a relative link whose path goes into a submodule, so this cannot come back. Initialising the submodule inside the worktree would make the check pass but leave the GitHub links dead, and needs a network fetch.
