---
description: Review direct-fd stdio + spawn-time-only rotation for cadre-host children
prereq:
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/log-rotator.ts, packages/cadre-host/src/orchestrator/types.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts
---

## What changed

Switched `HostProcessOrchestrator.createContainer` from
`stdio: ['ignore', 'pipe', 'pipe']` + an in-process `LogRotator` to
direct-fd inheritance: the orchestrator opens `<workdir>/node.log` once,
passes the fd as both stdio[1] and stdio[2], and `closeSync`s its own
copy in a `finally` block immediately after `spawn`. The child's write
path no longer touches any handle owned by the orchestrator process, so
the parent can exit cleanly without delivering SIGPIPE (POSIX) or
breaking writes with EPIPE (Windows).

Log rotation is now spawn-time-only. `LogRotator` was pruned down to a
single free function `rotateOnDisk(filePath, maxFiles)` (the rename
cascade) plus `defaultLogPath(workdir)`. The orchestrator wraps it in
`maybeRotateAtSpawn(logPath, maxBytes, maxFiles)`, which stats the
active file and triggers the cascade if it is already at or above the
threshold — done before opening the fd. The class header in
`host-process-orchestrator.ts` documents this trade-off, and so does
the new `log-rotator.ts` file header.

`Handle.logRotator` is gone; so are `pipeWithRotation`, the
`logRotator?.close()` calls in `stopContainer`/`removeContainer`, and
the `LogRotator` import from `types.ts`.

## Files touched

- `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts`
  - New class docstring sections on direct-fd stdio + spawn-time-only
    rotation.
  - `createContainer` now: `maybeRotateAtSpawn` → `openSync` →
    `spawn(...)` in a `try` → `closeSync(logFd)` in the `finally`.
    Failed-spawn path releases ports and throws; the fd is always
    closed by the `finally`.
  - `pipeWithRotation` deleted; `maybeRotateAtSpawn` added.
  - All `handle.logRotator?.close()` references removed.
- `packages/cadre-host/src/orchestrator/log-rotator.ts`
  - Removed `LogRotator` class, its `Writable`, `fd`, byte counter,
    `write(...)`, `close()`. Kept `defaultLogPath` and added
    `rotateOnDisk(filePath, maxFiles)`.
  - File header now documents why rotation lives only at spawn time.
- `packages/cadre-host/src/orchestrator/types.ts`
  - Dropped the `LogRotator` import and the `Handle.logRotator` field.
- `packages/cadre-host/src/__tests__/orchestrator.test.ts`
  - Rewrote the `LogRotator` test as a `rotateOnDisk` test
    (cascade + maxFiles cap + no-op-when-missing + partial cascade).
  - Added a new `describe('child survives orchestrator exit')` block
    with a cross-process test (see below).

## Acceptance verification

- `yarn workspace @serfab/cadre-host build` → exit 0.
- `yarn workspace @serfab/cadre-host test` → 148 passed, 2 skipped
  (the keytar-dependent secrets test and the pre-existing
  `it.skipIf(process.platform === 'win32')` SIGTERM-ignore test).
- The new cross-process test (`grandchild stays alive and keeps logging
  after spawner process exits`) passes in ~1.1 s on Windows.

## Cross-process test design

The test writes a small `spawner.mjs` helper to the per-test `tmpRoot`.
The helper imports `HostProcessOrchestrator` from the package's built
dist (resolved via `import.meta.url` → `../../dist/...`), constructs an
orchestrator with `spawn.entrypoint` pointing at the existing
`fake-child.mjs`, calls `createContainer`, prints one JSON line to
stdout (`{dockerId, pid, workdir, logPath}`), and `process.exit(0)`s.

The vitest test:
1. `spawnSync`s the helper (non-detached) and waits for exit; asserts
   exit code 0.
2. Reads the JSON line; asserts `isPidAlive(grandchildPid) === true`
   immediately AND after a ~500 ms delay (catches delayed-SIGPIPE
   kill).
