description: cadre-host mistakes a donated node that is still starting up for a dead one and starts a second copy on the same ports; the copy crashes, but the host has already swapped in a new seed password, so the running node refuses every seed and the loan is stuck. Fix the liveness check, refuse to start over a live node, and stop the endless restart loop.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts, docs/cadre-host.md
difficulty: medium
repro: verified
----

# A donated node that is still starting is respawned over itself, leaving the loan unseedable

## What was observed (2026-09-16, donor mode, Windows)

A phone requested a node; `grn_1SrppkgMdQprQKAh` came up healthy on ports 10010–10014. A second process for the same container was then launched, died with `listen EADDRINUSE 0.0.0.0:10010`, and afterwards: the donation's recorded `seedToken` had changed (and kept changing), the container's `.startup-token` file was empty, the first node answered the host's `POST /seed` with `401 unauthorized`, and the donation stayed `awaiting_seed` while the original node kept its ports and the grant's quota slot.

## Root cause (reproduced)

The host decides "is this donated node running?" in `HostProcessOrchestrator.isRunning` (`host-process-orchestrator.ts`, ~line 880): the process id must be alive **and** `<workdir>/.startup-token` must hold the token the host generated. But `cadre-cli start` writes that file only **after** `await node.start()` resolves (`packages/cadre-cli/src/commands/start.ts` ~line 283) — after the health server has already bound its port and after the control-network connection. For the whole start-up window, a perfectly healthy child reads as "not running".

`DonationSupervisor` (`donation-supervisor.ts`) sweeps every 60 s (plus at host startup and on child exit). A sweep that lands in that window calls `DonationService.respawn` immediately (a record with no attempt history has no backoff). `respawn` → `createContainer` → `dropStaleHandle` releases the old handle's ports, `allocateNodePorts` hands the *same* ports back (`reusedNodePorts`), and `launchChild`:

