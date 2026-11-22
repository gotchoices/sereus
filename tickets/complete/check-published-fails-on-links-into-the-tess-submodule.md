description: Five documentation links pointed at files inside a borrowed repository that is attached to this one but not shipped with it, which broke them for anyone reading on GitHub and failed the pre-release check; they now point at the other repository's own web address, and the link checker refuses that kind of link from now on.
architecture: docs/contributing/gates.md#documentation
files: README.md, AGENTS.md, docs/contributing/testing.md, docs/contributing/gates.md, scripts/check-docs.mjs, scripts/check-docs.test.mjs
----

# Complete: links into the `tess` submodule are rewritten, and the doc gate refuses new ones

## What shipped

**The five links point at the tess repository.** `AGENTS.md` links `https://github.com/gotchoices/tess`; `README.md` and the three sites in `docs/contributing/testing.md` link `https://github.com/gotchoices/tess/blob/main/agent-rules/tickets.md`. The visible link text stayed the repository-relative path in every case, so an agent reading locally still sees which file to open. The plain-text (unlinked) mentions in `AGENTS.md` were left as paths. A branch URL rather than the pinned commit (`2dfde98`) was chosen deliberately: it tracks the rules currently in force and needs no edit on a submodule bump; the reasoning is recorded in `docs/contributing/gates.md`.

**`scripts/check-docs.mjs` refuses a link into a submodule.** `submodules()` reads `.gitmodules` through `git config --file .gitmodules --get-regexp -z '^submodule\..*\.path$'` and caches the `{ name, path }` pairs the way `anchorCache` is kept; `submoduleOf(target)` returns the submodule a resolved target is at or inside. `checkLinks()` consults it immediately after `localTarget()`, so the rule covers both link forms the gate resolves (relative, and `github.com/gotchoices/sereus/blob|tree/master/`) and matches the submodule's root directory as well as paths under it. The problem line names the submodule and says what to do, and replaces rather than adds to "link target does not exist".

**Docs.** The script's header comment carries the rule under check 1. `docs/contributing/gates.md` → "Documentation" carries it as a paragraph beside the existing paragraph about GitHub-URL links, and its "Where exemptions live" paragraph says a submodule link has no exemption. `docs/contributing/testing.md` → "Scratch worktrees and clones" says a worktree carries no submodule content.

**Test.** One case in `scripts/check-docs.test.mjs`: a link into a submodule is refused with the target present on disk. That is the condition that let the bug ship — the main checkout has `tess` populated, so `existsSync` was satisfied — and the case also covers the link to the submodule's root directory, which even the empty-directory worktree passed. The link rewrites themselves are checked by the gate on every `yarn lint`, so no test is owed for them.

Implemented in `ticket(implement): check-published-fails-on-links-into-the-tess-submodule`; the two review fixes below are in the review commit.

## Review findings

**Fixed in this pass (minor).**

- **`.gitmodules` parsing split on the first space.** `submodules()` parsed `git config --get-regexp` output with `line.split(' ')`, which is wrong whenever a space appears in either half of a record. Verified against a fixture declaring `[submodule "my rules"]` with `path = vendor/my rules`: the gate passed a link straight into that submodule, because the parsed path came out as `submodule.my` / `rules.path vendor/my rules`. A mis-parsed path can also match the wrong directory, so the failure mode runs both ways. Switched the call to `-z`, which prints each match as `key\nvalue\0`, and split on the NUL and the first newline. Re-verified: the same fixture now reports the link and names the submodule, and a `.gitmodules` with no `path` key still exits 0.
- **`docs/contributing/gates.md` said "It checks three things" and then listed four bullets.** The implement commit added the submodule rule as a fourth peer bullet, which contradicted both that sentence and the script, where the rule lives inside check 1 ("Links resolve"). Moved it to a paragraph beside the existing elaboration of the links check (the GitHub-URL paragraph), leaving three bullets true. This also settles the handoff's own question about that bullet being the longest item in the list.

**Checked and clean.**

- **The `git config` error handling**, which the handoff flagged as the one place a real git failure could hide. Only exit status 1 is swallowed, with the reason stated in a comment; a missing `git` binary throws `ENOENT` with no `status` and rethrows. Confirmed by fixture that an absent `.gitmodules` and a `.gitmodules` declaring no `path` key both take the quiet path.
- **`submoduleOf()` boundaries.** A target above the repository root gives a `relative()` beginning `../`, so no prefix match can fire; `vendor/rules-extra/x.md` is not matched by a `vendor/rules` submodule because the prefix test requires the `/`; a link to the submodule root with no trailing slash matches on the equality arm. Windows separators are normalised through `toPosix` before comparison.
- **The link rewrites.** No relative link into `tess/` remains anywhere the gate reads (`grep` over all Markdown outside `tickets/` and `tess/`). The gate's own worktree-shape fixture — this repository's `.gitmodules`, an empty `tess/`, and the rewritten documents — reports no problem mentioning `tess`, which is the exact failure the fix ticket was filed for.
- **Validation.** `yarn lint` clean, `check-docs: 66 Markdown file(s) OK.` `yarn test:check-docs` 8 pass. No pre-existing failures surfaced. `scripts/check-docs.mjs` is 296 lines, well inside anything that would call for a split.
- **The new test earns its place** and was kept as written: it reproduces the shipped bug at the lowest layer that shows it, and uses a generic submodule name so it does not lean on the `EXCLUDED_ROOTS` entry for `tess/`. No test was cut — the file has no test that restates the implementation or verifies a mock.

**No tickets filed.** Both findings were one-line fixes at the site, so neither reached the filing bar, and neither names a class of defect that a type or invariant would retire.

**No tripwires parked.** The one candidate is the handoff's note that nothing in the repository re-checks the four external tess URLs, so a rename in that repository would make them dead. That is true of every external link in these docs, is already stated in `docs/contributing/gates.md` → "What it cannot catch" → "Links it does not read", and has no single site to annotate, so adding a `NOTE:` would duplicate a documented limit rather than record new knowledge.

## Deferred to a human

**One full `yarn check:published` run before the release.** It exceeds the ten-minute agent limit, and `--skip-gates` would not run the lint step that failed, so it proves nothing here. The empty-`tess/` fixture above reproduces the worktree's submodule state without the build, which is the part this change affects, but the end-to-end pass has not been observed.
