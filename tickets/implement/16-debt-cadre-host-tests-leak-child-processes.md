description: The cadre-host test suites leave three fake node processes running after every run, so a machine that runs the suite repeatedly accumulates stray node processes that never exit. Make every test file stop what it started and fail if anything survives.
files:
  - packages/cadre-host/src/__tests__/orchestrator-teardown.ts (new — shared teardown helper)
  - packages/cadre-host/src/__tests__/orchestrator.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-push.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-owner.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-node-identity.test.ts
  - packages/cadre-host/src/__tests__/orchestrator-env-scrub.test.ts
  - packages/cadre-host/src/orchestrator/host-process-orchestrator.ts (read only — no product change)
  - packages/cadre-host/src/orchestrator/pid-liveness.ts, packages/cadre-host/src/orchestrator/types.ts (`isPidAlive`, `decodeDockerId`)
repro: verified
difficulty: easy
----

# cadre-host tests leave their fake child processes behind

## What is happening

Six test files in `packages/cadre-host/src/__tests__/` drive the real `HostProcessOrchestrator` (the class that starts, stops and deletes node child processes) against a small stub script written into a per-test temp directory. Each file has its own `afterEach` that is supposed to stop every child the test started. Two of them miss children. Each full run of `yarn workspace @serfab/cadre-host test` leaves exactly three processes behind: two `cadre-host-push-<rand>\fake-cli.mjs` and one `cadre-host-orch-<rand>\fake-child.mjs`.

Measured on 2026-09-30 with `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` filtered on `Temp\cadre-host-`: 117 stray processes, in 39 groups of three (two push at the same second, one orch about 11 seconds later), dating back to 2026-09-23. No strays from the other four spawning files (`cadre-host-auth-`, `cadre-host-pin-`, `cadre-host-nodeid-`, `cadre-host-env-scrub-` prefixes) and none from the integration tests.

## The two causes (both in test teardown; the product code is not at fault)

**`orchestrator-push.test.ts` — two per run.** Its `afterEach` calls only `orch.stopOwnerNode()`. The last test (`injects push for a storage-profile managed node but not a transaction node`) starts two non-owner nodes with `createContainer` (`storage-1`, `txn-1`), and nothing ever stops them.

**`orchestrator.test.ts` — one per run.** Its `afterEach` asks each orchestrator which nodes to remove by reading `<rootDir>/state.json` off disk (`listDockerIds`), not by asking the orchestrator. That breaks when two orchestrators share one `rootDir`, because each orchestrator rewrites the whole file from its own in-memory map. In `Restart recovery (init) › re-attaches to surviving children and reports dead ones`, orchestrator `a` starts `c1` and `c2`, then orchestrator `b` (same `rootDir`) starts `c3`. In teardown, `a` reads the file (`c1`, `c2`, `c3`), removes `c1` — which rewrites the file as `a` sees it, without `c3` — removes `c2`, and fails on `c3` with "Container not found", which the `try/catch` swallows. Then `b` reads the file, finds it empty, and removes nothing. `c3` is left running.

The swallowed `catch { /* ignore */ }` in every one of these `afterEach` blocks is why neither leak was ever reported.

`orchestrator-owner.test.ts` uses the same read-the-state-file teardown and would leak the same way the day one of its two-orchestrator tests has the second orchestrator start a node. The other three files already ask `orch.listNodes()` and are correct, but each carries its own copy of the loop and swallows errors.

## Design

One shared teardown helper, used by all six spawning files, that asks each orchestrator for the nodes it holds in memory, removes them, and then **asserts every one of those processes is gone**.

New file `packages/cadre-host/src/__tests__/orchestrator-teardown.ts` (not a `*.test.ts`, so vitest's `include` does not pick it up as a suite):

```ts
/**
 * Stop and remove every node the given orchestrators hold, then fail if any of
 * their processes is still alive. Empties `orchestrators`.
 */
export async function removeAllNodes(orchestrators: HostProcessOrchestrator[]): Promise<void>;
```

Behaviour:

- For each orchestrator, for each entry of `orch.listNodes()` (the public, in-memory list — the only complete record of what that orchestrator started or re-attached): record the pid (`decodeDockerId(node.dockerId).pid`) and the container id, then `await orch.removeContainer(node.dockerId)`. A throw from `removeContainer` is caught and kept, not swallowed silently — the sweep must continue so one failure does not strand the rest.
- After the sweep, collect every recorded pid for which `isPidAlive(pid)` is still true. Kill each of those directly by pid (`process.kill(pid, 'SIGKILL')`, ignoring `ESRCH`) so a failing teardown does not itself leak, then fail the test with a message that names the surviving container ids and pids and includes any `removeContainer` errors that were caught.
- A `removeContainer` error with no surviving process is not a failure of this helper's contract; include it in the message only when something survived. (Example that must stay green: two orchestrators over one `rootDir` — the second one's `removeContainer` for a node the first already removed finds a dead pid and an already-deleted workdir, and succeeds.)
- Set `orchestrators.length = 0` at the end, in a `finally`.

Each test file's `afterEach` becomes: `await removeAllNodes(orchestrators)`, then the existing `sleep(50)` and `rmSync(tmpRoot, …)`, then (env-scrub only) its existing environment restore. Put the `rmSync` and env restore in a `finally` so a teardown assertion failure still removes the temp directory and restores the environment for the next test. Delete the now-unused `listDockerIds` helpers in `orchestrator.test.ts` and `orchestrator-owner.test.ts`, and the `StateStore` import where that was its only use (`orchestrator.test.ts` still uses `StateStore` in test bodies; check `orchestrator-owner.test.ts`).

