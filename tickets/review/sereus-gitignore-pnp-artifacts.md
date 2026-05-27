description: gitignore the yarn-berry PnP artifacts (.pnp.cjs / .pnp.loader.mjs)
files: .gitignore
----

## What was done

Added `.pnp.*` to the root `.gitignore` so the Yarn Berry PnP-linker artifacts
(`.pnp.cjs`, `.pnp.loader.mjs`) are no longer surfaced as untracked files after
`yarn install`. The pattern is glob-based to also catch any future PnP-named
variants without enumerating them.

The new line sits alongside the existing yarn entries:

```
.yarnrc.yml
.DS_Store
.yarn
.pnp.*        <- added
*.tsbuildinfo
```

## Validation

- `git check-ignore .pnp.cjs .pnp.loader.mjs` → both paths returned, exit 0
  (confirms the pattern matches the two files the ticket names).
- `git ls-files` shows no PnP files are tracked, so there's nothing to
  `git rm --cached` — the change is purely additive ignore coverage.
- No PnP artifacts currently exist in the working tree (this checkout isn't
  using the PnP linker at the moment), so the visible-in-`git status` symptom
  couldn't be reproduced live here; the fix was validated via `git check-ignore`
  instead, which is the authoritative test for ignore behavior.

## Reviewer notes / use cases

- Primary use case: a fresh checkout that runs `yarn install` with the default
  PnP linker should now show a clean `git status` (no untracked `.pnp.*`).
- The ticket also flagged that the same fix likely belongs in sibling repos
  `gotchoices/quereus` and `gotchoices/optimystic`. Those are separate
  repositories (linked here only via `resolutions`), out of scope for this
  monorepo ticket and not modified. If the team wants them fixed, that's a
  per-repo change tracked elsewhere.

## Known gaps

- Trivial config-only change; no build or test run is meaningful for it.
- The "zero-installs" alternative (committing the PnP files instead of ignoring
  them) was intentionally not pursued — the ticket favored the ignore approach
  and the repo shows no sign of opting into zero-installs.
