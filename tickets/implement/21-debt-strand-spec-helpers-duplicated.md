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

## Progress so far (this run)

`packages/cadre-core/test/strand-spec-helpers.ts` has been **created** with all the exports
listed above, matching the resolved design exactly:

- `makeSAppConfig`, `freshKeyPair`, `StrandTable` (8-member union), `tableCount` — done.
- `ShutdownHandle` (internal), `Strand`, `RawStrand` — done.
- Module-level `opened: ShutdownHandle[]` + `afterEach` import from `vitest` — done.
- `openStrand(type: 'o' | 'c' = 'c')` — done, matches the resolved signature (default `'c'`
  so `strand-approval-replay.spec.ts`'s no-arg call sites keep working once wired).
- `openRawStrand()` returning the narrower `RawStrand` (no `founder` field) — done.
- `insertHeader`, `rawInsertMember` (imports `generateStrandStampId` from
  `../src/strand-membership-writer.js`), `inTransaction` (with the rollback-after-failed-
  commit try/catch preserved intact) — done.
- JSDoc comments folded onto each export per the TODO below (the "why" notes from each
  original file's per-function doc comment) — done in the new module.

**No spec file has been touched yet.** All 5 files still have their own local copies of
these helpers; `strand-spec-helpers.ts` exists standalone and nothing imports it yet.
`yarn lint` / `yarn test` have NOT been run this session — do both only after finishing the
spec-file edits below, since the new module alone will show as an unused file until wired in.

## Remaining TODO

- Update `strand-approval-replay.spec.ts`, `strand-member-revocation.spec.ts`,
  `strand-membership-invite.spec.ts`, `strand-membership-peer-rotation.spec.ts`: delete the
  local `makeSAppConfig`, `freshKeyPair`, `StrandTable`, `tableCount`, `Strand`, `opened`,
  `afterEach` teardown, `openStrand`, `openRawStrand` (where present — only in
  `strand-member-revocation.spec.ts` and `strand-membership-peer-rotation.spec.ts`),
  `insertHeader` (where present — same two files), `rawInsertMember` (where present — same
  two files), `inTransaction` (where present — all 4 files); import the shared versions
  instead from `./strand-spec-helpers.js`. Keep whatever each file does NOT share
  (`strand-member-revocation.spec.ts`'s `isMemberRow`/`fileTombstone`/`rawDeleteMember`/
  `memberStampId`; `strand-membership-peer-rotation.spec.ts`'s `rawInsertFoundingManager`,
  `managerStamp`, `memberPeerStamp`, `fileTombstone`, `addExtraManagers`, `seatMembers`,
  `insertManagerRow`, `managerGeneration`; `strand-approval-replay.spec.ts`'s
  `memberStamp`/`managerRow`/`memberPeerStamp`/`isMember`/`isManager`/`fileTombstone`/
  `seatMember`; `strand-membership-invite.spec.ts` has no other locals to keep beyond what's
  already noted).
- Update `strand-membership-writer.spec.ts`: delete its local `makeSAppConfig` (line ~118)
  and `count` (line ~111), import shared `makeSAppConfig` and `tableCount` from
  `./strand-spec-helpers.js`, rename call sites `count(db, ...)` -> `tableCount(db, ...)`.
  Leave `OpenStrand`/`openStrandDb` as-is (see rationale above) — do NOT touch those.
- Remove now-unused imports each spec file picks up as a side effect of deleting its local
  helpers (`randomUUID`, `MemoryRawStorage`, `connectToStrand`, `generatePrivateKey`,
  `getPublicKey`, `generateStrandMemberKey`, `strandMemberKeyPair`,
  `bootstrapFounderMembership`, `generateStrandStampId`, `debug`, and vitest's `afterEach` —
  only where the file no longer references them directly after the edit).
- `yarn lint` clean (catches unused imports/vars) and `yarn workspace @serfab/cadre-core test`
  (or `cd packages/cadre-core && yarn test`) green, all 5 specs' assertions unchanged. Per
  the "Edge cases" section below, run the FULL package suite (not per-file) at least once.

## Edge cases & interactions

- **Module isolation.** The shared `opened` array + `afterEach` only behaves per-file if
  vitest module isolation is on (it is, by default, and nothing in this package's
  `vitest.config.ts` disables it) — run the FULL package suite, not one spec file at a time,
  to confirm no strand leaks/double-shutdowns across files sharing the import.
- **`openStrand` default param.** `strand-approval-replay.spec.ts` calls `openStrand()` with
  no argument today (always type `'c'`); the shared signature (already implemented) defaults
  `type` to `'c'` so that call site is unchanged once wired. The other three files always
  pass `type` explicitly — confirm none accidentally start relying on the default where they
  meant to pass `'o'`.
- **`openRawStrand`'s narrowed return type.** Re-verify (don't just trust this ticket) that
  no call site anywhere destructures `.founder` from an `openRawStrand()`/`RawStrand` result
  before wiring the shared version in.
- **Rollback-after-failed-commit ordering in `inTransaction`.** Already preserved intact in
  the new shared module — double check the deleted per-file copies aren't relied upon for
  anything subtly different before removing them (a diff review of each deletion against the
  new shared source is the fastest way to confirm).
- **Doc-comment loss.** Reviewer should diff each deleted local function against the shared
  one (already written with folded-in JSDoc) and confirm no explanatory rationale (the "why",
  not the "what") got silently dropped.

<!-- resume-note -->
Prior run hit BUDGET_WARNING immediately after creating
`packages/cadre-core/test/strand-spec-helpers.ts` and fixing a stray unused-import lint issue
in it — zero spec files have been edited yet. The new helper module is believed complete and
correct against the resolved design (re-verify against the exports list above before wiring
it in, but it should not need redesign). Re-read all 5 spec files in full if needed — the
following, gathered by an even earlier interrupted run and re-confirmed this run, saves
re-discovery time:

- **`openRawStrand`** present only in `strand-member-revocation.spec.ts` (~L117-133) and
  `strand-membership-peer-rotation.spec.ts` (~L109-125). Absent from
  `strand-approval-replay.spec.ts` and `strand-membership-invite.spec.ts`.
- **`insertHeader`** present only in the same two files (member-revocation ~L147-154,
  peer-rotation ~L132-139) — bodies + doc comments identical.
- **`rawInsertMember`** present only in the same two files (member-revocation ~L221-228,
  peer-rotation ~L142-149) — identical.
- **`inTransaction`** present in all 4 files (approval-replay ~L141-156, member-revocation
  ~L231-246, invite ~L78-93, peer-rotation ~L690-705) — identical bodies including the
  rollback-after-failed-commit try/catch. Only the `debug(...)` namespace argument differs
  per file (`strand-approval-replay`, `strand-revocation`, `strand-invite`, `strand-rotation`)
  — already collapsed to one shared `sereus:cadre:test:strand-spec-helpers` namespace in the
  new module.
- **`fileTombstone` is OUT of scope** — absent from the shared module's export list, so leave
  all copies local and untouched. Exists in 3 of the 4 files with a signature mismatch:
  `strand-approval-replay.spec.ts` (~L196-209) and `strand-membership-peer-rotation.spec.ts`
  (~L192-205) both use `fileTombstone(db, tableName, stampId, retiree)`;
  `strand-member-revocation.spec.ts` (~L174-187) instead uses
  `fileTombstone(db, stampId, retiree, tableName = 'Member')` (args reordered, `tableName` a
  plain string with a default, not the 3-name union). `strand-membership-invite.spec.ts` has
  no `fileTombstone` at all. Do not unify these three.
- **`openStrand` signature.** `strand-approval-replay.spec.ts`'s local version takes NO
  `type` param (hardcoded `'c'`, always passes `founderKeyPair: founder`). The other three
  take `type: 'o' | 'c'` and pass `founderKeyPair: type === 'c' ? founder : undefined`. The
  shared signature `openStrand(type: 'o' | 'c' = 'c')` (already implemented) is compatible
  with approval-replay's no-arg call sites via the default.
- **`StrandTable` per-file unions verified** exactly as this ticket states: approval-replay =
  `Member|MemberPeer|Manager|Revocation`; member-revocation =
  `Header|Member|Manager|ConsumedInvite|CancelledInvite|Revocation`; invite =
  `Header|Invite|ConsumedInvite|CancelledInvite|Member|Manager`; peer-rotation =
  `Header|Member|MemberPeer|Manager`. The union of all four matches the shared module's
  `StrandTable` type exactly (already implemented) — no correction needed.
- `strand-membership-writer.spec.ts`: local `makeSAppConfig` (~L118-126), local `count()`
  (~L111-116), local `OpenStrand` interface (~L82-87) + `openStrandDb()` (~L94-109) all
  confirmed as described in the "intentionally NOT fully folded in" section — leave
  `OpenStrand`/`openStrandDb` local, just swap `makeSAppConfig`/`count` for the shared
  `makeSAppConfig`/`tableCount` and rename call sites.
- `strand-membership-peer-rotation.spec.ts` is 1,518 lines; only grepped its top-level
  function/interface/type declarations for the back half (confirmed no NEW helper
  definitions past line ~730 — rest is test bodies using the helpers already catalogued
  above, plus `addExtraManagers`/`seatMembers`/`insertManagerRow`/`managerGeneration` which
  are local-only and stay put), not a full line-by-line read of every test body.

Next agent should proceed straight to wiring: for each of the 4 files, replace the local
helper block with an import from `./strand-spec-helpers.js` (verify the relative path — the
new file lives beside them at `packages/cadre-core/test/strand-spec-helpers.ts`), delete the
now-redundant local definitions, delete now-unused imports, then do the smaller
`strand-membership-writer.spec.ts` edit, then run `yarn lint` and
`yarn workspace @serfab/cadre-core test` (full suite), then hand off to `review/`.
