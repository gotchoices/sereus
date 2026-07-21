description: Made cadre-host default to just donating nodes to friends, with running your own personal cadre on the machine now an explicit opt-in instead of the assumed main job.
files: packages/cadre-host/src/installer/config.ts, packages/cadre-host/src/installer/wizard.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/server/routes/status.ts, packages/cadre-host/src/server/routes/settings.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-cli/src/commands/start.ts, docs/cadre-host.md

# Complete: demote the host-as-founder path

## What shipped

cadre-host's **node-donor** role (spawn nodes for other people's cadres) is now the
always-on default. Running the host's **own** personal cadre (the "founder" role:
owner node + trust circle + NAT) is opt-in behind `ownCadre.enabled` in
`host.config.json` (default false). The founder machinery was retained, not deleted —
simply gated off by default ("demote, don't delete").

- **The flag** — optional `ownCadre?: { enabled: boolean }` on `HostConfigFile`
  (absent ⇒ donor-only). Reader accessor `hostOwnsCadre(cfg)` is the single gate.
  No version bump / migration; pre-existing v2 configs read back cleanly.
- **Install** — wizard asks "Also run your own personal cadre on this machine?"
  (default no); non-interactive path takes `--own-cadre`. Installer always writes
  `ownCadre: { enabled: <answer> }`.
- **The gate (`bin/host.ts start`)** — donor stack (orchestrator, GrantService +
  `/grants-admin`, **DonationService + `/grants` + reap sweep**, management server)
  always up; founder stack (`ensureOwnerNode`, `OwnerNodeClient`, `TrustCircleService`,
  `NatService`, invite-address push, `natService.start()`) behind `if (hostOwnsCadre)`.
- **Graceful no-owner surfaces** — `trustCircle` + `nat` are now optional deps of
  `createLocalUiServer` / `registerStatusRoute` / `registerSettingsRoutes`. Donor-only:
  `/auth/*` and `/nat/*` unmounted → 404; `/api/status` omits `trustCircle` +
  `connectivity`; `upnpEnabled` writes persist but skip NatService propagation.
- **Settings guard** — `ownCadre` added to `FORBIDDEN_KEYS`; `PUT /api/settings`
  with it → 400 (install-time only).
- **Docstring/doc reframes** — orchestrator `buildOwnerChildConfig`, `cadre-cli
  start --owner` help, and `docs/cadre-host.md` ("Two roles: donor and founder"
  section + whitelist table + start description + honest gaps).

## Integration note (prereq resolved)

`prereq: donation-service` has since **fully landed** (implement `d977c30`, review
`40321bd`, both after this ticket's implement `9e2740a`). At HEAD the donor stack in
`bin/host.ts start` includes `DonationService` + the stale-`awaiting_seed` reap sweep
+ the grantee-facing `/grants` route, all in the always-up block, with **no**
owner-node coupling — exactly the shape the implement handoff's "gap #1" asked the
reviewer to confirm. Confirmed. The `docs/cadre-host.md` "everything below is founder"
line the demote diff added was also correctly superseded by the donor-docs
realignment tickets (the Node-donation section now sits below Two-roles and is
labelled as the donor role).

## Validation (all green at HEAD)

- `yarn workspace @serfab/cadre-host build` ✓ (tsc + vite SPA).
- `yarn workspace @serfab/cadre-host test` ✓ — **448 passed, 3 skipped** (the 3 skips
  are pre-existing, unrelated).
- `yarn workspace @serfab/cadre-cli test` ✓ — 94 passed.
- `yarn lint` ✓ (exit 0).

## Review findings

Adversarial pass over the implement diff (`9e2740a`) read at HEAD, then every touched
file + the surfaces it *should* have touched.

### Correctness / gating — checked, sound

- **The gate itself** (`bin/host.ts`): donor stack unconditional, founder stack behind
  `hostOwnsCadre(cfg)`, optional-dep threading into `createLocalUiServer`, `natService?`
  shutdown. All coherent. `installId` is used as a cadre **party id** only inside the
  `hostOwnsCadre` branch (host.ts:335) — grepped every `installId` use; a pure-donor
  host never uses it as a party id, and it is not leaked into donated-node configs.
  Handoff gap #4 confirmed clean.
- **Config shape / round-trip**: `hostOwnsCadre`, absent-is-donor-only, and
  malformed-shape rejection are covered and pass. No migration needed — correct.
- **Settings guard**: `ownCadre` rejected with 400 `invalid_setting`. (Note: it was
  already unreachable via `WRITABLE_TOP_KEYS`; adding it to `FORBIDDEN_KEYS` only
  upgrades the error message. Harmless, intentional.)
- **Status / settings optional deps**: omit correctly in donor mode; SSE connectivity
  publish guarded on `opts.nat`. Fine.

### Fixed inline (minor)

- **Toggle-off owner-node reap** (`bin/host.ts` donor branch). The implementer parked
  this as a `NOTE:` tripwire: if `ownCadre` is toggled off after a founder run, a
  still-running owner child is re-attached by `orchestrator.init()` and lingers
  unmanaged for the whole session (serving the host's own cadre despite being
  disabled), only reaped at shutdown. That is a real behavioural inconsistency the
  moment that path runs, not merely conditional — so I converted the NOTE into an
  actual `await orchestrator.stopOwnerNode()` in the donor branch. `stopOwnerNode()`
  is a safe no-op when no owner exists, and it does not delete the workdir/control-DB,
  so toggling `ownCadre` back on re-spawns from saved config. Rebuilt ✓.

### Filed as new ticket (major — overlooked surface)

- **`backlog/feat-cadre-host-donor-aware-ui`** — the local UI SPA (`ui/`) was not
  updated for donor-only mode (the new default). Server side is honest (404s +
  omitted status fields) and nothing crashes (SPA seeds safe defaults + guards), but
  a default install's dashboard shows a permanently "Loading connectivity…" tile and
  two nav pages (Trust Circle, Connectivity) that error-toast on open. Filed as a
  backlog `feat-` (UX-completeness for the new default role, not a crash/correctness
  defect). Suggested adding an explicit role flag to `/api/status` rather than
  inferring donor-mode from field absence.

### Tripwires — none newly recorded

The one conditional concern (toggle-off re-attach) was promoted to a real fix rather
than left as a tripwire, so no `NOTE:` remains at that site.

### Docs — checked, up to date

Read every file the change touched plus `docs/architecture.md` STATUS/CLI sections and
the SPA. `docs/cadre-host.md` anchors (`#two-roles-donor-and-founder`,
`#node-donation-the-primary-role`, `#write-whitelist-for-apisettings`) resolve;
whitelist table lists `ownCadre`; the donor/founder split is consistent with
`architecture.md`. No stale "host is the founder" claims remain.

### Pre-existing failures — none surfaced

Full cadre-host + cadre-cli suites and lint ran clean; the only skips (3) are
pre-existing and outside this diff.
