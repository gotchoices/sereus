---
description: Direct-fd stdio + spawn-time-only log rotation for cadre-host children
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/log-rotator.ts, packages/cadre-host/src/orchestrator/types.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts
---

## What landed

`HostProcessOrchestrator.createContainer` now hands the child a file
descriptor opened on `<workdir>/node.log` as its stdio[1] / stdio[2]
and closes the parent's copy immediately after `spawn`. The child's
write path no longer touches a handle owned by the orchestrator, so the
parent can exit (planned or crash) without SIGPIPE-ing the grandchild
on POSIX or breaking writes with EPIPE on Windows.

Because the child holds the inode open for the duration of its run,
log rotation is now spawn-time only. `LogRotator` collapsed into a
free function `rotateOnDisk(filePath, maxFiles)`; the orchestrator
wraps it in `maybeRotateAtSpawn(logPath, maxBytes, maxFiles)`, which
stats the active file and triggers the cascade before opening the new
fd. `Handle.logRotator`, the in-process `Writable`, the byte counter,
and the `pipeWithRotation` plumbing are all gone.

The trade-off (a long-lived child can grow `node.log` past
`logMaxBytes` mid-run) is documented in the orchestrator class header
and in the `log-rotator.ts` file header. Acceptable for v1 traffic.

## Review findings

### What I checked
- **Implement-stage diff (`git show 0177ffd`)** — read first with no
  reference to the implementer's handoff.
- **`host-process-orchestrator.ts`** — full pass over the new
  spawn/fd-close path, the failed-spawn fallback, the rotation
  wrapper, and the surrounding `stopContainer` /
  `removeContainer` cleanup.
- **`log-rotator.ts`** — entire (small) file; confirmed the cascade
  is correct, the `try/{ignore}` blocks are scoped per rename, and
  no stale class state remains.
- **`types.ts`** — confirmed `Handle.logRotator` and the
  `LogRotator` import are gone and no other field depends on them.
- **Tests** — read every test in `orchestrator.test.ts`, looked
  for missing coverage, then ran the suite.
- **Cross-codebase references** — grepped sereus for
  `LogRotator|pipeWithRotation|logRotator`. Only hits are this
  ticket and an archived `tickets/complete/` ticket. Docs
  (`docs/cadre-host.md`, `docs/architecture.md`,
  `docs/reference-app-rn.md`) don't reference the old log path or
  the rotator design — nothing to update.
- **Build + tests** — `yarn workspace @serfab/cadre-host build`
  (clean) and `yarn workspace @serfab/cadre-host test --run`. After
  the inline fixes below: 149 passed, 2 skipped (keytar secrets
  test + Windows-skipped SIGTERM-ignore test).

### Minor findings — fixed inline

- **`let child;` was implicit `any`, and the synchronous-spawn-throw
  path leaked ports.** The previous `try { spawn() } finally {
  closeSync(logFd) }` block left `child` undefined if `spawn` itself
  threw, then crashed on `child.pid` with a TypeError — bypassing the
  three `portAllocator.release` calls that the failed-spawn path
  relies on. Switched to typed `let child: ChildProcess`, an explicit
  `try { spawn() } catch (err) { closeSync(logFd); release ports;
  throw err; }` around the call, and a single `closeSync(logFd)` on
  the success path. (`packages/cadre-host/src/orchestrator/host-process-orchestrator.ts`)
- **No automated coverage for `maybeRotateAtSpawn`** — the implement
  handoff flagged this gap explicitly. Added
  `describe('HostProcessOrchestrator log rotation at spawn')`: it
  pre-seeds an oversized `node.log` under a known workdir, runs
  `createContainer`, and asserts that `node.log.1` holds the seeded
  contents while `node.log` is a fresh small file. Catches a
  regression where rotation is skipped or wired to the wrong
  threshold. (`packages/cadre-host/src/__tests__/orchestrator.test.ts`)
- **Cross-process test built file URLs by hand** (`'file://' +
  path.replace(/\\/g, '/')`), which yields `file://C:/...` (two
  slashes, `C:` parsed as authority) instead of the correct
  `file:///C:/...`. Node accepts it today but it is the wrong
  pattern; replaced with `pathToFileURL(distPath).href` for both the
  orchestrator and log-rotator imports, and threaded both URLs
  through `buildSpawnerScript` instead of the brittle string
  replace.

