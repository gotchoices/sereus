description: On a machine that once ran its own cadre and was then switched to donating only, the management API will still start that old personal node again if asked, bringing back a cadre the owner turned off.
files: packages/cadre-host/src/server/routes/nodes.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/bin/host.ts, docs/cadre-host.md
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Reaching it needs a founder install switched to donor-only and then an explicit start call (the dashboard stops offering the button once feat-cadre-host-donor-aware-ui lands), so a maintainer may judge the remaining HTTP/CLI path too narrow to be worth a role check in the nodes route.
----

# Owner node can be restarted after the own-cadre role is turned off

## Situation

cadre-host runs its own personal cadre (an "owner node" plus trust circle and NAT) only when `ownCadre.enabled` is true in `host.config.json`. When that flag is turned off after a previous founder run, `cadre-host start` takes the donor-only branch in `src/bin/host.ts`, which calls `orchestrator.stopOwnerNode()` so the disabled cadre is actually stopped.

`stopOwnerNode` → `stopContainer` only marks the handle `alive = false` and persists it; the handle and the saved `OwnerSpawnConfig` stay. So after the switch:

- `GET /api/nodes` still lists the owner node, as `stopped` with `owner: true`.
- `POST /api/nodes/owner/start` (and `/restart`) takes the owner branch in `src/server/routes/nodes.ts`: `isOwnerNode` is true and `hasOwnerConfig()` is true, so it calls `orchestrator.ensureOwnerNode()` and the owner node runs again — with no trust circle, NAT or strand service wired, which is exactly the state the donor branch in `host.ts` stops it to avoid.

`docs/cadre-host.md` → "Honest gaps" claims that in donor-only mode these calls "no-op gracefully"; that holds only for an install that never ran as a founder (no saved config → 501).

Inferred from reading the code, not run. Confirm by starting a host with `ownCadre.enabled: true`, restarting it with the flag false, then `POST /api/nodes/owner/start` and checking that a child process spawns.

## Expected

In donor-only mode, owner start/restart is refused (e.g. `409` or `501` with a message saying the host's own cadre is turned off and how to turn it on), and the docs' "Honest gaps" bullet says so. Whether the stopped owner handle should also be hidden from `/api/nodes` in donor mode is part of the same decision.

## Related

`feat-cadre-host-donor-aware-ui` hides the Start/Restart/Stop buttons for the owner node on a donor host, so the dashboard no longer offers this; the HTTP route and anything scripting it still do. That ticket adds a `role` to `/api/status` derived from whether the founder services were wired at start — the same fact the nodes route would need to check.
