----
description: The repo's build and gate helper scripts are skipped by the linter and by the type checker, so roughly 2,600 lines of tooling code — including the scripts that enforce quality gates on everything else — get no automated checking at all.
files: eslint.config.mjs, docs/STATUS.md, scripts/, packages/*/scripts/
difficulty: medium
----

# Tooling scripts are outside every automated check

## What is true today

`eslint.config.mjs` lists `scripts/**` and `**/scripts/**` in its global `ignores` block. Nothing
under either path is linted. Nothing under either path is inside a TypeScript program either — the
files are plain `.mjs`/`.js`, and no `tsconfig.json` in the repo sets `allowJs`/`checkJs` or includes
them.

Measured with `wc -l` on 2026-08-02:

- root `scripts/` — 1,768 lines across 9 files
- `packages/*/scripts/` — 891 lines across 5 files

So ~2,660 lines of code that runs on every developer machine and in every gate invocation has no lint
pass and no type pass.

## Why it matters more than it used to

When the exclusion was written, `scripts/` held release helpers. It now holds the gates themselves:
`check-dep-ranges.mjs`, `check-vitest-typecheck-coverage.mjs`, `check-test-file-typecheck-coverage.mjs`
and a shared `lib/`, together with their own test suites — the code that decides whether `yarn lint`,
`yarn typecheck`, `yarn test` and `yarn dep-check` pass or fail. A silent mistake in that code does not
show up as a red build; it shows up as a gate that stops catching things, which is the exact failure
mode the type-check-coverage work exists to prevent.

`docs/STATUS.md` already records the exclusion honestly (see "Lint coverage" → Scope notes), so this
is not a documentation drift; it is a scope decision that has outlived its rationale.

## What the work is

Two arms, both rooted at the same place — the `ignores` entry in `eslint.config.mjs`:

**Lint.** Drop `scripts/**` and `**/scripts/**` from the global `ignores`, give those trees a config
block with node globals and non-type-aware rules, and fix whatever the first run reports. The
per-package `scripts/` dirs need the same treatment or their own narrower ignore — note that removing
`**/scripts/**` also pulls in `packages/cadre-host/scripts/*.mjs`, which `knip.ts` already declares as
real entry points.

**Type-check (open question, decide as part of the work).** Options are: leave them as unchecked
JavaScript; add `// @ts-check` plus a `checkJs` tsconfig covering `scripts/`; or convert the gate
scripts to TypeScript and run them through `tsx`/a build step. The third buys the most and costs the
most — the scripts currently run with bare `node` and no toolchain, which is part of why they are
reliable. Pick one deliberately rather than defaulting.

Whatever lands, update `docs/STATUS.md` → "Lint coverage" → Scope notes so the recorded scope matches
reality again.

## Third arm — `ops/**` (added 2026-08-03 during review of `turn-issuer-peer-assertion`)

Same `ignores` block, same root cause: `ops/**` is listed there too, so nothing under `ops/` is
linted. That tree is no longer just YAML and shell. Measured with
`wc -l $(find ops -name '*.ts' -o -name '*.mjs' | grep -v node_modules | grep -v dist)` on 2026-08-03:

- `ops/docker/turn-credential-issuer/src/` — 1,699 lines of TypeScript across 3 files
- `ops/docker/libp2p-infra/src/` — 126 lines of TypeScript in 1 file
- `ops/test/` — 1,175 lines of `.mjs` across 6 files

Type coverage is the better half of the story here and should not be confused with lint coverage:
both Docker services carry their own `tsconfig.json` with `strict: true`, and each one's
`npm run build` is a real type gate — it is just not reachable from root `yarn typecheck`, because
`ops/` sits outside the `workspaces` glob (`packages/*`). The `.mjs` files under `ops/test/` have no
type coverage at all, matching the `scripts/` situation above.

So the ask is narrower than the first two arms: **lint** these trees (they are ES modules with node
globals, same shape as the `scripts/` config block), and decide whether the two per-service builds
should be wired into a root gate so a broken `ops/` service fails CI rather than failing at
`docker build` time on an operator's machine. Do not fold `ops/` into `workspaces` to get there —
these are standalone deployables with their own dependency trees, deliberately not hoisted.

## The unchecked surface grew (noted 2026-08-03 during review of `release-smoke-published-install`)

Not a new arm — the same `ignores` entry, restated with a current measurement. The release smoke gate
(`yarn smoke:published`) landed entirely inside the ignored tree. Re-measured with
`wc -l scripts/*.mjs scripts/*.js scripts/lib/*.mjs`:

- root `scripts/` — **2,854** lines, up from the 1,768 recorded above on 2026-08-02
- `packages/*/scripts/` — unchanged at 891 lines

The new files are `scripts/smoke-published-install.mjs`, `scripts/lib/published-smoke-support.mjs`,
`scripts/lib/published-smoke-scenario.mjs` and `scripts/smoke-published-install.test.mjs`. The first
three decide whether the packages we are about to publish are shippable, and the last is the only
thing pinning them — all four unlinted and untyped. That sharpens the "the gates themselves are
unchecked" point above rather than changing the work.

## Evidence for the `ops/**` arm (noted 2026-09-04 during review of PR #9)

A feature change to `ops/docker/libp2p-infra/src/main.ts` — adding the WebSockets listener the RN
client needs — reached review having been through no automated check whatsoever: `ops/**` is
eslint-ignored, the folder is not a workspace, and there is no CI configuration in the repo at all
(no `.github/`), so nothing built it, typed it or ran it. Two of the four defects the review found
(an unvalidated env var that exits with a transitive dependency's stack trace, and a startup block
that prints nothing under a supported configuration) are the kind a first run catches. They were
found by hand-building the image source in a scratch worktree and running it, which is not a
repeatable gate.

This is the second arm's "decide whether the two per-service builds should be wired into a root
gate" question, with a concrete instance behind it now: `npm --prefix ops/docker/libp2p-infra
install && npm run build` is a real type gate that already exists and is simply not reachable from
any root script.


## Evidence for the `ops/**` arm (found during the documentation rewrite)

Two leftovers under `ops/` that no check reports. `knip.ts` ignores `ops/**` just as ESLint does, and `ops/test` is not a workspace, so the dependency check never reads its `package.json`.

- `ops/test/package.json` depends on `sereus-workspace: file:../..`, which is the repository root. Neither `check-node.mjs` nor `check-stun.mjs` imports anything from it. The install the README gives (`npm --prefix sereus/ops/test install`) works, and has been run in this checkout: it links the whole clone into `ops/test/node_modules`. The entry has no use and ties the two scripts to a full clone.
- `ops/docker/site-scripts/up.sh`, `down.sh` and `logs.sh` each `exec` a file named `svc` in their own directory. That directory holds `svc.sh`, not `svc`. `ops/scripts/install` links only `svc.sh` into an instance directory, under the name `svc`, and neither copies nor links the three wrappers. No document mentions them. Run where they sit they fail because `svc` does not exist; they work only if someone copies them by hand beside an installed `svc`.

Both are deletions. They are JSON and shell, so neither a lint pass nor a type pass would have found them. They are recorded here as what collects in a tree that nothing checks, and as a reason to weigh a dependency check for `ops/test` and `ops/docker/*` along with the lint.

## Premise check

Read against the tree during the documentation rewrite. The ticket's substance holds; its document references do not.

- **`docs/STATUS.md` does not exist** (it is in the `files:` line and cited twice above). "Lint coverage" is now a section of `docs/contributing/gates.md`. It has no "Scope notes" sub-section; the exclusion is recorded there under "What it cannot catch" → "Trees the config ignores", which names this ticket. That item is what to update when the scope changes.
- **The ignores are unchanged.** The global `ignores` block of `eslint.config.mjs` still lists `ops/**`, `scripts/**` and `**/scripts/**`.
- **The unchecked surface has grown again.** `git ls-files -co --exclude-standard scripts | grep -E '\.(mjs|js)$' | xargs wc -l` gives 6,770 lines in 33 files, against 2,854 in the last measurement above. The same listing filtered to `packages/*/scripts/` (`.mjs`, `.js`, `.cjs`, `.ts`) gives 1,090 lines in 7 files, against 891. The root tree now also holds `check-docs.mjs`, `check-published.mjs`, `check-stale-build-guard-wiring.mjs` and the release scripts, each with a test file.
