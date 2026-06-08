description: Completed — root project-instructions file is now tracked as uppercase `AGENTS.md`, matching the `@AGENTS.md` import in `CLAUDE.md`. Previously tracked lowercase (`agents.md`), which silently failed to load on case-sensitive filesystems (Linux CI, case-sensitive macOS). Pure git-index rename; no code/build/test impact. Per ticket instruction, taken straight to complete (no separate review stage).
files: AGENTS.md, CLAUDE.md
----

# Fix `agents.md` filename case (cross-platform instruction loading)

## Outcome

`CLAUDE.md` contains a single line, `@AGENTS.md`, but the root instructions file was tracked in git
as lowercase **`agents.md`**. On Windows (case-insensitive FS, where the repo currently develops) the
import resolved fine; on a **case-sensitive filesystem** — Linux CI or a case-sensitive macOS volume —
`@AGENTS.md` would not resolve to `agents.md`, so the agent loaded **no** project instructions at all.
That directly contradicted the repo's own "think cross-platform" tenet.

The tracked filename is now **`AGENTS.md`** (uppercase), matching the reference. File content is
unchanged — this was a rename only.

### How

Because Windows is case-insensitive, a direct `git mv agents.md AGENTS.md` is a no-op. Used the
two-step dance:

```
git mv agents.md AGENTS.md.tmp
git mv AGENTS.md.tmp AGENTS.md
```

Git staged the change as `R  agents.md -> AGENTS.md`.

### Verification

- `git ls-files | grep -i agents.md` → index now shows `AGENTS.md` (root), plus the unrelated
  `tickets/AGENTS.md` and this ticket file.
- `git status --short` → `R  agents.md -> AGENTS.md` (clean rename, no content delta).
- `CLAUDE.md` still reads `@AGENTS.md` and now matches the tracked name exactly.
- `head -3 AGENTS.md` confirms the original content ("You are focused on the Sereus monorepo…") is
  intact.

## Review findings

Per the ticket's explicit instruction ("Don't bother pushing this through to review; go right to
complete"), this was taken straight to complete. The change is a single git-index filename-case
rename with **zero** source/build/test surface, so there was nothing to build or test — the
correctness gate is the index state itself, which was verified above.

### What was checked

- **Scope is exactly the rename.** Working tree shows only `R  agents.md -> AGENTS.md`; no content
  diff, no other files touched.
- **The motivating bug is actually fixed.** `CLAUDE.md`'s `@AGENTS.md` import now case-matches the
  tracked filename, so project instructions will load on case-sensitive filesystems.
- **`tickets/AGENTS.md` unaffected.** It was already uppercase and is a separate file (the
  ticket-rules doc) — confirmed untouched.
- **No dangling lowercase reference.** `CLAUDE.md` is the only consumer of the `@AGENTS.md` import and
  it uses the uppercase form.

### Known residual gaps

- The rename is only realized in git history once the runner commits this stage. On the contributors'
  case-insensitive Windows checkouts the working-tree filename will still *appear* however the local
  FS chose to store it; the **tracked/index** name is what matters for case-sensitive checkouts, and
  that is now `AGENTS.md`. Nothing further required.
