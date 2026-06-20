description: The file-backed key store now writes durably — a crash mid-save can no longer leave a half-written, unloadable identity file.
files: packages/cadre-core/src/key-store-file.ts, packages/cadre-core/test/key-store.spec.ts, docs/architecture.md
----

## Summary

`FileKeyStore.set` (`packages/cadre-core/src/key-store-file.ts`) is now crash-atomic.
Instead of an in-place `writeFile`, it writes the material to a sibling temp file
(`<encoded keyId>.<6-byte-hex>.tmp`, opened `'wx'` at `0o600`), fsyncs it
(`handle.sync()`), atomically `rename`s it over the slot, then best-effort fsyncs
the directory (`syncDir`). Any failure after the temp file is created (write,
sync, or rename) removes the temp file (`force:true`, swallowed) and rethrows,
leaving no `.tmp` debris and the previous slot byte-for-byte intact. A reader sees
either the complete old bytes or the complete new bytes, never a torn slot.

`get`/`delete`/`list`/encoding and the `KeyStore` interface / `InMemoryKeyStore`
are untouched (per the ticket's non-goals).

## Review findings

**What was checked:** the full implement diff (`96a312a`) with fresh eyes against
the original implement spec; the atomic-swap state machine (`open 'wx'` → write →
fsync → close → rename → dir-fsync) and its failure/rollback path; cross-platform
rename semantics; temp/slot namespace collision (encoding escapes `.`, so temp
files never match the `.key` suffix `list()` filters on, and never decode as a
slot); resource cleanup (handle closed in `finally`, temp `rm` on any post-create
failure, dir handle closed in `finally`); the test mock strategy (`vi.mock` spreads
the real `node:fs/promises`, replaces only `rename`; `mockRejectedValueOnce` is
one-shot so the contract suite is unaffected); docs; lint; typecheck; tests.

**Correctness / design — no major findings.** The state machine is sound:
`open 'wx'` happens *before* the try, so an EEXIST collision never triggers a
spurious `rm` of a file we don't own; `rename` sits inside the outer try so a
rename failure rolls back the temp; `syncDir` runs only after a successful rename
and swallows its (non-portable) errors without affecting atomicity. Last-writer-wins
on concurrent in-process `set`s to one slot is acceptable and documented (the
identity path is single-flight). The renamed fresh-at-`0o600` temp also re-applies
the mode on overwrite, which the old in-place `writeFile(mode)` did not.

**Minor — fixed inline this pass:**
- *Docs out of date.* `docs/architecture.md` described `FileKeyStore` as "one file
  per slot, best-effort `0o600`" with no mention of the new crash-atomic guarantee.
  Added a clause describing the temp-file + fsync + atomic-rename behavior.
- *Error-path test coverage gap.* The implementer's mid-write failure test only
  covered the *overwrite* case (prior slot survives). Added a sibling test for a
  failed **first** write (no prior slot) asserting no phantom slot is published
  (`get` → undefined) and the directory is left empty (no `.tmp` debris). Distinct
  observable scenario from the overwrite case.

**Major — none filed.** No new fix/plan/backlog tickets were spawned.

**Not covered, by design (acceptable, not findings):**
- fsync is not unit-tested — it is not portably observable; correctness is
  delegated to Node/OS. The tests assert the atomic-swap invariants (old-or-new,
  no debris, perms), which is the testable contract. The chosen durability bar
  (rename-atomicity + file fsync + best-effort dir fsync) is confirmed as the
  intended one; true power-loss-proof dir-entry durability on Windows is explicitly
  out of scope.
- The `'wx'` EEXIST collision branch (~impossible with 48 random bits) and the
  Windows `EPERM`/`EBUSY` rename-over-open branch (out-of-scope cross-process case)
  are not directly tested.
- Hard-crash `.tmp` debris (power loss between temp creation and the catch) is
  harmless — excluded from `list()`/`get()` — and intentionally not auto-reaped.

**Pre-existing, unrelated failures (not this ticket):** at HEAD the full cadre-core
suite and `yarn typecheck` fail on ~17 files with `digest()/sign()` arity errors —
fallout from `sereus-cadre-schema-digest-api-migration`, not this change. The
runner's triage pass already processed and cleared `tickets/.pre-existing-error.md`
(commit `eb69348`). The key-store files typecheck and lint clean in isolation, and
none of the failing files are touched here.

## Validation

```
cd packages/cadre-core
yarn vitest run test/key-store.spec.ts   # 22 passed, 1 skipped (posix-only perm test)
yarn eslint .../key-store-file.ts .../key-store.spec.ts   # clean
yarn typecheck                            # no errors in key-store* files
```

The shared `KeyStore` contract suite (`describe.each`) stays green against both
`InMemoryKeyStore` and `FileKeyStore`. FileKeyStore-specific tests: no `.tmp`
debris after success; `list()` ignores stray non-`.key` files; mid-write (rename)
failure preserves the previous slot and leaves no debris; failed first write leaves
no phantom slot; final slot keeps `0o600` even on overwrite (posix-only).

## Out of scope (unchanged from original ticket)

- Cross-process / multi-writer locking on one directory.
- Any change to the `KeyStore` interface or `InMemoryKeyStore`.
