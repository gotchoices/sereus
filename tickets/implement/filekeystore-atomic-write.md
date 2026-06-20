description: Make FileKeyStore.set durable against torn writes (temp-file + atomic rename) so a crash mid-write cannot leave an unloadable identity slot
files: packages/cadre-core/src/key-store-file.ts, packages/cadre-core/test/key-store.spec.ts
----

`FileKeyStore.set` (`packages/cadre-core/src/key-store-file.ts`) currently does a
single `writeFile(slotPath, bytes, { mode })`, which truncates-then-writes in
place. If the process crashes (or the device loses power) partway through, the
slot is left torn/partial.

This fails *loudly* rather than silently — on the next `CadreNode.start()` the
identity-resolution path calls `privateKeyFromProtobuf(bytes)` on the partial
bytes, which throws (corrupt-bytes case), and resolution deliberately does **not**
regenerate over an existing-but-unreadable slot. So the real identity is never
silently orphaned. But the node cannot start until the slot is manually restored
or removed.

This is acceptable for the current state (FileKeyStore is used by tests and is
not yet wired into the headless `cadre-cli` / `cadre-host` persistence path; the
production mobile target uses `expo-secure-store`, which is atomic). It becomes a
real durability concern once a long-running headless Node cadre node persists its
identity through `FileKeyStore`.

### Desired behavior

`set` should be crash-atomic: a reader either sees the complete old bytes or the
complete new bytes, never a torn slot.

- Write to a sibling temp file (e.g. `<slot>.<unique>.tmp`) in the same directory
  (same filesystem, so `rename` is atomic), then `rename` it over the final slot
  path.
- Mind cross-platform `rename`-over-existing semantics (POSIX replaces atomically;
  Node on Windows replaces via `MoveFileEx` but confirm behavior when the dest is
  open/locked). Clean up the temp file on a failed write so retries don't leak
  `.tmp` debris. Ensure `list()` (which filters by the `.key` suffix) never
  surfaces a stray `.tmp`.
- Consider whether an `fsync` of the file (and/or directory) is warranted for true
  power-loss durability, or whether rename-atomicity alone is the intended bar —
  decide and document.
- Preserve the existing best-effort `0o600` file / `0o700` dir permissions on the
  final slot.

### Out of scope / non-goals

- Cross-process / multi-writer locking on one directory (a separate concern; the
  in-process `CadreNode` identity path is already single-flight via the
  `identityKey` guard).
- Any change to the `KeyStore` interface or the in-memory backend.

### Tests

- Round-trip + overwrite still pass (existing contract suite in
  `test/key-store.spec.ts` already covers these — they must stay green).
- No `.tmp` (or other non-`.key`) file is surfaced by `list()` after a `set`.
- A simulated mid-write failure (e.g. stub the temp write to throw after the temp
  file is created) leaves the previous slot bytes intact and loadable, and leaves
  no `.tmp` debris.
- Permissions on the final slot are unchanged (posix-only assertion; skip on
  Windows).
