description: Five test files each kept their own copy of the same setup code for opening a test database and seeding rows; that duplication is now gone, replaced by one shared file.
files: packages/cadre-core/test/strand-spec-helpers.ts (new), packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts
difficulty: easy
----

# Hoist the duplicated strand-spec setup helpers into one module

## What landed

New module `packages/cadre-core/test/strand-spec-helpers.ts` — not itself a test file (the
`test/**/*.spec.ts` vitest glob never picks it up), following the same convention as the
pre-existing `control-constraint-helpers.ts` / `membership-gate-helpers.ts` /
`wake-stream-helpers.ts` siblings. Exports `makeSAppConfig`, `freshKeyPair`, `StrandTable`,
`tableCount`, the `Strand` / `RawStrand` interfaces, `openStrand`, `openRawStrand`,
`insertHeader`, `rawInsertMember`, `inTransaction`, plus a module-level `opened` array
drained by a file-level `afterEach`.

Four files fully converted, local duplicate helpers deleted, now importing from
`./strand-spec-helpers.js`: `strand-approval-replay.spec.ts`,
`strand-member-revocation.spec.ts`, `strand-membership-invite.spec.ts`,
`strand-membership-peer-rotation.spec.ts` (which also carried a second, later-in-file
duplicate `inTransaction`, deleted with the first).

`strand-membership-writer.spec.ts` converted partially, on purpose: it shares
`makeSAppConfig` and `tableCount` (its local `count()` renamed at every call site) but keeps
its own `OpenStrand` / `openStrandDb()`, because those deliberately skip founder bootstrap to
test `bootstrapFounderMembership` itself and expose a `storage` handle for warm-restart
re-open tests — a materially different lifecycle, not a near-copy worth forcing into the
shared shape.

Lint side effect handled: once a file's only remaining use of `Database` is a type
annotation, `@typescript-eslint/consistent-type-imports` requires `import type`. Applied in
the three files that needed it; `strand-membership-writer.spec.ts` still constructs a
`Database`, so its value import correctly stays.

Out of scope, parked during planning:
`tickets/backlog/debt-split-strand-peer-rotation-spec.md` (splitting the 1,517-line
peer-rotation file).

## Review findings

### Checked

- Read the implement diff (`git diff e6f284f..783c3ff`) before the handoff summary.
- Every deleted local helper compared against its hoisted counterpart, function by function.
  All behaviour-preserving. Two intentional widenings, both verified safe:
  `StrandTable` is now the union of all five files' local unions (each file only ever passes
  its own members), and `openStrand`'s `type` gained a `'c'` default so
  `strand-approval-replay.spec.ts` — the one caller that passed nothing after conversion —
  still opens a closed strand with the founder seated.
- `openRawStrand`'s narrowed `RawStrand` return type (no `founder`): all four call sites
  across the two files that use it destructure `{ db }` only.
- `count(` → `tableCount(` rename in `strand-membership-writer.spec.ts`: no stray bare
  `count(` calls remain.
- Searched for spec files that should also have been converted but weren't. The only other
  `test/` file mentioning `connectToStrand` is `digest-variadic-parity.spec.ts`, which
  deliberately uses a bare `Database` with only the crypto plugin and no strand at all —
  correctly left alone. No remaining duplicate `makeSAppConfig` anywhere in the repo.
- Docs: grepped `docs/` for all five test-helper module names. Nothing under `docs/` indexes
  test-helper files, so there was no doc to bring in line — no doc change needed, not an
  omission.
- `yarn lint packages/cadre-core/test` — exit 0.
- `yarn typecheck` in `packages/cadre-core` — exit 0.
- Full package suite `yarn test` — 83/85 files, 1370/1376 tests pass, 1 skipped. All five
  touched files pass. Re-ran the five files after the review edits: 5 files / 138 tests pass.

### Fixed in this pass (minor)

- **`openStrand` and `openRawStrand` were themselves near-copies** — same
  `connectToStrand` + shutdown-closure + `opened.push` body, differing only by the bootstrap
  call. A dedup ticket that leaves a fresh duplicate behind is not done. `openStrand` now
  calls `openRawStrand` and returns `{ ...raw, founder }`; the spread shares the same
  `shutdown` closure the `opened` list already holds, so teardown still runs exactly once.
  Incidental improvement: the strand is registered for teardown *before* the bootstrap runs,
  so a bootstrap that throws no longer leaks a live libp2p node and open `Database`.
- **`Strand` and `RawStrand` each re-declared `db` and `strandId`.** `Strand` now extends
  `RawStrand`.
- **`Strand.founder`'s doc-comment was wrong for open strands.** It claimed the key is
  "Member #1 and the sole founding Manager", but `openStrand('o')` passes
  `founderKeyPair: undefined` and seats no member — the returned key has no rows behind it.
  Doc corrected. No caller reads `.founder` off an `'o'` strand today (checked), so this was
  a trap for the next author, not a live bug.
- **The module's import side effect was undocumented.** Importing it registers a file-level
  `afterEach`; `strand-membership-writer.spec.ts` imports only the two pure helpers and still
  inherits a (harmless, no-op) teardown hook. Stated in the module header.

### Filed as tickets (major)

None. Every finding was a same-file doc or structure fix inside the module this ticket
created, so all were resolved inline rather than deferred.

### Tripwires (conditional — parked, not ticketed)

- The shared `opened` array is per-spec-file only because vitest's default `isolate: true`
  gives each file its own module registry. Under `isolate: false` the files sharing a worker
  would share the array and one file's `afterEach` would tear down another's strands
  mid-run. Fine as configured; parked as a `NOTE:` comment at the `opened` declaration in
  `strand-spec-helpers.ts`.

### Known gaps carried from implement, now closed

- "No second reader diffed the deleted doc-comments against the hoisted versions" — done
  this pass (see Checked above); one real inaccuracy found and fixed (`founder` on open
  strands).
- The per-file `debug('sereus:cadre:test:strand-<x>')` namespaces collapsing into one shared
  `sereus:cadre:test:strand-spec-helpers` stands as accepted. It is a diagnostic-only line
  on an already-failed rollback; nothing reads it programmatically. Not worth threading a
  namespace parameter through every call site.

### Pre-existing failures (not this ticket)

The 2 failing files (`control-revocation-reissue.spec.ts`, `control-revocation-replay.spec.ts`,
5 tests) are already listed in `tickets/.pre-existing-known.md` against blocked ticket
`10-revocation-reissue-same-pk-update-unique-collision`, with the same two fingerprints
(`UNIQUE constraint failed: Revocation.TableName, Revocation.StampId` and
`context.OwnerKey isn't a column`). Not re-reported. This ticket's diff touches no control
or revocation code. The `.pre-existing-error.md` the implement stage wrote was already
consumed by the runner's triage commit `31fff82`.

## End
