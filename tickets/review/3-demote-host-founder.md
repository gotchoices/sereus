----
description: Review the change that makes cadre-host default to just donating nodes to friends, with running your own personal cadre now an explicit opt-in instead of the assumed main job.
prereq: donation-service
files: packages/cadre-host/src/installer/config.ts, packages/cadre-host/src/installer/wizard.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/server/routes/status.ts, packages/cadre-host/src/server/routes/settings.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-cli/src/commands/start.ts, docs/cadre-host.md
difficulty: hard
----

# Review: demote the host-as-founder path

## What changed (implement summary)

cadre-host was built around the assumption that the host machine **founds and owns
a cadre**. This ticket demotes that: the **node-donor** role (spawn nodes for
*other people's* cadres) is now the always-on default, and the host running its
**own** personal cadre (the "founder" role: owner node + trust circle + NAT) is an
**opt-in** gated by a new `ownCadre.enabled` flag (default false). Nothing was
deleted — the founder machinery is retained and simply gated off by default (the
"demote, don't delete" decision from the source ticket).

### The flag

- **`installer/config.ts`** — new optional `ownCadre?: { enabled: boolean }` on
  `HostConfigFile` (absent ⇒ donor-only). Reader accessor **`hostOwnsCadre(cfg)`** is
  the single source of truth for the gate. `isHostConfigShape` validates the shape
  when present; **no version bump / migration** — pre-existing v2 configs (field
  absent) read back cleanly as donor-only.
- **`installer/wizard.ts` / `installer/index.ts` / `bin/host.ts install`** — wizard
  asks *"Also run your own personal cadre on this machine?"* (default no); the
  non-interactive path takes **`--own-cadre`**. The installer always writes
  `ownCadre: { enabled: <answer> }`.
- **Settings write-whitelist** (`server/routes/settings.ts`) — `ownCadre` added to
  `FORBIDDEN_KEYS`, so `PUT /api/settings { ownCadre }` → 400 (install-time only).

### The gate (`bin/host.ts start`)

Restructured so the **donor stack + management server are always up**, and the
**founder stack is behind `if (hostOwnsCadre(cfg))`**:

- Always: orchestrator init, `GrantService` (+ `/grants-admin`), management server.
- Founder only: `ensureOwnerNode`, `OwnerNodeClient`, `TrustCircleService`,
  `NatService`, invite-address push, `natService.start()`.
- Donor-only: **no owner node, no NatService** (donor nodes are loopback-only in v1;
  per-node WAN reachability is deferred to
  `backlog/feat-cadre-host-wan-grant-reachability`).

### Graceful no-owner surfaces

- **`server/index.ts`** — `trustCircle` + `nat` are now **optional**
  `createLocalUiServer` deps. When absent, `/auth/*` and `/nat/*` are **left
  unmounted**, so they fall through to the static not-found handler and **404**
  (honest surface — see `static.ts`, which already 404s `/auth|/nat|/update|/api`).
- **`server/routes/status.ts`** — `trustCircle` + `nat` optional; the response
  **omits** `trustCircle` and `connectivity` in donor-only mode.
- **`server/routes/settings.ts`** — `nat` optional; an `upnpEnabled` write still
  persists to `host.config.json` but skips NatService propagation when there's none.

### Docstring reframes (the drift the source plan flagged)

- **`orchestrator` `buildOwnerChildConfig`** — reworded from "it is the founding
  node" to: this is the **host's own personal cadre** owner node (founder persona,
  opt-in); **donated nodes are generic** (`createContainer`/`buildChildConfig`), join
  the *requester's* cadre, and pin the *requester's* owner key.
- **`cadre-cli start --owner`** help — clarified: founder-persona owner of *this
  node's own* cadre, NOT a donated node.
- **`docs/cadre-host.md`** — new "Two roles: donor and founder" section; whitelist
  table + `start` description + honest-gaps updated.

## How to validate

### Automated (all run green here)

