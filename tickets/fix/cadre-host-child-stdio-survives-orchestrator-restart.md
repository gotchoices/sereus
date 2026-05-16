---
description: Child cadre processes likely die when HostProcessOrchestrator parent restarts, defeating restart-recovery
prereq: cadre-host-process-orchestrator
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/log-rotator.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts
---

## Problem

`HostProcessOrchestrator.createContainer` spawns children with
`stdio: ['ignore', 'pipe', 'pipe']` plus `detached: true` + `child.unref()`.
The orchestrator's own process owns the read end of those pipes. When the
orchestrator process exits and is later replaced:

- **POSIX (Linux/macOS):** kernel releases the parent's pipe-read fds. The
  next time the child writes to stdout/stderr it gets SIGPIPE → default
  action is terminate. The cadre-cli `start` command installs `SIGINT` /
  `SIGTERM` handlers but no `SIGPIPE` handler. So the surviving child is
  killed shortly after the orchestrator dies, typically the next time the
  health server logs.
- **Windows:** no SIGPIPE; the child's writes to a closed pipe return
  `EPIPE`. Whether this kills the Node process depends on whether anything
  is listening on `process.stdout.on('error', ...)`. Most likely the child
  silently loses log output but keeps running. Either way, no logs from
  that point.

The `init()` method and the documented "restart recovery" flow therefore
work only when the same Node process that spawned the child is still
alive — exactly the case where init() is _not_ needed.

The existing restart-recovery test (`Restart recovery (init)` in
`orchestrator.test.ts`) creates a fresh orchestrator inside the same
vitest process. The original orchestrator's pipes never close because
the test runner process is still alive, so the test passes without
exercising the real failure mode.

## Acceptance criteria

- Surviving children must continue running and continue producing log
  output after the orchestrator process exits and is replaced.
- The fix must keep working on Windows (where the implementation runs in
  production today).
- A test must reproduce the cross-process scenario, e.g. by spawning a
  small helper Node process that itself uses
  `HostProcessOrchestrator.createContainer`, then waiting for that helper
  to exit and asserting the grandchild is still alive.

## Suggested approaches

1. **Direct-fd stdio (simplest).** Open the active log file once at spawn
   time and pass its fd as `stdio[1]` and `stdio[2]`:

   ```ts
   const logFd = openSync(defaultLogPath(workdir), 'a');
   const child = spawn(process.execPath, args, {
     ...,
     stdio: ['ignore', logFd, logFd],
   });
   ```

   The child writes directly to the file, no pipe involved. The orchestrator
   can close its handle to `logFd` (`closeSync(logFd)`) after spawn — the
   child still holds its own copy.

   Trade-off: size-based rotation while the child is running becomes hard
   (the child has the file path open at a stable fd; renaming the file
   from under it leaves the child writing to the renamed inode). Options:
   (a) accept no in-flight rotation — rotate only on next spawn;
   (b) use copytruncate semantics (`writeFileSync` with truncation);
   (c) signal the child to reopen its log.

2. **Detach via small log shim.** Spawn a tiny `logger` child first that
   tails its stdin to a rotating file; the cadre child's stdio pipes go
   into that shim. The shim becomes the long-lived parent of the pipe.
   More moving parts; probably overkill.

3. **systemd / launchd style service supervision.** Out of scope here.

Recommend approach (1) for v1 with rotation deferred to spawn-time (the
log files cap is per-spawn already; v1 traffic is low). Document the
trade-off in the orchestrator file header.

## Why this wasn't caught

- The implementer's restart-recovery unit test never exits the parent
  process — both orchestrator instances live inside the same vitest run.
- The handoff in `tickets/review/...` correctly flags that there's no
  orchestrator-level shutdown but does not connect this to the stdio
  inheritance issue.
