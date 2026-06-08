----
description: Root project-instructions file is tracked as lowercase `agents.md` while `CLAUDE.md` imports `@AGENTS.md`; on case-sensitive filesystems (Linux CI / Mac case-sensitive) that reference does not resolve, so the project instructions silently fail to load. Rename the tracked file to `AGENTS.md`.
files: agents.md, CLAUDE.md
----

# Fix `agents.md` filename case (cross-platform instruction loading)

`CLAUDE.md` contains `@AGENTS.md`, but the file is tracked in git as lowercase **`agents.md`**
(confirmed via `git ls-files` / `git ls-tree`). This works on Windows (case-insensitive FS, where
the repo currently develops) but on a **case-sensitive filesystem** — Linux CI, or case-sensitive
macOS volumes — `@AGENTS.md` will not resolve to `agents.md`, so the agent loads no project
instructions at all. This directly contradicts the repo's own "think cross-platform" tenet.

This is **pre-existing** (the parent of `build-health-eslint` already tracked it lowercase) and was
not introduced by the lint work — surfaced incidentally while reviewing that ticket, which edited
the file.

## Expected outcome

- The tracked filename is `AGENTS.md` (uppercase), matching the `@AGENTS.md` reference in `CLAUDE.md`.
- Because Windows is case-insensitive, the rename needs the two-step git dance
  (`git mv agents.md tmp` → `git mv tmp AGENTS.md`) or `git mv -f`, then verify with
  `git ls-files | grep -i agents.md` that the index shows the uppercase name.
- Confirm `tickets/AGENTS.md` (the separate ticket-rules file) is unaffected.


Don't bother pushing this through to review; go right to complete.
