description: Five test files each keep their own copy of the same setup code for opening a test database and seeding rows; move it to one shared file so a fix lands once instead of five times.
files: packages/cadre-core/test/strand-spec-helpers.ts (created), packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts
difficulty: easy
----

# Hoist the duplicated strand-spec setup helpers into one module

## Resolved design

New non-`.spec.ts` module `packages/cadre-core/test/strand-spec-helpers.ts`, following the
existing convention of `control-constraint-helpers.ts` / `membership-gate-helpers.ts` /
`wake-stream-helpers.ts` in the same directory (plain modules the `test/**/*.spec.ts` vitest
glob never picks up as a suite).

It exports, verified identical (module differences noted) across the 4 files that declare
them — `strand-approval-replay.spec.ts`, `strand-member-revocation.spec.ts`,
`strand-membership-invite.spec.ts`, `strand-membership-peer-rotation.spec.ts`:

```ts
export function makeSAppConfig(overrides: Partial<SAppConfig> = {}): SAppConfig
export function freshKeyPair(): Ed25519KeyPair
export type StrandTable = 'Header' | 'Member' | 'Manager' | 'MemberPeer' | 'Invite'
  | 'ConsumedInvite' | 'CancelledInvite' | 'Revocation'   // union of all 4 files' local unions
export async function tableCount(db: Database, table: StrandTable): Promise<number>

interface ShutdownHandle { shutdown: () => Promise<void> }
export interface Strand extends ShutdownHandle {
  db: Database;
  strandId: string;
  founder: Ed25519KeyPair;   // Member #1 and the sole founding Manager
}
export interface RawStrand extends ShutdownHandle {
  db: Database;
  strandId: string;
}

export async function openStrand(type: 'o' | 'c' = 'c'): Promise<Strand>
export async function openRawStrand(): Promise<RawStrand>
export async function insertHeader(db: Database, type: 'o' | 'c'): Promise<void>
export async function rawInsertMember(db: Database, key: string): Promise<void>
export async function inTransaction(db: Database, statements: () => Promise<void>): Promise<void>
```

Module-level `opened: ShutdownHandle[]` plus a top-level `afterEach` (imported from
`'vitest'`) that drains and shuts each down travels inside this module, exactly as it does
today in each spec file — `openStrand`/`openRawStrand` push onto it. This is safe because
vitest's default `isolate: true` (nothing in `vitest.config.ts` turns it off) gives each
spec **file** its own module registry, so each file that imports
`strand-spec-helpers.ts` gets its own independent `opened` array and its own `afterEach`
registration — no cross-file leakage. Confirm this holds by running the full suite (not
just one file at a time) after wiring the import.

Two decisions from the original ticket, already settled:

1. **`openRawStrand` return type.** Give it the narrower `RawStrand` (no `founder`) instead
   of manufacturing an unused `freshKeyPair()` to satisfy `Strand`. Checked: every call site
   in both files that currently call `openRawStrand()` only destructures `{ db }` (grep
   confirmed — no caller reads `.founder` off a raw strand), so the narrower type is a pure
   cleanup, not a breaking change.
2. **Splitting `strand-membership-peer-rotation.spec.ts` (1,517 lines).** Out of scope here
   — it's an orthogonal structural change with its own risk, not a helper-dedup. Parked as
   `tickets/backlog/debt-split-strand-peer-rotation-spec.md`.

`inTransaction`'s per-file `debug('sereus:cadre:test:strand-<x>')` logger namespaces
collapse into one shared `debug('sereus:cadre:test:strand-spec-helpers')` inside the hoisted
function — the log line is a diagnostic-only "rollback after an already-failed commit was a
no-op", not a namespace anything depends on, so losing the per-file prefix is an acceptable
trade for not threading a logger through every call site.

### `strand-membership-writer.spec.ts` is intentionally NOT fully folded in

