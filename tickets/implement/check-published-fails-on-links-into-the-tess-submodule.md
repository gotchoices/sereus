description: Five documentation links point at files inside a borrowed repository that is attached to this one but not shipped with it, so those links are broken for anyone reading on GitHub and they fail the pre-release check; point them at the other repository's own web address and make the link checker reject that kind of link from now on.
architecture: docs/contributing/gates.md#documentation
files: README.md, AGENTS.md, docs/contributing/testing.md, docs/contributing/gates.md, scripts/check-docs.mjs, scripts/check-docs.test.mjs
difficulty: easy
repro: verified
----

# Links into the `tess` submodule are rewritten as URLs, and the doc gate refuses new ones

## What is wrong

`tess` is a git submodule of this repository (`.gitmodules`, gitlink mode `160000`, url `https://github.com/gotchoices/tess.git`, pinned at `2dfde98`). Five Markdown links use a relative path into it. A relative path into a submodule resolves only in a checkout where that submodule has been populated, which the main working copy is and two important places are not:

- **The `check:published` worktree.** `scripts/check-published.mjs` builds its scratch tree with `git worktree add --detach` (around line 219), which creates the submodule's directory but puts nothing in it. `yarn lint` runs inside that tree, so `check-docs` reports the four links to files as missing targets and the whole check fails. That is the symptom the fix ticket was filed for, observed at `d8cef963`.
- **GitHub.** Measured with `curl` on 2026-11-21: `https://github.com/gotchoices/sereus/blob/master/tess/agent-rules/tickets.md` returns **404**, and so does `https://github.com/gotchoices/sereus/tree/master/tess` — the submodule's own directory. GitHub does not serve a submodule's contents under the parent repository's paths, so every one of these links is dead for a reader on GitHub, including the one that points at the directory rather than a file.

The links arrived with `6f888ae9` (the docs restructure, 2026-11-16), after v1.23.0, so this was the first `check:published` run to meet them.

## Reproduction

A fixture repository shaped like the `check:published` worktree — a `.gitmodules` declaring `tess`, an empty `tess/` directory, and copies of the three affected documents — reproduces the failure exactly, with no network and no build:

```
README.md:3: link target does not exist: tess/agent-rules/tickets.md
docs/contributing/testing.md:3: link target does not exist: ../../tess/agent-rules/tickets.md
```

It also shows why the fifth link escaped: `git worktree add` leaves an empty `tess/` directory behind, so `existsSync` is satisfied for a link to the directory itself and the gate passes it — while GitHub 404s on it.

## The five sites

| File | Line | Link today |
|---|---|---|
| `AGENTS.md` | 65 | `[tess](tess/)` |
| `README.md` | 67 | `` [`tess/agent-rules/tickets.md`](tess/agent-rules/tickets.md) `` |
| `docs/contributing/testing.md` | 39 | `[tess/agent-rules/tickets.md](../../tess/agent-rules/tickets.md)` |
| `docs/contributing/testing.md` | 109 | `[tess/agent-rules/tickets.md](../../tess/agent-rules/tickets.md)` |
| `docs/contributing/testing.md` | 123 | `[tess/agent-rules/tickets.md](../../tess/agent-rules/tickets.md)` |

## What to do instead

Point each link at the tess repository's own web address, keeping the visible link text as the path so an agent reading locally still knows which file to open: `https://github.com/gotchoices/tess/blob/main/agent-rules/tickets.md` for the four file links, and `https://github.com/gotchoices/tess` for the directory link in `AGENTS.md`. Both were confirmed to return 200 on 2026-11-21. `main` is tess's default branch (`origin/HEAD -> origin/main`).

**Branch, not pinned commit.** A `blob/main/` URL tracks the rules the repository is meant to follow and never goes stale, at the cost of not naming the exact commit the submodule is pinned to; a commit-pinned URL is reproducible but needs editing on every submodule bump, and the rules an agent should follow are the current ones. This also matches the repository's existing convention: `check-docs` already treats its own GitHub links as branch URLs (`blob|tree/master/`). Note the tradeoff in a sentence if it is not obvious at the sites.

