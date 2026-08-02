----
description: A new automated check makes sure every test file the test runner executes is also being type-checked, so tests can no longer be quietly hidden from the type checker and drift out of sync with the code.
files: scripts/check-test-file-typecheck-coverage.mjs, scripts/check-test-file-typecheck-coverage.test.mjs, scripts/lib/typecheck-programs.mjs, scripts/check-vitest-typecheck-coverage.mjs, scripts/test-typecheck-allowlist.json, package.json, knip.ts, docs/STATUS.md
----

# Guard that every test file Vitest collects is inside a type-check program — complete

## What shipped

Vitest strips types and executes; it never type-checks the files it runs, so a test file has type
safety only if some `tsc` program happens to include it. Nothing enforced that, and it had already
slipped (`cadre-provider` excluded its own test directory to clear a batch of errors, with no
follow-up filed). Now `scripts/check-test-file-typecheck-coverage.mjs` enforces it.

Per package holding a Vitest config: ask Vitest itself for the file list (`createVitest` +
`globTestSpecifications()`, which resolves `extends`, plugins and nested `projects:` and globs
matches without importing or running anything), add every project's `setupFiles` and `globalSetup`,
keep only TypeScript extensions outside `node_modules`, and diff against the union of the package's
resolved `tsc` programs. Exemptions live in `scripts/test-typecheck-allowlist.json` and are
*validated*, not merely consulted — an entry whose file is now inside the program fails the gate, so
a package that gets fixed forces its own justification to be deleted.

Shared mechanics for this gate and its sibling (`check-vitest-typecheck-coverage.mjs`) moved into
`scripts/lib/typecheck-programs.mjs`, including a new `normalizePath` applied to both sides of every
comparison (Vitest reports forward-slashed paths, TypeScript reports platform separators, and
drive-letter case can differ on Windows).

Wired into root `yarn typecheck` (the gate) and root `yarn test` (its 30-fixture suite). Root now
declares `vitest` as a devDependency so the `vitest/node` import is a real dependency rather than a
hoisting accident.

Repo state on a green run: **251 collected files across 9 Vitest packages, 3 allowlisted, 0
unexplained orphans**, ~1.1 s wall clock.

## Review findings

**Checked:** the full implement diff read before the handoff summary; per-package sweep results
re-measured; every fixture and both script suites re-run; the failure-containment, allowlist-
validation and path-normalization paths read line by line; `eslint.config.mjs` and `knip.ts` scope
checked against what the diff actually added; `docs/STATUS.md` re-read against measured reality; the
board grepped for open tickets already claiming these files.

**Fixed in this pass (minor):**

- **The sweep aborted on an unreadable `package.json`.** `gatherPackage`'s docstring promised "never
  throws: one broken package must report as that package's failure, not abort the sweep", but the
  manifest read sat *outside* the guard. Verified by fixture: a package with `{ not json` produced an
  unhandled `SyntaxError` stack from `readJson`, no package named, remaining packages never swept —
  while the sibling gate handles the same input correctly. The manifest read now sits inside the
  guard (with a non-object manifest rejected explicitly, so a literal `null` cannot re-open the hole),
  and a new fixture asserts the broken package is named *and* the healthy one is still reached.
  Fixture count 29 → 30.
- **`knip.ts` carried a stale `@tsconfig/svelte` exemption**, which made `docs/STATUS.md`'s "the gate
  exits 0 with no knip configuration hints" untrue at HEAD — knip resolves the tsconfig `extends` on
  its own now and emitted `Remove from ignoreDependencies`. Removed; `yarn dep-check` exits 0 with
  zero configuration hints and the same 14 unused files as before. `docs/STATUS.md` now records why a
  configuration hint matters, so the next stale exemption is read as a finding rather than as noise.
  (This was the finding the implement handoff raised and left; it is the same doc-versus-reality
  drift class the ticket exists to stop, so it was worth the two-line fix rather than another ticket.)
- **Duplicated knowledge of the allowlist path** — the literal `'scripts', 'test-typecheck-allowlist.json'`
  was joined separately from the `ALLOWLIST_NAME` constant used in every message. Now derived from the
  one constant.

