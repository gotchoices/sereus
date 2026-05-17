---
description: Make spawned cadre children survive (and keep logging through) an orchestrator parent restart
prereq:
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/log-rotator.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts
---

## Background

`HostProcessOrchestrator.createContainer` currently spawns children with
`stdio: ['ignore', 'pipe', 'pipe']` and pipes stdout/stderr through a
`LogRotator` living in the orchestrator process. The detach/unref dance
keeps the OS handle on the child alive across an orchestrator crash, but
the pipe's read end is held by the orchestrator's address space. When the
orchestrator exits:

- POSIX: child gets `SIGPIPE` on its next stdout/stderr write → default
  action kills it (cadre-cli installs no `SIGPIPE` handler — verified at
  `packages/cadre-cli/src/commands/start.ts:165`).
- Windows: writes return `EPIPE`; child usually keeps running but loses
  all logging from that point forward.

Either way, the documented "restart recovery via `init()`" cannot work in
practice because the surviving child is silently broken (or dead) before
the new orchestrator process gets a chance to re-attach.

## Fix: direct-fd stdio (approach 1 from the fix ticket)

Open the active log file once at spawn time and inherit its fd directly
into the child as both stdout and stderr. The OS duplicates the fd into
the child, so the orchestrator's copy can be closed immediately after
spawn — and the child's write path no longer touches any handle owned by
the orchestrator process.

```ts
mkdirSync(workdir, { recursive: true });
const logPath = defaultLogPath(workdir);
maybeRotateAtSpawn(logPath, this.logMaxBytes, this.logMaxFiles);
const logFd = openSync(logPath, 'a');
try {
  const child = spawn(process.execPath, args, {
    cwd: workdir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });
  // ... build handle ...
} finally {
  closeSync(logFd); // child has its own copy
}
```

### Rotation trade-off

The current `LogRotator` measures bytes written through its in-process
`Writable` and renames the active file when the threshold trips. With
direct-fd stdio, the orchestrator no longer sees writes and the child
holds a stable file descriptor — renaming the path under it would leave
the child writing to the renamed inode.

For v1 we accept **spawn-time-only** rotation: when a new child is being
spawned for a workdir whose `node.log` already exceeds `logMaxBytes`,
rotate the existing files (`.N-1 → .N`, …, `base → .1`) first, then open
the fresh fd. This is acceptable because (a) within a workdir there is
at most one live child, so spawn-time is the only moment a rotation can
be safely performed without coordinating with the running process, and
(b) v1 traffic is low — children are not expected to fill `logMaxBytes`
mid-run frequently enough to matter. Document this in the orchestrator
file header and in the `LogRotator` source comment.

The byte-counting `write(...)`-style rotation in `LogRotator` becomes
dead code for the spawn path — keep `LogRotator` only for the spawn-time
rotation helper (rename cascade). Either:
  - prune `LogRotator` down to a tiny `rotateOnDisk(filePath, maxFiles)`
    free function and a `defaultLogPath(...)` helper, removing the
    `Writable`/`fd`/byte-counting machinery; or
  - keep the class but expose a `static rotateOnDisk(...)` and stop
    constructing instances in the orchestrator.

Prefer the prune option — there are no remaining callers of the streaming
API outside the orchestrator and its unit test, and the unused machinery
will rot. Update the `LogRotator` test accordingly: test the on-disk
rename cascade directly rather than via `write(...)` calls.

### Handle bookkeeping

`Handle.logRotator` field, `pipeWithRotation(child, rotator)`, and the
`logRotator?.close()` calls in `stopContainer` / `removeContainer` all go
away. The handle no longer owns a writable stream; nothing to close.

The `getLogs(...)` path (`tailFile(defaultLogPath(handle.workdir), n)`)
keeps working unchanged — it reads from disk, not from the rotator.

### Failed-spawn cleanup

If `spawn` returns no pid, the `closeSync(logFd)` in the `finally` block
still happens — release the port reservations as today and throw. An
empty (or near-empty) `node.log` may be left behind in the workdir;
that's acceptable and matches today's behaviour.

## Cross-process test