The plain-text mentions of `tess/agent-rules/tickets.md` and `tess/agent-rules/tend.md` in `AGENTS.md` are not links and the gate does not read them. Leave them as paths — they are instructions to an agent working in a checkout where the submodule is populated.

**Initialising the submodule inside the worktree is the wrong fix** and is out of scope: it would make `check:published` pass while leaving every GitHub reader with five dead links, and it would add a network fetch to a check that already takes a long time.

## The gate rule that stops this coming back

`scripts/check-docs.mjs` resolves a relative link — and a `https://github.com/gotchoices/sereus/blob|tree/master/…` link — to a local path in `localTarget()`, then asks `existsSync` about it in `checkLinks()`. Add a rule there: a link whose resolved path is **at or inside a declared submodule path** is a problem regardless of whether the path exists locally. Putting the check immediately after `localTarget()` covers the relative form and the repository-URL form in one place, and covers the submodule's root directory as well as files under it.

Read the submodule paths through git's own config parser rather than hand-parsing the INI — verified to work on a standalone file, inside the repository and outside it:

```bash
$ git config --file .gitmodules --get-regexp '^submodule\..*\.path$'
submodule.tess.path tess
```

Guard the call with `existsSync` on `.gitmodules` and return no paths when it is absent, so a repository without submodules takes the normal path and a genuine git failure still throws rather than being swallowed. Compute the list once, the way `anchorCache` is kept. The message should name the submodule and say what to do — the reader needs to know the link is not merely missing today but wrong everywhere, for example:

```
README.md:67: link into the "tess" submodule: tess/agent-rules/tickets.md. A submodule path is empty in a fresh worktree and 404s on GitHub; link its repository URL instead.
```

## Docs this changes

- `docs/contributing/gates.md` → "Documentation" owns the gate's rules. The "Links resolve" bullet gains the submodule rule and its reason; "Where exemptions live" should say there is no exemption for a submodule link either. The document is at 4,654 words of its 6,000 budget, so there is room.
- `scripts/check-docs.mjs`'s header comment describes check 1 ("Links resolve") and must gain the rule too, in the same voice as the existing note about package READMEs linking by GitHub URL.
- `docs/contributing/testing.md` → "Scratch worktrees and clones" is where the scratch-tree behaviour is described; one sentence there that a worktree carries no submodule content is in scope if it reads naturally. The document is at 2,407 words.

## Test

One new case in `scripts/check-docs.test.mjs`, which already builds a throwaway `git init` repository per run and so can write a `.gitmodules`. It pins the new rule and reproduces the bug at the lowest layer that shows it: a link into a submodule path is refused **even when the file is present on disk** (the main-checkout case that let this ship), and a link to the submodule's root directory is refused too. No other test is owed — the link rewrites are checked by the gate itself.

## TODO

- Rewrite the five links listed above to the tess repository's URLs, keeping the path as the visible link text.
- Add the submodule rule to `checkLinks()` in `scripts/check-docs.mjs`, reading the paths via `git config --file .gitmodules --get-regexp '^submodule\..*\.path$'`, guarded by `existsSync` on `.gitmodules`, computed once, applied after `localTarget()` so it covers both link forms, and matching the submodule root as well as paths under it.
- Update the script's header comment and `docs/contributing/gates.md` → "Documentation"; add the worktree sentence to `docs/contributing/testing.md` → "Scratch worktrees and clones" if it reads naturally.
- Add the `check-docs.test.mjs` case: a submodule link is refused with the file present, and the submodule root is refused.
- Run `yarn lint` (which runs `check-docs` over the whole tree) and `yarn test:check-docs`.
- Confirm the fixture repro above now passes: a `.gitmodules` plus an empty submodule directory and the rewritten documents produce no problems.
- Do not run a full `yarn check:published` inside the ticket — it exceeds the ten-minute limit. Record in the handoff that the end-to-end confirmation is deferred; `yarn check:published --skip-gates` would not exercise the lint step that failed, so it proves nothing here.
