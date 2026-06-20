description: Verify that the file-backed key store now writes durably — a crash mid-save can no longer leave a half-written, unloadable identity file.
files: packages/cadre-core/src/key-store-file.ts, packages/cadre-core/test/key-store.spec.ts
----

## What changed

`FileKeyStore.set` (`packages/cadre-core/src/key-store-file.ts`) no longer writes
the slot in place. It now writes crash-atomically:

1. `mkdir` the slot dir (unchanged, `0o700` best-effort).
2. Open a sibling temp file `<encoded keyId>.<6-byte-hex>.tmp` with flag `'wx'`
   (exclusive create) and mode `0o600`.
3. `writeFile(material)` then `handle.sync()` (fsync) — bytes land on disk
   *before* they are exposed.
4. `rename(tmp, slot)` — atomic replace. A reader sees either the complete old
   bytes or the complete new bytes, never a torn slot.
5. Best-effort `syncDir()` (fsync the directory) so the rename survives power loss
   on POSIX.

On **any** failure after the temp file is created (write, sync, or rename), the
temp file is `rm`'d (`force:true`, swallowed) and the error rethrown — leaving no
`.tmp` debris and the previous slot byte-for-byte intact.

New private helpers: `tempPath`, `writeSlotAtomically`, `syncDir`. New constant
`TEMP_SUFFIX = '.tmp'`. Imports gained `rename`, `open`, `FileHandle` (from
`node:fs/promises`) and `randomBytes` (`node:crypto`); `writeFile` dropped.
`get`/`delete`/`list`/encoding are untouched. `KeyStore` interface and
`InMemoryKeyStore` are untouched (per the ticket's non-goals).

## Decisions made (ticket asked for these to be decided + documented)

- **Durability bar = rename-atomicity + fsync.** The file is fsync'd before the
  rename (cheap, portable, prevents exposing bytes that never hit the platter).
  The directory fsync is **best-effort**: opening a directory for fsync is not
  portable (unsupported on Windows and some FSes), so `syncDir` logs+swallows any
  failure. Rename atomicity does not depend on it. Rationale is in the
  `writeSlotAtomically` / `syncDir` doc comments.
- **Cross-platform rename.** POSIX `rename(2)` replaces atomically; Node maps to
  `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` on Windows (also atomic) but can fail
  `EPERM`/`EBUSY` if another process holds the dest open. That cross-process case
  is out of scope (in-process identity path is single-flight); such a failure
  surfaces to the caller with the old slot intact.
- **`list()` already excludes temp files** — it matches only `.key`, and temp
  files end `.tmp`. No filter change was needed; a regression test pins this.
- **Permissions.** The renamed temp (created fresh at `0o600`) becomes the slot,
  so the final slot is always `0o600` — including on overwrite, which the old
  in-place `writeFile(mode)` did **not** re-apply.

## How to validate

```
cd packages/cadre-core
yarn vitest run test/key-store.spec.ts   # 21 passed, 1 skipped (posix-only perm test)
```

The shared `KeyStore` contract suite (`describe.each`) runs against both
`InMemoryKeyStore` and `FileKeyStore` and must stay green (round-trip, overwrite,
buffer isolation, delete idempotency, list accuracy, awkward keyIds).

New `FileKeyStore`-specific tests added:
- leaves no `.tmp` debris after a successful set;
- `list()` ignores a stray non-`.key` file (crash-orphaned `.tmp`);
- a mid-write failure (mocked `rename` rejection) preserves the previous slot
  bytes (loadable) and leaves no `.tmp` debris;
- final slot keeps `0o600` even on overwrite (`it.skipIf` Windows).

The failure test uses `vi.mock('node:fs/promises', …)` spreading the real module
and replacing only `rename` with a spy; `mockRejectedValueOnce` is one-shot so the
contract suite (which calls through) is unaffected.

## Known gaps / reviewer attention

- **Pre-existing, unrelated failures.** `yarn test` (full cadre-core suite) and
  `yarn typecheck` fail on ~17 files / ~112 tests with `digest()/sign()` arity
  errors (`Expected 1-3 arguments, but got 4` / "Unsupported output encoding:
  utf8") — fallout from the `sereus-cadre-schema-digest-api-migration` work, not
  this ticket. Details in `tickets/.pre-existing-error.md`. None of those files
  are touched here; `key-store-file.ts`/`key-store.ts`/`key-store.spec.ts`
  typecheck and lint clean in isolation.
- **fsync is not verified by a test.** The tests assert the *atomic-swap*
  invariants (old-or-new, no debris, perms), not that `sync()` actually flushed
  to hardware — fsync correctness is delegated to Node/OS and is not unit-testable
  portably. Reviewer: confirm the chosen durability bar (rename + file fsync +
  best-effort dir fsync) is the intended one, or escalate if true
  power-loss-proof dir-entry durability on Windows is required (it currently
  is not, by design).
- **The mid-write test mocks `rename`**, so it exercises the cleanup/rollback
  path, not a real OS-level torn write (which can't be induced portably). The
  `'wx'` EEXIST collision branch and the Windows `EPERM`/`EBUSY` rename-over-open
  branch are not directly tested (collision is ~impossible with 48 random bits;
  the locked-dest case is the out-of-scope cross-process scenario).
- **Hard-crash debris.** A power loss *between* temp creation and the catch (i.e.
  not a caught JS failure) can leave an orphaned `.tmp`. It is harmless —
  excluded from `list()`/`get()` — and not auto-reaped. Documented as acceptable;
  opportunistic temp-sweeping was deemed out of scope.

## Out of scope (unchanged from original ticket)

- Cross-process / multi-writer locking on one directory.
- Any change to the `KeyStore` interface or `InMemoryKeyStore`.