The current `Restart recovery (init)` test runs both orchestrators inside
the same vitest worker process, so the spawning process's pipe-read fds
never close and the bug is not exercised. Add a new test that genuinely
exits the spawning process:

  1. Write a small helper script (`tmp/spawner.mjs`) to a temp dir. The
     helper imports `HostProcessOrchestrator` (resolved against the
     workspace's built output — see how the existing test resolves the
     fake child), calls `createContainer` on the supplied request, prints
     the resulting `dockerId` / `pid` / `workdir` / log path as one JSON
     line to its stdout, and then exits cleanly. The helper uses the
     same fake-child entrypoint the rest of the suite uses.
  2. The test spawns the helper as a normal (non-detached) Node child,
     captures stdout, and `await`s the helper's exit. After exit, assert:
     - `isPidAlive(grandchildPid) === true` (immediately and again after
       a ~500 ms delay — to catch a delayed-SIGPIPE kill on POSIX).
     - The grandchild's `node.log` size grows between two reads taken
       ~300 ms apart (proves stdio still works, not just that the PID
       is alive).
  3. Clean up by `process.kill(grandchildPid, 'SIGKILL')` and
     best-effort `rmSync(workdir, { recursive: true, force: true })`.
     The test does not need to create a second orchestrator + `init()`;
     the survival-and-still-logging assertion is the heart of the bug.

Build/import note: `HostProcessOrchestrator` ships from
`packages/cadre-host/dist/...`. The helper must import the built artifact
(or use a tsx/loader-equivalent), since it runs as a plain
`node tmp/spawner.mjs`. If the test environment runs from source with
vitest's module loader, you can instead write the helper to import via a
file URL pointing at the source `.ts` after compiling on the fly — but
the simpler path is: have the helper require the same JS dist that
production uses. Verify the package builds before running this test, or
gate it with `it.skipIf(!existsSync(distPath))` and document in the test
why.

Keep the existing same-process `Restart recovery (init)` test — it still
covers the state-reattach logic. Just don't pretend it covers the stdio
bug.

## Acceptance

- Children spawned via `createContainer` survive the orchestrator process
  exiting (POSIX and Windows).
- Children continue producing log output (file size grows) after the
  orchestrator process exits.
- New cross-process test (above) is green on both platforms.
- All existing orchestrator tests still pass, including `getLogs`, the
  rotator test (adapted), and the same-process restart-recovery test.
- `yarn workspace @serfab/cadre-host build` and the package test suite
  pass.

## TODO

- Replace pipe-based stdio with direct-fd stdio in
  `host-process-orchestrator.ts::createContainer`: open `node.log` in
  append mode, pass the fd as stdio[1]/[2], close the parent's copy
  after spawn (and on the failed-spawn path).
- Add a `rotateOnDisk(filePath, maxFiles)` helper (in `log-rotator.ts`)
  that performs the .N-1→.N cascade against on-disk paths only. Call it
  from `createContainer` before opening the fd when the existing file
  exceeds `logMaxBytes`.
- Remove `LogRotator`'s `Writable` / `fd` / `bytes` / `write(...)` /
  `close()` machinery and the `pipeWithRotation` helper. Drop the
  `logRotator` field from `Handle` and the `logRotator?.close()` calls
  in `stopContainer` / `removeContainer`. Update `Handle` type
  accordingly.
- Update the file header comment in `host-process-orchestrator.ts` to
  document the new stdio model and the spawn-time-only rotation
  trade-off.
- Update the existing `LogRotator` vitest case to exercise
  `rotateOnDisk(...)` directly (write files to disk, call the helper,
  assert the rename cascade and `maxFiles` cap).
- Add the cross-process test described under "Cross-process test"
  above. Place the helper script in the per-test `tmpRoot` so it is
  cleaned up by the existing `afterEach`.
- Verify on Windows that the inherited fd works as expected
  (`stdio: ['ignore', fd, fd]` is supported by `child_process.spawn` on
  Win32, but confirm via the new test running locally if possible — if
  CI is POSIX-only, leave a note in the ticket and rely on local
  validation).
- Run `yarn workspace @serfab/cadre-host build` and
  `yarn workspace @serfab/cadre-host test` (stream output with `tee`).
  Fix any fallout (imports / unused symbols / type errors).
