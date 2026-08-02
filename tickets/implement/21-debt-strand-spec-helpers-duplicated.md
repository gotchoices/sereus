description: Five test files each keep their own copy of the same setup code for opening a test database and seeding rows; move it to one shared file so a fix lands once instead of five times.
files: packages/cadre-core/test/strand-spec-helpers.ts (new), packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/cadre-core/test/strand-membership-invite.spec.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts
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

Two decisions from the original ticket, now settled:

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

## TODO

- Create `packages/cadre-core/test/strand-spec-helpers.ts` with the exports above. Fold each
  file's per-function doc comment into one JSDoc per export on the shared version rather than
  dropping the explanatory text (e.g. `inTransaction`'s "a failed commit already tore the
  transaction down" note, `insertHeader`'s "every Header column is NOT NULL" note,
  `openRawStrand`'s "used by tests that need no manager at all" note).
- Update `strand-approval-replay.spec.ts`, `strand-member-revocation.spec.ts`,
  `strand-membership-invite.spec.ts`, `strand-membership-peer-rotation.spec.ts`: delete the
  local `makeSAppConfig`, `freshKeyPair`, `StrandTable`, `tableCount`, `Strand`, `opened`,
  `afterEach` teardown, `openStrand`, `openRawStrand` (where present), `insertHeader` (where
  present), `rawInsertMember` (where present), `inTransaction` (where present); import the
  shared versions instead. Keep whatever each file does NOT share
  (`strand-member-revocation.spec.ts`'s `isMemberRow`/`fileTombstone`/`rawDeleteMember`/
  `memberStampId`; `strand-membership-peer-rotation.spec.ts`'s `rawInsertFoundingManager`).
- Update `strand-membership-writer.spec.ts`: delete its local `makeSAppConfig` and `count`,
  import shared `makeSAppConfig` and `tableCount`, rename call sites `count(db, ...)` ->
  `tableCount(db, ...)`. Leave `OpenStrand`/`openStrandDb` as-is (see rationale above).
- Remove now-unused imports each file picks up as a side effect (`randomUUID`,
  `MemoryRawStorage`, `connectToStrand`, `generatePrivateKey`, `getPublicKey`,
  `generateStrandMemberKey`, `strandMemberKeyPair`, `bootstrapFounderMembership`,
  `generateStrandStampId`, `debug` — only where the file no longer references them directly).
- `yarn lint` clean (catches unused imports/vars) and `yarn workspace @serfab/cadre-core test`
  (or `cd packages/cadre-core && yarn test`) green, all 5 specs' assertions unchanged.

## Edge cases & interactions

- **Module isolation.** The shared `opened` array + `afterEach` only behaves per-file if
  vitest module isolation is on (it is, by default, and nothing in this package's
  `vitest.config.ts` disables it) — run the FULL package suite, not one spec file at a time,
  to confirm no strand leaks/double-shutdowns across files sharing the import.
- **`openStrand` default param.** `strand-approval-replay.spec.ts` calls `openStrand()` with
  no argument today (always type `'c'`); the shared signature defaults `type` to `'c'` so
  that call site is unchanged. The other three files always pass `type` explicitly — confirm
  none accidentally start relying on the default where they meant to pass `'o'`.
- **`openRawStrand`'s narrowed return type.** Re-verify (don't just trust this ticket) that
  no call site anywhere destructures `.founder` from an `openRawStrand()`/`RawStrand` result
  before deleting the placeholder `freshKeyPair()` founder field.
- **Rollback-after-failed-commit ordering in `inTransaction`.** The try/catch around
  `db.rollback()` inside the catch block must stay: a failed `commit()` has already torn the
  transaction down, so the follow-up `rollback()` throws "no transaction active", and that
  secondary error must be logged, not allowed to replace/mask the original `error` being
  rethrown. Preserve this exactly when hoisting.
- **Doc-comment loss.** Reviewer should diff each deleted local function against the shared
  one and confirm no explanatory rationale (the "why", not the "what") got silently dropped.