**Filed as a new ticket (major):**

- `tickets/backlog/debt-tooling-scripts-unlinted-and-unchecked.md` — `eslint.config.mjs` globally
  ignores `scripts/**` and `**/scripts/**`, and nothing under either path is inside a TypeScript
  program. Measured with `wc -l`: 1,768 lines in root `scripts/` plus 891 in `packages/*/scripts/`.
  That tree is no longer release helpers — it now holds the gate scripts themselves plus their test
  suites, i.e. the code that decides whether the other gates pass. A `yarn lint` run that reports
  "clean" says nothing about this diff, which is what makes it worth a ticket rather than a comment.
  Root cause is the single `ignores` entry; the type-checking half is an open choice recorded in the
  ticket rather than pre-decided.

**Recorded as tripwires, not tickets:**

- `scripts/check-test-file-typecheck-coverage.mjs`, at the `process.exit` site — stdout/stderr writes
  are asynchronous for pipes on macOS, so a very long piped failure list could in principle be
  truncated by the exit. Fine while output is capped at ten files per package.
- `scripts/check-test-file-typecheck-coverage.test.mjs`, at the top — every case spawns the gate and
  boots Vitest (~0.5 s each, ~15 s total). Fine at 30 cases; the note says what to do if it passes a
  minute.
- `scripts/lib/typecheck-programs.mjs` — the pre-existing `NOTE:` that `workspacePackageDirs`
  hard-codes `packages/*` was carried over intact by the implementer and still applies to both gates.

**Checked and found clean — stated explicitly rather than left silent:**

- *Path normalization.* Re-verified on Windows only; this machine is Windows, so the POSIX branch (no
  lowercasing) remains unexercised here. It is the branch with strictly less behavior, and the
  fixtures that would catch a mistake in it are platform-independent, so the residual risk is low but
  not zero — a Linux/macOS run of `node scripts/check-test-file-typecheck-coverage.mjs` should still
  report `251 files across 9 packages; 3 allowlisted`.
- *The `record.error` short-circuit in `validateAllowlist`.* Traced: a package that fails to resolve
  is unconditionally pushed onto `failures` in `main`, so skipping its staleness checks cannot turn a
  red run green. The handoff was right to flag it and right about the resolution.
- *Allowlist staleness in both directions.* Both are fixture-covered and both re-ran green; the escape
  hatch cannot rot silently in either direction.
- *Resource cleanup.* `vitest.close()` runs in a `finally`, the sweep and all 30 fixtures terminate
  without hanging, and no orphan Vite handles were observed.
- *The three deliberate blind spots* (`.js` test files, `node_modules` setup modules, `.svelte`) are
  `NOTE:`-commented at their code sites and recorded in `docs/STATUS.md`. Confirmed as choices with
  stated reasons, not oversights — no repo file falls into any of them today.
- *Coverage claims in `docs/STATUS.md`.* Re-measured rather than trusted: 9 Vitest configs found by
  `find`, 251 collected files, 3 allowlisted, 14 knip unused files. The `strand-proto` correction and
  the 11-error allowlist reason both match what the diff says.

## Validation run at review

- `node scripts/check-test-file-typecheck-coverage.mjs` — `251 files across 9 packages; 3 allowlisted`
- `node scripts/check-vitest-typecheck-coverage.mjs` — clean
- `node --test scripts/check-test-file-typecheck-coverage.test.mjs` — **30/30 pass** (~15 s)
- `node --test scripts/check-vitest-typecheck-coverage.test.mjs` — **16/16 pass**, file untouched
- `yarn lint` — exit 0 (see the filed ticket: this says nothing about `scripts/`)
- `yarn typecheck` — exit 0, both gates green at the end
- `yarn dep-check` — exit 0, **zero configuration hints**, 14 unused files

`yarn test` (the full workspace suite) was **not** run end-to-end — it routinely exceeds the ten-minute
agent idle budget. The two script suites it newly chains were run directly and pass.
