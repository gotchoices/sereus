description: Five test files each kept their own copy of the same setup code for opening a test database and seeding rows; that duplication is now gone, replaced by one shared file.
files: packages/cadre-core/test/strand-spec-helpers.ts (new), packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts
difficulty: easy
----

# Hoist the duplicated strand-spec setup helpers into one module

## What landed

New module `packages/cadre-core/test/strand-spec-helpers.ts` (not itself a test file — the
`test/**/*.spec.ts` vitest glob never picks it up), following the same convention as the
pre-existing `control-constraint-helpers.ts` / `membership-gate-helpers.ts` /
`wake-stream-helpers.ts` siblings. Exports: `makeSAppConfig`, `freshKeyPair`, `StrandTable`
(union type), `tableCount`, the `Strand` / `RawStrand` interfaces, `openStrand`,
`openRawStrand`, `insertHeader`, `rawInsertMember`, `inTransaction`, plus a module-level
`opened: ShutdownHandle[]` array drained by a top-level `afterEach`.

Four files fully converted, local duplicate helpers deleted, now import from
`./strand-spec-helpers.js`:

- `strand-approval-replay.spec.ts`
- `strand-member-revocation.spec.ts`
- `strand-membership-invite.spec.ts`
- `strand-membership-peer-rotation.spec.ts` (the big one — 1,517 lines; also had a second,
  later-in-file duplicate `inTransaction` definition that got deleted along with the one
  near the top)

`strand-membership-writer.spec.ts` converted partially, on purpose: it shares
`makeSAppConfig` and `tableCount` (its local `count()` was renamed at every call site,
including two call sites on a `cold.db` receiver that a first-pass `sed` missed and had to
be fixed by hand) but keeps its own local `OpenStrand`/`openStrandDb()`, because those
deliberately skip founder bootstrap to test `bootstrapFounderMembership` itself and expose a
`storage` handle for warm-restart re-open tests — a materially different lifecycle from the
other four files' `openStrand`, not a near-copy worth forcing into the shared shape.

Side effect surfaced by lint, not anticipated in the original design: once a file's only
remaining use of `Database` from `@quereus/quereus` is a type annotation (its one
`new Database()` call moved into the shared module), `@typescript-eslint/consistent-type-imports`
requires `import type { Database }` instead of `import { Database }`. Fixed in
`strand-approval-replay.spec.ts`, `strand-member-revocation.spec.ts`, and
`strand-membership-peer-rotation.spec.ts`. `strand-membership-invite.spec.ts` never imported
`Database` at all (checked — no match), so nothing to fix there.
`strand-membership-writer.spec.ts` still constructs `Database` itself in `openStrandDb()`, so
its import correctly stays a value import.

Out of scope, parked as its own backlog ticket during planning:
`tickets/backlog/debt-split-strand-peer-rotation-spec.md` (splitting the 1,517-line
peer-rotation file — an orthogonal structural change, not a helper-dedup).

## Use cases for testing / validation

- **Cross-file isolation of the shared `opened`/`afterEach` state.** The whole design rests
  on vitest's default `isolate: true` giving each spec *file* its own module registry, so
  four files importing the same `strand-spec-helpers.ts` each get an independent `opened`
  array with no cross-file leakage. This can only be checked by running the **full** package
  suite, never a single file in isolation — done this run, see Validation below.
- **`openRawStrand`'s narrowed `RawStrand` return type** (no `founder` field, unlike
  `Strand`). Verified by grep that every call site across the two files that use it
  (`strand-member-revocation.spec.ts`, `strand-membership-peer-rotation.spec.ts`) only
  destructures `{ db }`.
- **`tableCount` rename correctness in `strand-membership-writer.spec.ts`.** Watch for any
  stray bare `count(...)` call left over from the rename — a repo-wide grep for `\bcount\(`
  in that file this run found none (only `tableCount(` calls and one unrelated prose
  doc-comment mentioning `count(Member) <= 1` as a SQL CHECK expression).
- **`openStrand()`'s default `type` param** (`'c'`). `strand-approval-replay.spec.ts` relies
  on the default (calls `openStrand()` with no args); every other file passes `type`
  explicitly — worth eyeballing if that file's tests ever start opening the wrong strand
  type.

## Known gaps

- The shared module's JSDoc was written to fold in each deleted local function's rationale,
  but no line-by-line diff of every deleted local function's doc-comment against the
  hoisted version has been done by a second reader — worth a skim during review.
- `inTransaction`'s per-file `debug('sereus:cadre:test:strand-<x>')` logger namespaces were
  collapsed into one shared `debug('sereus:cadre:test:strand-spec-helpers')`. This is a
  diagnostic-only log line (rollback-after-already-failed-commit no-op), not something
  anything depends on programmatically, but it does mean a future debug session can no
  longer tell which spec file emitted a given `inTransaction` log line by namespace alone.

## Validation

- `yarn lint packages/cadre-core/test` (run from repo root) — clean, exit 0.
- `cd packages/cadre-core && yarn test` (full package suite, not per-file) — **83/85 test
  files pass, 1370/1376 tests pass, 1 skipped.** All 5 files this ticket touched are among
  the 83 passing files.
  - The 2 failing files (`control-revocation-reissue.spec.ts`,
    `control-revocation-replay.spec.ts`, 5 failing tests total) are unrelated to this
    ticket's diff — confirmed via `git diff e6f284f..HEAD --stat` (e6f284f = this ticket's
    plan commit) that this ticket never touches those files or the revocation-reissue
    subsystem they exercise. Filed as `tickets/.pre-existing-error.md` per the pre-existing-
    failure protocol rather than chased here.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
