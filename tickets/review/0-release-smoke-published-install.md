----
description: A new release-time script installs our packages the way a customer would — from real tarballs into a throwaway project — and runs a single-node scenario against them. It currently fails on purpose, because installing our library from the registry today is genuinely broken.
prereq:
files: scripts/smoke-published-install.mjs, scripts/lib/published-smoke-scenario.mjs, package.json, docs/STATUS.md, packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts
difficulty: medium
----

# What landed

Two new files, one new root script, one docs section. No package source changed.

- **`scripts/smoke-published-install.mjs`** — the gate. Packs every `pub:*` workspace, installs the
  tarballs plus registry dependencies into a scratch project under the OS temp dir with **npm**,
  prints a resolved-version report, then runs the scenario below against that install.
- **`scripts/lib/published-smoke-scenario.mjs`** — the scenario body, copied verbatim into the
  scratch project and run there by `node`. A port of
  `packages/cadre-core/test/control-database-solo.spec.ts` (plus the parts of
  `control-db-node-helpers.ts` it needs) onto `node:assert/strict`, because the scratch project has
  neither vitest nor deep access into the package.
- **`package.json`** — `"smoke:published": "node scripts/smoke-published-install.mjs"`. Not wired
  into `yarn test`, by design: it needs the network and takes ~40 s.
- **`docs/STATUS.md`** — new section "Installing what a customer installs — `yarn smoke:published`
  (a release step, not a test)", directly after the existing dependency-range section.

## The headline: it fails, and that is correct

```
yarn smoke:published --skip-build
```

ends with:

```
IMPORT FAILURE — the published packages could not be loaded.
  code: ERR_MODULE_NOT_FOUND
  missing specifier: chai
  imported from:     <scratch>\project\node_modules\@optimystic\db-p2p\dist\src\testing\raw-storage-conformance.js
  ...
smoke-published-install: FAILED — the scenario exited with code 1.
```

That is the upstream defect recorded in
`tickets/blocked/optimystic-testing-barrel-breaks-consumer-install`. **Do not install `chai` into
the scratch project to make this green** — that hides the exact defect the script exists to catch.
A green run is only expected once that blocked ticket is resolved.

# How to validate this

## Run it

```
yarn smoke:published --skip-build     # ~40 s; reuses existing dist/
yarn smoke:published                  # full monorepo build first, then the above
yarn smoke:published --skip-build --keep   # keeps the scratch project on success too
```

Expected today: exit code 1, with the `chai` import-failure block above. A failing run always leaves
the scratch project in place and prints its path on the last line.

## What the output should show, in order

1. The publishable set, derived from the root `pub:*` scripts (6 workspaces today).
2. One `yarn workspace <name> pack --out …` per workspace, then the tarball list.
3. The scratch project's `dependencies` — six `file:../tarballs/*.tgz` entries plus
   `@optimystic/db-p2p` and `@libp2p/websockets` at the range the manifests declare (the scenario
   imports those two directly, so the scratch project must declare them itself).
4. `npm install` output.
5. **The resolved-version report, printed before any case runs** so it survives a crash: every
   `@serfab/*` / `@optimystic/*` / `@quereus/quereus` package plus `libp2p` and
   `@libp2p/websockets`, with version *and* path as hoisted into the consuming project — then a
   second block listing every *nested* copy a package resolves instead. On the verification run the
   nested block correctly showed real duplicates (`@serfab/cadre-core → uint8arrays 5.1.1` at a
   nested path, and three more).
6. The scenario's per-case `PASS`/`FAIL` lines.

## The three failure shapes, all exercised by hand

Verified by editing a *copy* of `scenario.mjs` inside the scratch project (the repo file was not
touched). Worth re-checking the same way if you change the reporting:

| shape | how it was forced | output |
|---|---|---|
| import failure | none — this is the live state | `IMPORT FAILURE`, missing specifier + importing file echoed verbatim |
| assertion | `'inserted'` → `'nope'` | `assertion failed` + `expected:` / `actual:` (via `util.inspect`, not `JSON.stringify` — several assertions compare `Set`s) |
| hang | one op replaced with `new Promise(() => {})`, `OP_TIMEOUT_MS` 500 | `HANG: solo control op hasOwnerKey() (pre-genesis) timed out after 500ms` |

Note the first hang attempt (`OP_TIMEOUT_MS = 1`) did **not** trip — every solo op completes in
well under a millisecond, so the deadline never got a chance. If you want to re-verify the deadline,
force a never-settling promise rather than shrinking the budget.

## The scenario itself is sound

With `chai` installed by hand into the scratch project (verification only — not something the script
does), all three cases pass:

```
PASS  solo, transaction profile — genesis, read-back, solo write, read-back (206ms)
PASS  solo, storage profile — genesis, read-back, solo write, read-back (87ms)
PASS  solo, restart — re-reads control rows on the same identity and storage (101ms)
3/3 case(s) passed.
```

Those are the same three cases as the source spec, which also passes here
(`yarn vitest run test/control-database-solo.spec.ts` in `packages/cadre-core` — 3 passed).

## Checks run

- `yarn lint` — clean. (`scripts/**` is in eslint's ignore list *and* knip's root-workspace ignore,
  so neither gate sees these two files; nothing to configure.)
- `yarn test:dep-ranges` (9 pass), `yarn test:vitest-typecheck-coverage`,
  `yarn test:test-file-typecheck-coverage` — all pass.
- `packages/cadre-core` `control-database-solo.spec.ts` — 3 pass.
- Full `yarn test` was **not** run: the diff touches no package source, and the whole-monorepo suite
  is far past the runnable window here.

# Known gaps — treat these as the starting point

- **The success path of the script has never run end to end.** Every verification run ended in the
  `chai` failure. So the final `PASSED` line and the on-success `cleanup()` are unexercised *by the
  script*. `rmSync` on a real 386-package scratch tree was verified separately (2.2 s, Windows), so
  the deletion itself works; it is the call site that is unproven.
- **The tarball-provenance guard fires only in theory.** `assertOurPackagesCameFromTarballs` reads
  `package-lock.json` and fails if one of our packages resolved to something other than the packed
  `.tgz` — the point being that `@serfab/*` 0.9.0 *is* published, so a registry fallback would look
  identical in the version report. The passing direction is exercised; the failing direction never
  fired, so it is not proven to actually catch that case.
- **`--skip-build` was used for every run.** The `yarn build` branch of the script was never
  executed, so a release run takes an unmeasured (multi-minute) build path first.
- **Windows only.** `run()` shells out on win32 because `.cmd` shims cannot be spawned otherwise;
  the POSIX branch (`shell: false`) has not been executed. Same for the `file:` path normalisation,
  which rewrites `\` to `/` for the npm spec.
- **Spec ↔ port drift is manual.** Nothing checks that
  `scripts/lib/published-smoke-scenario.mjs` still mirrors `control-database-solo.spec.ts`. Both
  files carry a comment saying to change them together; that is the whole mechanism. A reviewer may
  reasonably decide that is not enough.
- **Nesting detection is one level deep.** The nested-copy pass walks each publishable package's own
  direct dependencies. A duplicate buried below that is not reported.
- **The scratch project pins two dependency ranges by reading the in-repo manifests**, not the
  packed ones. Equivalent today, because `pack` only rewrites `workspace:` protocol ranges. If one
  of those two ever became a workspace dependency, `npm install` would fail loudly rather than
  silently mis-resolve — noisy, but not silent.
- **Failed runs leave a scratch project behind on purpose** (that is the ticket's requirement), so a
  developer who runs this repeatedly accumulates ~400-package directories under the temp dir. The
  path is printed each time.

# Review findings

Nothing parked as a tripwire during implementation.