- `yarn workspace @serfab/cadre-provider build` (regenerates dist — see gap #1)
- `yarn workspace @serfab/cadre-host build` ✓ and `test` ✓ — **424 passed, 3 skipped**
  (the 3 skips are pre-existing, unrelated to this diff).
- `yarn workspace @serfab/cadre-cli build` ✓ + `test` ✓ (90 passed).
- `yarn lint` ✓.

New/updated unit coverage worth re-reading:
- `server/__tests__/server.smoke.test.ts` → **donor-only describe**: no owner node,
  `POST /grants-admin` issues a grant, `GET /nat/status` 404, `/auth/*` 404,
  `/api/status` omits `trustCircle` + `connectivity`.
- `server/__tests__/status-route.test.ts` → donor-only status omits fields.
- `server/__tests__/settings-route.test.ts` → `PUT ownCadre` → 400 `invalid_setting`.
- `installer/__tests__/config.test.ts` → `ownCadre` round-trip, `hostOwnsCadre`
  accessor, absent-is-donor-only, malformed-shape rejected.
- `installer/__tests__/wizard.test.ts` + `installer.smoke.test.ts` → opt-in wiring;
  install writes `ownCadre.enabled` false by default / true with the flag.

### Manual / exploratory use cases

1. **Fresh donor-only install (the common case):** `cadre-host install
   --non-interactive` (no `--own-cadre`) → `host.config.json` has
   `ownCadre.enabled=false`. `cadre-host start` → log says "node-donor mode"; no owner
   node; `cadre-host grant issue "Alice"` works; `curl /nat/status` and `curl
   /auth/trust-circle` → 404.
2. **Founder install:** `cadre-host install --own-cadre` → `ownCadre.enabled=true`.
   `start` spawns the owner node; trust circle + NAT active exactly as before.
3. **Settings guard:** `PUT /api/settings {"ownCadre":{"enabled":true}}` → 400.

## Honest gaps & things to probe (treat my tests as a floor)

1. **Prereq `2-donation-service` has NOT fully landed.** Its **Phase 1** (provider
   `OrchestratorCreateRequest.pinnedOwnerKeys` + `HostProcessOrchestrator.createContainer`
   wiring) *is* committed at HEAD — that's why a **`yarn workspace @serfab/cadre-provider
   build` is required** (host typechecks against provider's built `.d.ts`; the dist was
   stale). But its **Phase 2/3 are absent**: `donation/donation-service.ts`, the
   grantee-facing **public `/grants` provisioning route**, and the **reap sweep** do not
   exist yet. So the ticket's phrase "donor stack always up incl. donationService +
   `/grants` + reap" is only **partially** realized here: I kept `GrantService` +
   `/grants-admin` + the management server always up (the region donation-service will
   extend). My donor-only test asserts **`/grants-admin`** works, *not* `POST /grants`
   (that public route isn't in the tree). **Reviewer:** when donation-service lands,
   confirm its `donationService`/reap/`/grants` slot into the always-up block in
   `bin/host.ts start` without re-introducing owner-node coupling.
2. **Owner-node integration suites not run here** (real network / slow, and the repo's
   control-DB integration failures are pre-existing/blocked). `cadre-host-owner-node.integration.ts`
   and `cadre-host-bootstrap.integration.ts` wire the founder stack **directly** (not via
   the flag), so they still exercise the opt-in persona and compile against the now-optional
   `createLocalUiServer` signatures. Run them if a network is available.
3. **Toggle-off re-attach (conditional — parked as a `NOTE:`).** If `ownCadre` is toggled
   *off* after a founder run and the owner child is still alive, `orchestrator.init()`
   re-attaches it: it shows in `listNodes` but has no trust-circle/NAT wired.
   `stopOwnerNode()` on shutdown reaps it, so it's harmless now — recorded as a `NOTE:` at
   the donor-mode branch in `bin/host.ts` (not filed as a ticket). Probe if you think an
   operator would be surprised.
4. **`installId` semantics.** Still minted at install; used as a cadre **party id** only
   when founder-enabled. A pure-donor host never uses it as a party id, and it is not
   leaked into donated-node configs (donated nodes carry the requester's `partyId` via
   `createContainer`). Worth a spot-check that no path reads `cfg.installId` as a party id
   outside the `hostOwnsCadre` branch.

## Review disposition

Minor findings → fix inline. Anything about the missing donation-service Phase 2/3
surface belongs to that ticket (don't re-file). Route genuinely new work to `fix/` or
`backlog/` with a clear slug.