It shares `makeSAppConfig` and (via `tableCount`, replacing its local `count`) the count
helper, but keeps its own local `OpenStrand` interface and `openStrandDb()`. Those exist to
test `bootstrapFounderMembership` itself: `openStrandDb()` deliberately does **not** run the
founder bootstrap (that's the function under test), exposes `storage` so a test can reopen
the same persisted strand in a second `Database` (the warm-restart tests), and its teardown
is a single `let open: OpenStrand | null` reset per test rather than an array — a materially
different lifecycle from the other four files' `openStrand`/`openRawStrand`, not a
near-verbatim copy. Forcing it into `Strand`/`RawStrand` would either lose the `storage`
field the reopen tests need or bloat the shared interface for one caller. Leave it local.

## Progress so far (this run is the third on this ticket — wiring is now COMPLETE)

`packages/cadre-core/test/strand-spec-helpers.ts` was created in an earlier run and matches
the resolved design exactly. Re-verified again this run — no changes needed.

**All 5 spec files are now wired** to import from it, local duplicates deleted:

- `strand-approval-replay.spec.ts` — wired in an earlier run. This run additionally fixed a
  lint error surfaced by `yarn lint`: `import { Database } from '@quereus/quereus';` had to
  become `import type { Database } from '@quereus/quereus';`. Once the local `openStrand`
  (which called `new Database()`) moved into the shared module, this file only ever uses
  `Database` as a type annotation, tripping
  `@typescript-eslint/consistent-type-imports`.
- `strand-member-revocation.spec.ts` — wired in an earlier run. Same `import type { Database }`
  fix applied this run.
- `strand-membership-invite.spec.ts` — wired in an earlier run. **Not re-checked this run**
  for the same `Database`-import-type lint issue the other 3 files had — it also lost its
  local `openStrand`/`new Database()` call to the shared module, so it almost certainly has
  the identical problem. **Check this first in the next run** (see Remaining TODO).
- `strand-membership-peer-rotation.spec.ts` — wired THIS run. Imported `freshKeyPair`,
  `tableCount`, `openStrand`, `openRawStrand`, `insertHeader`, `rawInsertMember`,
  `inTransaction` from `./strand-spec-helpers.js`. Deleted local `makeSAppConfig`,
  `freshKeyPair`, `StrandTable`, `tableCount`, `Strand` interface, `opened`, `openStrand`,
  `openRawStrand`, the local `afterEach` block, the `debug` import + `log` var, and a
  duplicate `inTransaction` definition that existed a SECOND time later in the file (near
  `addExtraManagers`/`seatMembers`, not just the copy near the top) — both copies removed.
  Also removed `afterEach` from the `vitest` import (no longer used) and switched
  `import { Database }` to `import type { Database }` (same lint fix as the other 3 files).
  Kept local-only: `rawInsertFoundingManager`, `managerStamp`, `memberPeerStamp`,
  `fileTombstone`, `addExtraManagers`, `seatMembers`, `insertManagerRow`,
  `managerGeneration`. Verified via grep that the file's one `openRawStrand()` call site
  (inside "the founding Manager still needs its Member row first") only destructures
  `{ db }` — the narrower `RawStrand` return type is safe. Grepped afterward for the deleted
  `Strand` interface name, `debug`, `log(`, and a second `inTransaction` declaration — all
  clean.
- `strand-membership-writer.spec.ts` — wired THIS run (the smaller edit). Replaced
  `import type { SAppConfig } from '../src/types.js';` with
  `import { makeSAppConfig, tableCount } from './strand-spec-helpers.js';`, deleted the local
  `count()` and `makeSAppConfig()` functions. Left `OpenStrand`/`openStrandDb()` untouched
  (per "intentionally NOT fully folded in" above) — it still calls `new Database()` itself,
  so its own `Database` import correctly stays a value import; no lint fix needed there.
  Renamed call sites `count(db, ...)` → `tableCount(db, ...)`: a first pass via `sed 's/count(db,/tableCount(db,/g'`
  missed two call sites that used a different receiver, `count(cold.db, ...)` (inside the
  "hydrates a grown strand" test), caught by a follow-up TypeScript diagnostic and fixed by
  hand. Re-grepped for bare `\bcount\(` afterward — clean; only `tableCount(` calls and one
  prose doc-comment (`` `count(Member) <= 1` ``, describing a SQL CHECK expression, not code)
  remain.

## Remaining TODO

- **Check `strand-membership-invite.spec.ts`'s `Database` import.** Grep the file for
  `new Database(` — if it doesn't appear (expected, since its local `openStrand` moved to the
  shared module), switch `import { Database } from '@quereus/quereus';` to
  `import type { Database } from '@quereus/quereus';`, matching the fix already applied to
  the other 3 wired-in-earlier-runs-but-not-writer files.