Why ask the orchestrator rather than the state file: the state file is one shared document that the last writer wins, while each orchestrator's in-memory map is exactly the set of children it can stop. It also covers the test that makes the state write fail on purpose (`does not unwind a launch that already spawned when the state write fails`), where the file is briefly behind memory.

Why no product change: `stopContainer` and `removeContainer` already wait for the pid to die and tests already assert that (`isPidAlive(pid)` is false after `stopContainer`). The manager deliberately does not stop lent nodes when it exits — they are meant to survive a manager restart (`child survives orchestrator exit` test, and the class comment on direct-fd inheritance) — so there is no "stop everything" product path to add or to call.

Tests that deliberately leave a child in an unusual state need no extra code, because in every such case an orchestrator in the test still holds a handle to the live child, and the helper reaches it:

- Tests that `SIGKILL` a child to model a crash: the child is already dead.
- Tests that re-attach a second orchestrator to a live child (`checks a re-attached handle by pid plus startup token`, `refuses to launch over a re-attached child whose ports are still bound`, the two owner re-attach tests): the first orchestrator still holds the handle with its `ChildProcess`.
- `child survives orchestrator exit`: the child is started by a separate helper process, so no orchestrator in the test holds it. It already kills the child by pid in its own `finally`. Leave it as is; add a one-line comment there saying this is the one child the shared teardown cannot see.

No new test file. The assertion inside the shared `afterEach` is the guard: it runs after every one of the existing tests, and it would have failed on both leaks above.

## Edge cases & interactions

- **Two orchestrators, one `rootDir`.** Removal order is `a` then `b`. `b` holds re-attached handles (no `ChildProcess`) for nodes `a` already removed: `removeContainer` must succeed on a dead pid and a missing workdir. Verified by the existing two-orchestrator tests going green with the new teardown, and by `c3` no longer surviving.
- **`removeContainer` throws mid-sweep.** The sweep continues, survivors are force-killed by pid, and the test fails naming them. Verified by inspection of the helper.
- **A test that timed out or failed mid-body.** `afterEach` still runs; children started before the failure are in `listNodes()` and are removed. The teardown failure, if any, is reported in addition to the test's own failure.
- **Slow-token child (`SLOW_TOKEN_CHILD`, 3 s before it writes its token).** It handles `SIGTERM` and has a `ChildProcess`, so `removeContainer` stops it without waiting for the token. By inspection.
- **Child that ignores `SIGTERM` (POSIX-only test).** `removeContainer` escalates to `SIGKILL` after `stopTimeoutMs` (1500 ms in these tests) — inside the default 10 s hook timeout. By inspection.
- **Windows working-directory handle release.** The OS releases a killed child's working directory a moment after the pid dies; `removeContainer` already retries the delete (20 × 200 ms). Keep the existing `sleep(50)` and the swallowed `rmSync(tmpRoot)` — a temp directory that outlives the test is litter, not a leaked process, and is not what this ticket asserts.
- **Hook timeout.** Several nodes each stopped in sequence: each cooperative stop takes roughly 100–1100 ms (the stop path waits up to 1 s for the exit event). The largest test starts three nodes. If any `afterEach` comes near vitest's 10 s hook timeout on Windows, pass an explicit timeout to that `afterEach` rather than parallelising removals — removals on one orchestrator share one state file.
- **Pid liveness read immediately after removal.** `stopContainer` returns only after `isPidAlive` is false or both its deadlines have passed, so checking right after the sweep is sound; no extra wait loop is needed. If a false "still alive" is ever seen here it means `stopContainer` gave up, which is a real finding, not flakiness to retry away.
- **Lint.** The repo rule is "don't eat exceptions without at least logging". The helper keeps caught errors and reports them; the only remaining bare `catch` in teardown is the temp-directory `rmSync`, which exists today.
- **Overlap with `debt-host-process-orchestrator-untested`** (plan stage, sequenced after this one, same test files). It adds assertions to `orchestrator.test.ts`; it should use `removeAllNodes` rather than a new teardown. Nothing to do here beyond leaving the helper exported.

## TODO

- Before touching anything, record the stray processes already on the machine: list `node` processes whose command line contains `Temp\cadre-host-orch-` or `Temp\cadre-host-push-` (Windows: `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` filtered on `CommandLine`; POSIX: `pgrep -af 'cadre-host-(orch|push)-'`). Note the count.
- Add `packages/cadre-host/src/__tests__/orchestrator-teardown.ts` with `removeAllNodes` as specified. Two-space indentation, matching the neighbouring test files.
- Replace the `afterEach` removal loop in all six spawning test files with `removeAllNodes(orchestrators)`; wrap the temp-directory removal (and env-scrub's environment restore) in `finally`.
- Delete `listDockerIds` from `orchestrator.test.ts` and `orchestrator-owner.test.ts`, and any import left unused.
- Add the one-line comment at the `finally` of `child survives orchestrator exit`.
- Run `yarn workspace @serfab/cadre-host test` twice in the foreground. (The `child survives orchestrator exit` test needs `yarn workspace @serfab/cadre-host build:server` to have run, otherwise it is skipped — that is fine either way.) After the second run, list the stray processes again: the count must equal the count recorded in the first step, i.e. neither run added any.
- Run `yarn workspace @serfab/cadre-host typecheck` and `yarn lint`.
- One-off cleanup, last: kill the pre-existing strays recorded in the first step — only processes whose command line matches `Temp\cadre-host-(orch|push)-<rand>\fake-(child|cli).mjs`, and only the pids recorded before the test runs, so a suite another agent is running at the same moment is not disturbed. Their temp directories can stay; do not recursively delete anything. Report the number killed in the review handoff. If the kill is denied or fails, say so in the handoff and leave them for a human.
