description: cadre-host mistook a donated node that was still starting up for a dead one and started a second copy on the same ports; the copy crashed, but the host had already swapped in a new seed password, so the running node refused every seed and the loan was stuck. Fixed the liveness check, added a guard against starting over a live node, made the restart loop give up, and made a refused seed diagnosable.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/port-probe.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/server/bearer.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-host/src/donation/donation-supervisor.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/__tests__/orchestrator.test.ts, packages/cadre-host/src/__tests__/orchestrator-owner.test.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-cli/test/bearer.spec.ts, packages/cadre-cli/test/health-server.spec.ts, docs/cadre-host.md
----

# Complete: a donated node still starting is no longer respawned over itself

## The incident (2026-09-16, donor mode, Windows)

A phone's donated node came up healthy; cadre-host then launched a second process for the same container, which died with `EADDRINUSE`. The donation record held a new `seedToken` (and kept rotating it), the live node answered every host `POST /seed` with `401`, and the loan stayed `awaiting_seed` forever.

Root cause: `HostProcessOrchestrator.isRunning` required the `.startup-token` file, which `cadre-cli start` wrote only after `node.start()` resolved — after its ports were bound. A supervisor sweep in that window saw "not running", and `DonationService.respawn` → `createContainer` dropped the old handle, reused its ports, rotated the tokens and returned success before the second child died. Give-up was only reachable when `respawn` threw, so a spawn that "succeeds" and then dies looped forever.

## What landed

- **Liveness.** `cadre-cli start` writes the startup token as its first step (`writeStartupToken`). `isHandleLive(handle)` answers from the spawned `ChildProcess` (no exit seen, pid alive) and falls back to pid + token only for handles re-attached from `state.json`. Used by `init`, `isRunning`, `ensureOwnerNode`'s short-circuit and the guard.
- **Guard.** `refuseRespawnOverLiveChild` runs as the last `await` before the handle drop in `createContainer` and `ensureOwnerNode`: a live owned child is refused outright; a re-attached handle with a live but unverified pid bind-probes the ports the re-spawn would reuse (`port-probe.ts` `assertPortFree`; admin on 127.0.0.1 for the owner). A refusal releases nothing and rotates nothing.
- **Give-up.** `DonationSupervisor.reconcileOne` gives up when it finds the node down with `DONATION_RESPAWN_MAX_ATTEMPTS` already recorded, so spawn-then-die loops end.
- **Diagnostics.** `bearerRefusal` (`missing`/`mismatch`); the node logs a refused `/seed` with the reason only; the host reports a node `401` as `seed_failed` "Donated node rejected the host's seed credential (401)" (code kept so the phone's 30 s `seed_failed` retry still applies).
- `docs/cadre-host.md` supervisor section describes all of the above.

## Review findings

Read the implement diff (`0e2afaa`) in full before the handoff, then the surrounding orchestrator code (spawn paths, `stopContainer`, `restartOwnerNode`, the child exit listener), the supervisor's reconcile/backoff/refill code, host startup (`bin/host.ts` owner spawn) and the node-lifecycle routes (`server/routes/nodes.ts`).

**Correctness — no defects found.**
- `isHandleLive` for owned children: traced `stopContainer` → `restartOwnerNode`/`ensureOwnerNode` and the `/api/nodes/:id/{start,restart}` routes. After a stop the pid is dead, so the guard neither refuses nor probes; restart is unaffected (existing `restartOwnerNode` test still passes).
- `ensureOwnerNode`'s short-circuit now treats a still-starting owned owner child as live. Correct for idempotency; the owner admin client reads the endpoint lazily, so nothing treats it as readiness.
- Host startup: a guard refusal of the owner node at boot is caught by `bin/host.ts`'s best-effort try/catch and logged; the management API stays up.
- Supervisor ordering (give-up check before the backoff check): after a successful 5th respawn whose child exits at once, the exit-triggered pass gives up. The two tests that pre-seeded attempts at the cap were correctly moved to `MAX - 1`.
- `bearerRefusal` checks the header before the empty configured token; `checkBearer`'s boolean result is unchanged (existing empty-token tests cover it).

**Test coverage.** The implementer covered both guard arms for `createContainer`, supervisor give-up for spawn-then-die, the 401 mapping and bearer/health logging. Gap: nothing exercised the guard in `ensureOwnerNode`, including the owner-only loopback admin binding. **Fixed inline:** added `orchestrator-owner.test.ts` "refuses to re-spawn over a re-attached owner whose admin port is still bound" (asserts the refusal names the admin port on 127.0.0.1, the handle is kept, the pid is not killed).

**Tripwires recorded (NOTE at site).**
- Give-up after host downtime — a record at the cap whose last respawn was up but not yet refilled is given up on host restart: NOTE in `donation-supervisor.ts` `reconcileOne`.
- One unthrottled stderr line per refused `/seed`, so a client hammering the endpoint fills the node log (bounded by the orchestrator's size rotation): NOTE on `logSeedRefusal` in `cadre-cli/src/server/health.ts`.
- Already parked by the implementer and agreed with: a re-attached child still loading modules (no token, no bound port yet), and the bind-probe's momentary hold on each port — both NOTEs on `refuseRespawnOverLiveChild`.

**Considered, no action.**
- Guard refusals count toward the give-up budget (a re-attached child from an older `cadre-cli` that writes its token late would be refused 5 times over about 150 s, then stopped). Only reachable mid-upgrade with a child taking over 150 s to write its token; not worth extra state.
- A re-attached handle's `alive` flag stays `false` after its token appears — pre-existing, untouched by this diff.
- Source hygiene: `host-process-orchestrator.ts` is large, but this diff shrank `isRunning` and extracted `handlesFor`, `childPortBindings` and `port-probe.ts`; no size-debt ticket. Comments are long but each documents a non-obvious invariant.
- Security: refusal logs never include the presented token (tested).

**Docs.** `docs/cadre-host.md` reflects the liveness rule, guard, give-up and 401 message; grep found no other doc describing the old "token after `node.start()`" timing. The `--startup-token-file` option help text is updated.

**Validation.**
- `yarn workspace @serfab/cadre-host test` → 68 files, 650 passed / 4 skipped.
- `yarn workspace @serfab/cadre-cli vitest run test/bearer.spec.ts test/health-server.spec.ts` → 24 passed. The full cadre-cli suite's two `one-shot-node.spec.ts` failures are already listed in `tickets/.pre-existing-known.md` under blocked `warm-restart-into-declared-schema-diverges-from-declaration`.
- `yarn lint` clean. `cadre-cli build` and `cadre-host build:server` rebuilt for the stale-build guard.
- **Not run:** the real-network integration scenarios (`cadre-host-donation-phone-requester`, `cadre-host-node-donation`, `cadre-host-owner-node`) and a replay of the Windows incident against a real `cadre-cli` child. Run them once the integration stale-build guard is clear (it was blocked by an uncommitted edit in `../quereus`).