- **Run `yarn lint packages/cadre-core/test` from the repo root and get it fully clean.**
  (`yarn lint <path>` is the form that works from the repo root; there is no per-package
  `lint` script — `yarn workspace @serfab/cadre-core lint` fails with "Couldn't find a script
  named lint", confirmed this run.) Lint has only been run ONCE across this ticket's full
  history so far, before the `strand-membership-writer.spec.ts` edits and before checking
  `strand-membership-invite.spec.ts`. That one run found 3 errors (all the `Database`
  type-import issue above), which got fixed for 3 of the (likely) 4 affected files — but the
  lint command has never been re-run since to confirm zero errors remain.
- **Run the full test suite: `cd packages/cadre-core && yarn test` (or
  `yarn workspace @serfab/cadre-core test`).** This has NOT been run at all, in this run or
  either of the two prior runs, across this ticket's entire history. This is the single
  biggest unverified risk — none of the 5 wired files have been confirmed to actually pass
  since edits started. Run the FULL package suite, not per-file, both for correctness and to
  confirm vitest's per-file module isolation holds for the shared `opened`/`afterEach` state
  (see "Edge cases" below).
- If lint or tests surface issues in `strand-approval-replay.spec.ts`,
  `strand-member-revocation.spec.ts`, or `strand-membership-invite.spec.ts` (the 3 files
  wired in earlier runs, not touched for logic this run), fix them in place — don't assume
  problems are confined to the 2 files edited this run.
- Once lint AND the full test suite are both clean: write the review/ handoff summary
  (distilled ticket description, use cases for testing/validation, and any known gaps — see
  the Implement stage instructions) and delete this ticket file.

## Edge cases & interactions

- **Module isolation.** The shared `opened` array + `afterEach` only behaves per-file if
  vitest module isolation is on (it is, by default, and nothing in this package's
  `vitest.config.ts` disables it) — run the FULL package suite, not one spec file at a time,
  to confirm no strand leaks/double-shutdowns across files sharing the import. **Still
  unverified — no test run has happened yet in this ticket's history.**
- **`openStrand` default param.** `strand-approval-replay.spec.ts` calls `openStrand()` with
  no argument today (always type `'c'`); the shared signature defaults `type` to `'c'` so
  that call site is unchanged once wired. The other files always pass `type` explicitly.
- **`openRawStrand`'s narrowed return type.** Verified for `strand-member-revocation.spec.ts`
  and `strand-membership-peer-rotation.spec.ts` (the only two files with `openRawStrand` call
  sites) — neither destructures `.founder`. Confirmed safe.
- **Rollback-after-failed-commit ordering in `inTransaction`.** Preserved intact in the
  shared module; the deleted per-file copies were diffed against it during wiring in all 4
  files that had it.
- **Doc-comment loss.** Not yet double-checked by a second reviewer pass — the shared
  module's JSDoc was written to fold in the per-file rationale, but nobody has diffed every
  deleted local function against it end-to-end.
- **`@typescript-eslint/consistent-type-imports` on `Database`.** New finding this run, not
  anticipated in the original design: once a file's only local user of `new Database()` moves
  into the shared helpers module, that file's own `import { Database } from
  '@quereus/quereus'` becomes type-only and lint demands `import type`. Confirmed needed in 3
  files (`strand-approval-replay.spec.ts`, `strand-member-revocation.spec.ts`,
  `strand-membership-peer-rotation.spec.ts`) and very likely needed in a 4th
  (`strand-membership-invite.spec.ts`, unchecked — see Remaining TODO).
  `strand-membership-writer.spec.ts` is NOT affected — its local `openStrandDb()` still calls
  `new Database()` directly.

<!-- resume-note -->
This run (third on this ticket) hit BUDGET_WARNING partway through verification. Both
previously-unwired spec files (`strand-membership-peer-rotation.spec.ts` and
`strand-membership-writer.spec.ts`) are now fully wired to `strand-spec-helpers.ts`, so **all
5 target files have their helper-import work done**. What's left is verification, not
wiring:

1. Grep `strand-membership-invite.spec.ts` for `new Database(` — if absent, change its
   `Database` import to `import type { Database }` (same fix already applied to the other 3
   files this run).
2. Run `yarn lint packages/cadre-core/test` from the repo root — fix anything it flags.
3. Run `cd packages/cadre-core && yarn test` (full suite, not per-file) — fix anything it
   flags. Pay particular attention to `strand-membership-peer-rotation.spec.ts` (the largest
   file, most extensive edit this run — deleted a duplicate `inTransaction` definition that
   existed a second time later in the file, not just the copy near the top) and
   `strand-membership-writer.spec.ts` (renamed `count(...)` call sites to `tableCount(...)`;
   already double-checked no bare `count(` calls remain via grep, but not test-verified).
4. Only once lint AND the full test suite are both clean, write the review/ handoff summary
   and delete this ticket.

No test command has been run successfully to completion in this ticket's history yet — that
is the main gap for whoever picks this up next.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