3. Reads `statSync(logPath).size` twice ~300 ms apart; asserts the
   second is greater than the first (proves stdio still flows, not
   just that the PID is alive).
4. Cleans up with `process.kill(grandchildPid, 'SIGKILL')` and a
   best-effort `rmSync(workdir, …)` in a `finally`.

The test is gated with `it.skipIf(!existsSync(distPath))` so a fresh
checkout without a build does not fail; the suite is otherwise
runnable from source.

The existing same-process `Restart recovery (init)` test was kept — it
covers the state-reattach logic. It does NOT cover the stdio bug; the
new cross-process test does.

## How to validate by hand

1. `yarn workspace @serfab/cadre-host build`
2. `yarn workspace @serfab/cadre-host test` — confirm all green and
   that the cross-process test shows as run (not skipped).
3. Tail one of the per-test workdirs while the suite runs and confirm
   `node.log` grows monotonically across the cross-process test
   (visible if you slow the test down with `await sleep(5000)`).
4. Sanity-check the SIGPIPE story on POSIX with a manual repro: run
   the helper directly (`node /path/to/spawner.mjs '{...payload...}'`),
   wait for it to exit, then `kill -0 <grandchildPid>` and tail
   `node.log` — both should keep working.

## Known gaps / things to scrutinize

- **Windows-only CI coverage.** All test runs above were performed on
  Windows 11 (the dev box). The cross-process test should pass on
  POSIX too — SIGPIPE is the exact failure mode it was designed to
  catch — but it has not been observed green there yet. If CI is
  POSIX, that's the highest-value place to confirm.
- **Mid-run rotation regression.** With the old design, a child that
  exceeded `logMaxBytes` while running would rotate mid-stream. Now
  it won't — `node.log` for a long-lived child can grow unbounded.
  Documented in the orchestrator class header and the log-rotator
  source comment. Acceptable for v1; flag if future traffic estimates
  change.
- **Failed-spawn empty file.** If `spawn` returns no pid, the
  `openSync(logPath, 'a')` will have already touched `node.log` (zero
  or near-zero bytes appended). The `finally` closes our fd, but the
  empty file is left in the workdir. Matches today's behaviour and
  is harmless — but worth confirming the reviewer agrees that's the
  right call vs. unlinking on failed-spawn.
- **fd close timing.** `closeSync(logFd)` runs synchronously in the
  `finally` block immediately after `spawn` returns. On all
  platforms `spawn` blocks until the child has its own duplicate of
  the fd, so this is safe. If a reviewer is suspicious, the simplest
  belt-and-suspenders alternative is a no-op `_unused = logFd` until
  the child emits 'spawn' — not done here because it adds async to
  a synchronous-feeling code path for no observed gain.
- **`Handle.child` post-restart.** Same as before: surviving handles
  re-attached via `init()` have no `child` reference, so
  `stopContainer` falls through to `process.kill` only. Unchanged
  by this work.
- **No automated test for the rotation-at-spawn path.** The unit test
  exercises `rotateOnDisk` directly, but `maybeRotateAtSpawn` (the
  stat-then-rotate wrapper inside `createContainer`) is only
  exercised end-to-end. A reviewer who wants a dedicated test could
  add one that pre-seeds a `node.log` larger than `logMaxBytes` and
  asserts the rotation cascade fires on the next `createContainer`.

## Use-case checklist for the reviewer

- [ ] `yarn workspace @serfab/cadre-host build` is green.
- [ ] `yarn workspace @serfab/cadre-host test` is green on the
      reviewer's OS (especially POSIX if available).
- [ ] The cross-process test reports as run, not skipped.
- [ ] Spot-check a manual scenario: spawn a container, kill the
      orchestrator process via Task Manager / `kill -9`, and confirm
      the grandchild PID stays alive and its `node.log` keeps growing.
- [ ] No new uncommitted artifacts under `tmpRoot` after the suite
      finishes (the existing `afterEach` cleans `tmpRoot`).