### Major findings
- **None.** The design is sound: direct-fd stdio is the right answer
  to the SIGPIPE/EPIPE risk, and giving up mid-run rotation is the
  honest cost. The class header + log-rotator file header both call
  out the trade-off, so future maintainers won't be surprised.

### Open items deferred (not raised as new tickets)
- **POSIX CI coverage for the cross-process test.** The test was
  observed green on Windows only (this reviewer's box is also
  Windows). The failure mode it guards against (SIGPIPE on the
  grandchild's next write after the parent dies) is POSIX-specific,
  so the highest-value confirmation is the first POSIX CI run. No
  code change needed; if CI exists, watch the next green build.
- **Failed-spawn empty `node.log`.** A failed `spawn` (e.g. fd
  returns no pid) leaves a zero-byte `node.log` in the workdir
  because `openSync(..., 'a')` touches the file before the failure.
  Pre-existing behaviour, harmless (the next successful spawn
  appends to it). Not worth a separate ticket.
- **`Handle.child` post-restart.** Surviving handles re-attached via
  `init()` have no `child` reference, so `stopContainer` falls
  through to `process.kill` only — already true before this work,
  and still acceptable.

### Categories with no findings — and why
- **Resource cleanup.** Verified: log fd is closed on every path
  (success, sync-throw, no-pid). `stopContainer` /
  `removeContainer` no longer need to touch a rotator — there is
  none. Workdir cleanup is unchanged. No leaked listeners.
- **Type safety.** After fixing the implicit-`any` `let child`,
  every other reachable variable has an explicit type or is
  inferred from a typed source. No new `any` introduced.
- **Cross-platform.** Direct-fd stdio works identically on Windows
  and POSIX (Node's `spawn` duplicates the fd via the OS); the
  rotation cascade uses `renameSync`, which the implementer
  preserved from the prior design specifically because Windows
  WriteStream close was racy. `pathToFileURL` is the correct
  cross-platform way to build the helper's import specifiers.
- **Performance.** Direct-fd writes go straight from the child to
  the kernel — strictly less work than the prior pipe →
  in-process Writable → `writeSync` chain. No new hot paths.
- **DRY / modularity.** `defaultLogPath` is the single
  source of truth for the log path. `rotateOnDisk` is now a pure
  free function with no hidden state. `maybeRotateAtSpawn` is a
  thin in-file helper, appropriately co-located with its single
  caller.
- **Error handling.** No swallowed exceptions where they matter —
  the rotation cascade's per-rename `try { ... } catch { /* ignore */ }`
  is intentional (a transient lock on a rotated file shouldn't
  abort spawn). All caller-facing failures throw clearly.

## Validation run

- `yarn workspace @serfab/cadre-host build` → exit 0 (clean).
- `yarn workspace @serfab/cadre-host test --run` → 16 files,
  149 passed / 2 skipped, ~7 s wall.
- Cross-process test (`grandchild stays alive and keeps logging
  after spawner process exits`) → 1008 ms, observed running (not
  skipped) thanks to the pre-existing build.
- New `HostProcessOrchestrator log rotation at spawn` test →
  passes.
- No `lint` script at the package level; `tsc -p tsconfig.build.json`
  acts as the type check and is part of the build.

## Files touched in review

- `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts`
  — re-imported `ChildProcess` type; typed `let child` explicitly;
  replaced the `try { spawn } finally { closeSync }` with an explicit
  `try/catch` that closes the fd and releases ports on a synchronous
  spawn throw, with the success-path `closeSync` after the block.
- `packages/cadre-host/src/__tests__/orchestrator.test.ts`
  — added `pathToFileURL` import; rebuilt `orchestratorDistUrl` to
  compute both file URLs via `pathToFileURL`; threaded both URLs
  through `buildSpawnerScript` (no more in-script string replace);
  added a new `HostProcessOrchestrator log rotation at spawn`
  describe block that pre-seeds an oversized log and asserts the
  spawn-time cascade fires.