- deletes `.startup-token` (the live first child's file),
- mints a fresh `seedToken` and startup token,
- spawns the second child and returns **success** — the port clash happens asynchronously inside the child, after `launchChild` has returned.

`respawn` then writes the new `dockerId`/`seedEndpoint`/`seedToken` onto the donation record. The first node still holds the original `CADRE_SEED_TOKEN` in its environment, so every seed the host sends is refused with 401.

It then never recovers: the second child's exit triggers another pass, `isRunning(newDockerId)` is false (dead pid, token file mismatch), and `respawn` runs again after its backoff — rotating the token again each time (hence "the token keeps changing"). `DonationSupervisor.attemptRespawn` only checks the give-up threshold (`DONATION_RESPAWN_MAX_ATTEMPTS`) in its `catch`, i.e. when `respawn` *throws*. A spawn that succeeds and then dies a moment later never throws, so the attempt counter grows but give-up is never reached; the loop settles at the 5-minute backoff cap forever.

Reproduction (run during the fix stage, then removed): a fake child that binds `CADRE_HEALTH_PORT` at once and writes the startup token 1.5 s later. Calling `createContainer` for a container id, waiting 500 ms, then `isRunning(first.dockerId)` → `false` while the pid is alive; a second `createContainer` for the same id (exactly what `respawn` does) → returns success with a different `seedToken` and the same health endpoint; the node log then shows `Failed to start cadre node: listen EADDRINUSE: address already in use 0.0.0.0:18500`, with the first pid still alive and `isRunning(second.dockerId)` false. Test body sketch:

```ts
const CHILD = `
import fs from 'node:fs'; import net from 'node:net';
const a = process.argv.slice(2); const tp = a[a.indexOf('--startup-token-file') + 1];
const s = net.createServer();
s.on('error', (e) => { console.error('Failed to start cadre node: ' + e.message); process.exit(1); });
s.listen(Number(process.env.CADRE_HEALTH_PORT), '0.0.0.0', () => {
  setTimeout(() => fs.writeFileSync(tp, process.env.CADRE_STARTUP_TOKEN), 1500);
});
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;
// first = createContainer(req); sleep(500); isRunning(first.dockerId) === false  ← bug
// second = createContainer(req) succeeds; second child dies EADDRINUSE; first pid still alive
```

Note: the package's vitest `globalSetup` (stale-build guard) refused to run at the time because `@optimystic/db-p2p`'s dist was stale; the repro was run with a throwaway config without `globalSetup`. Rebuild optimystic (`yarn workspace @optimystic/db-p2p build` in `../optimystic`) before running the real suite.

A host restart while a child is mid-startup hits the same false negative through `init()` (`alive = isPidAlive && tokenMatches`) followed by the supervisor's startup pass.

## Fix — four arms, one incident

### 1. Liveness must not read "still starting" as "dead" (root cause)

- In `cadre-cli start`, write the startup-token file as early as possible — before the health server binds and before `node.start()`. The file's purpose is identity ("this pid is the child I spawned, not a recycled pid"), not readiness; nothing in cadre-host treats it as a readiness signal (checked: `isRunning`, `init`, `ensureOwnerNode` are its only readers). Update the `--startup-token-file` option help text accordingly. The owner node's admin channel is still bound later, and the manager's admin client already copes with a not-yet-listening admin port — confirm that when changing the order.
- In `HostProcessOrchestrator.isRunning` (and the `ensureOwnerNode` short-circuit, which uses the same check), when the handle carries the `child` object spawned by *this* host process, trust it: running iff `child.exitCode === null && child.signalCode === null`. That is exact and has no start-up window at all. Fall back to pid + token only for handles re-attached from `state.json` after a host restart. Factor this into one private helper so the two call sites cannot drift.

### 2. Never launch over a child that is still alive

`dropStaleHandle`'s NOTE already says a re-spawn over a live child will bind-clash and that callers must not do it — but nothing enforces it, and arm 1's bug is exactly a caller getting "not running" wrong. Enforce it in `createContainer` (and `ensureOwnerNode`) **before** the drop, in the async part that precedes the synchronous drop → launch window:

- If any existing handle for the container id has a live child (same helper as arm 1), throw `container <id> is still running`.
- Otherwise, if any handle's pid is still alive (token unverified — a re-attached handle mid-startup, or a recycled pid), probe-bind the ports that would be reused (`reusedNodePorts`) on the address the child binds (`0.0.0.0` for health/metrics/p2p/ws; the admin port is loopback) and throw an `EADDRINUSE`-style error naming the port if any is taken. Do **not** kill the pid on this evidence alone — an unverified pid may belong to an unrelated process.

Throwing before the drop means nothing is released, no token is rotated, and `DonationService.respawn`'s existing failure path runs: the record keeps its old `dockerId`/`seedEndpoint`/`seedToken`, the attempt is counted, and backoff applies. Once the first child finishes starting, `isRunning` turns true and `refillBudgetIfHealthy` clears the count. Keep the comments on `dropStaleHandle` / `restoreDroppedHandles` in step (their NOTEs describe the unenforced precondition this arm now enforces).

### 3. A crash loop must reach give-up even when every spawn "succeeds"

In `DonationSupervisor.reconcileOne`, when the node is not running and the record's `respawn.attempts` has already reached `DONATION_RESPAWN_MAX_ATTEMPTS`, call `giveUp` instead of attempting again. Today give-up is only reachable from `attemptRespawn`'s `catch`, so a node that spawns and immediately dies (bad config, port clash, crash on boot) is respawned forever at the 5-minute backoff cap. Keep the existing catch-path check too. Update the `DONATION_RESPAWN_MAX_ATTEMPTS` docstring and the supervisor section of `docs/cadre-host.md` to say the cap counts every attempt, successful spawn or not.

### 4. Make a rejected seed diagnosable

- `packages/cadre-cli/src/server/health.ts` `handleSeedRequest`: log (via the existing `debug` logger and a `console.error` line, matching the other seed events in `start.ts`) when a `/seed` request is refused for a bad/missing bearer. Log that it was refused and why (missing header vs mismatch) — never the presented token.
- `DonationService.applySeed`: when the node answers 401, the fault is the host's token bookkeeping, not the requester's seed. Map it to a distinct message (e.g. `Donated node rejected the host's seed credential (401)`) so the log and the host's error body stop reading as "would not accept this cadre's seed". Keep the `seed_failed` code unless a distinct code is cheap to surface in `reference-app-rn/src/host-node-request.ts`; decide in implementation and note which.

## Tests

- `orchestrator.test.ts`: the reproduction above as a regression test — `isRunning` is true during the start-up window for a child spawned by this orchestrator; a second `createContainer` for that id throws and leaves the first handle, its ports and its token file untouched.
- `orchestrator.test.ts`: re-attached handle (new orchestrator instance over the same `rootDir`, first child still starting) + `createContainer` → throws on the port probe, nothing dropped.
- `donation-supervisor.test.ts`: a record whose spawns "succeed" but whose node is never running reaches `error` after `DONATION_RESPAWN_MAX_ATTEMPTS` passes (drive with the fake orchestrator and the injectable clock).
- `donation-service.test.ts`: a failed respawn (orchestrator throws) leaves `seedToken`/`seedEndpoint`/`dockerId` unchanged — likely already covered; confirm.
- Remember the Windows cwd lock when cleaning temp dirs in child-spawning tests (see `debt-cadre-host-tests-leak-child-processes` in backlog).

## TODO

- Arm 1: move the startup-token write in `cadre-cli/src/commands/start.ts` ahead of the health server and `node.start()`; update option help text.
- Arm 1: add a private "child is alive" helper in `HostProcessOrchestrator` (child object when present, else pid + token) and use it in `isRunning` and the `ensureOwnerNode` short-circuit.
- Arm 2: pre-drop guard in `createContainer` and `ensureOwnerNode` — throw if a same-id handle is alive; port-probe when only the pid is alive; keep the drop → launch window synchronous.
- Arm 2: update the NOTEs on `dropStaleHandle` / `restoreDroppedHandles` to reflect the enforced precondition.
- Arm 3: give-up check in `DonationSupervisor.reconcileOne` before attempting a respawn; update docstring and `docs/cadre-host.md`.
- Arm 4: log refused `/seed` requests in `cadre-cli/src/server/health.ts`; distinct 401 message in `DonationService.applySeed`.
- Add the tests listed above; run `yarn workspace @serfab/cadre-host test` and `yarn workspace @serfab/cadre-cli test` (after rebuilding stale optimystic dist if the guard complains), plus `yarn lint`.
