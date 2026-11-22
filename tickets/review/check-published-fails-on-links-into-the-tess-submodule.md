description: Five documentation links pointed at files inside a borrowed repository that is attached to this one but not shipped with it, which broke them for anyone reading on GitHub and failed the pre-release check; they now point at the other repository's own web address, and the link checker refuses that kind of link from now on.
architecture: docs/contributing/gates.md#documentation
files: README.md, AGENTS.md, docs/contributing/testing.md, docs/contributing/gates.md, scripts/check-docs.mjs, scripts/check-docs.test.mjs
difficulty: easy
----

# Review: links into the `tess` submodule are rewritten, and the doc gate refuses new ones

## What changed

**The five links now point at the tess repository.** `AGENTS.md:65` links `https://github.com/gotchoices/tess`; `README.md:67` and the three sites in `docs/contributing/testing.md` (lines 39, 109, 123) link `https://github.com/gotchoices/tess/blob/main/agent-rules/tickets.md`. The visible link text is unchanged in every case, so an agent reading locally still sees which file to open. The plain-text mentions of `tess/agent-rules/tickets.md` and `tess/agent-rules/tend.md` in `AGENTS.md` are untouched, as the ticket directed.

**`scripts/check-docs.mjs` refuses a link into a submodule.** Two new functions sit beside `anchorCache`: `submodules()` reads `.gitmodules` through `git config --file .gitmodules --get-regexp '^submodule\..*\.path$'` and caches the `{ name, path }` pairs; `submoduleOf(target)` returns the submodule a resolved target is at or inside. `checkLinks()` consults it immediately after `localTarget()`, so the rule covers the relative form and the `github.com/gotchoices/sereus/blob|tree/master/` form in one place, and matches the submodule's root directory as well as paths under it. The branch taken is reported instead of, not in addition to, "link target does not exist", so a submodule link gets exactly one problem line naming the submodule and saying what to do.

**Docs.** The script's header comment gained the rule under check 1. `docs/contributing/gates.md` → "Documentation" gained a "No link into a submodule" bullet carrying both reasons (empty in a worktree, 404 on GitHub) and the branch-over-pinned-commit choice; its "Where exemptions live" paragraph now says a submodule link has no exemption either. `docs/contributing/testing.md` → "Scratch worktrees and clones" gained one sentence that a worktree carries no submodule content.

## What to check

- **The `git config` error handling.** `submodules()` returns no paths when `.gitmodules` is absent, and swallows exit status 1 only (`git config`'s "no key matched", for a `.gitmodules` that declares no `path` key). Any other status rethrows. Confirm that reading is right — it is the one place the change can hide a real git failure.
- **`submoduleOf()` on a target outside the repository.** It compares `toPosix(relative(rootDir, target))`, which begins `../` for anything above the root, so no prefix match can fire. A `vendor/rules-extra/x.md` is likewise not matched by a `vendor/rules` submodule, because the prefix test requires the `/`.
- **The branch-vs-pinned-commit choice.** `blob/main/` tracks the rules an agent should actually follow and never needs editing on a submodule bump, at the cost of not naming the commit `tess` is pinned to (`2dfde98`). The reasoning is stated in the gates.md bullet rather than at each link site. If a reviewer prefers the pinned form, this is the decision to revisit.
- **Whether the gates.md bullet is over the 120-word block budget.** It is not — `yarn check:docs` passes — but it is the longest item in that list, and a reviewer may judge that it should become a sub-paragraph instead.

## Test

One case added to `scripts/check-docs.test.mjs`: *a link into a submodule is refused even with the target present on disk*. It writes a `.gitmodules` declaring `vendor/rules`, puts a real `vendor/rules/guide.md` on disk, and links both that file and `vendor/rules/`. It asserts the gate exits 1 and names the submodule for each of the two links. The file-present case is the one that let this ship (the main checkout has `tess` populated, so `existsSync` was satisfied), and the directory case is the link that even an empty-directory worktree passed. A deliberately generic submodule name, not `tess`, keeps the test from leaning on the `EXCLUDED_ROOTS` entry for `tess/`.

No other test is owed: the five link rewrites are checked by the gate itself on every `yarn lint`.

## Validation run

- `yarn test:check-docs` — 8 tests pass, including the new case.
- `yarn lint` — ESLint clean, `check-docs: 66 Markdown file(s) OK.`
- The ticket's fixture repro: a throwaway `git init` repository holding this repository's `.gitmodules`, an **empty** `tess/` directory, and copies of `AGENTS.md`, `README.md` and `docs/contributing/testing.md`, run with `CHECK_DOCS_ROOT` pointed at it, reports no problem mentioning `tess`. That is the shape of the `check:published` worktree and the exact failure the fix ticket was filed for.
- `git status` shows only the six files above; the fixture was deleted.

## Known gaps

**The end-to-end `yarn check:published` run is deferred**, as the ticket directed — it exceeds the ten-minute agent limit, and `--skip-gates` would not run the lint step that failed, so it would prove nothing. The fixture run above reproduces the worktree's submodule state without the build, which is the part that matters here; a human or CI should still see one full `check:published` pass before the release.

**The four rewritten URLs were confirmed 200 on 2026-11-21** (recorded in the fix ticket), but nothing in the repository checks them from now on: `check-docs` does not fetch external URLs, by design. A rename of `agent-rules/tickets.md` in the tess repository would make these links dead with no gate to catch it. That is a property of every external link in these docs, not something this change introduced, so it is recorded here rather than parked as a tripwire at a site.
