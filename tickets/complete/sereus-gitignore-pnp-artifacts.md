description: gitignore the yarn-berry PnP artifacts (.pnp.cjs / .pnp.loader.mjs)
files: .gitignore
----

## What was done

Added `.pnp.*` to the root `.gitignore` so the Yarn Berry PnP-linker artifacts
(`.pnp.cjs`, `.pnp.loader.mjs`) are no longer surfaced as untracked files after
`yarn install`. The glob pattern also covers future PnP-named variants
(`.pnp.data.json`, legacy `.pnp.js`) without enumerating them.

The line sits among the existing yarn entries (`.yarnrc.yml`, `.yarn`,
`*.tsbuildinfo`) at `.gitignore:7`.

## Review findings

**Diff reviewed:** commit `09aad74` — a single `+.pnp.*` line in `.gitignore`.

- **Correctness** — Verified the pattern with `git check-ignore .pnp.cjs
  .pnp.loader.mjs .pnp.data.json .pnp.js`: all four returned, exit 0. The
  pattern matches the two files the ticket names plus the other PnP variants
  yarn can emit, so coverage is complete and future-proof.
- **No tracked artifacts** — `git ls-files | grep -i pnp` returns only the
  ticket file itself; no `.pnp.*` is tracked, so the additive ignore is
  sufficient and no `git rm --cached` is needed.
- **Placement / style** — Line is grouped logically with the other yarn
  entries; consistent with surrounding glob patterns (`*.tsbuildinfo`).
- **Build / tests** — N/A and intentionally skipped. This is a `.gitignore`-only
  change with no code, schema, or build surface; no lint or test run exercises
  it. The authoritative test (`git check-ignore`) was run and passes.
- **Docs** — No documentation references PnP linker artifacts or the
  `.gitignore` contents; nothing to update.
- **Out of scope (no findings, by design)** — Sibling repos `gotchoices/quereus`
  and `gotchoices/optimystic` share the Yarn Berry setup and likely want the
  same fix, but they are separate repositories (linked here only via
  `resolutions`). Correctly left unmodified; the implementer documented this.
  The "zero-installs" alternative (committing PnP files) was reasonably declined
  — the repo shows no opt-in to that model.

**Disposition:** No minor fixes required, no major findings to spawn tickets
for. The change is correct, complete, and verified.
