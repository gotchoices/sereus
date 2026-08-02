description: The self-hosted manager used to hand its own entire environment to every node it launched, so a single setting meant for the manager could silently reconfigure — or misconfigure — all of its child nodes at once. Fixed by stripping every `CADRE_*` variable from the manager's environment before spawning a child.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/__tests__/orchestrator-env-scrub.test.ts, docs/cadre-host.md
---

# What shipped

`HostProcessOrchestrator.launchChild` built each child's environment as
`{ ...process.env, ...extraEnv, <fixed per-child vars> }`. `cadre-cli` treats
an inherited `CADRE_*` var as a config override that *beats* the per-child
`cadre.json` the orchestrator writes, so any such var set on the manager
process reconfigured every child it spawned — e.g. a `CADRE_PARTY_ID` on the
manager pulling all children into that party.

Now `launchChild` spreads `scrubbedParentEnv()` instead of raw `process.env`:
a copy of `process.env` with **every `CADRE_`-prefixed key deleted**. Applied
after it, unchanged: `opts.extraEnv` (e.g. `CADRE_OWNER_KEYS` for donated
nodes) and the fixed per-child vars (`CADRE_STARTUP_TOKEN`,
`CADRE_HEALTH_PORT`, `CADRE_METRICS_PORT`, `CADRE_LISTEN_ADDRS`,
`CADRE_SEED_TOKEN`, `CADRE_NODE_STATE_DIR`) — so both still always win. Non-
`CADRE_` vars (`PATH`, `NODE_OPTIONS`, `DEBUG`, `HOME`/`APPDATA`, proxy/TLS)
pass through untouched: a denylist, not an allowlist. Both spawn paths
(`createContainer` for donated/generic nodes, `ensureOwnerNode` for the host's
own owner node) route through `launchChild`, so both are covered with no
special-casing.

Documented in `docs/cadre-host.md` (child-identity/state section): a child's
configuration comes only from its own config file plus the vars the
orchestrator sets for it.

# Review findings

## Checked

Read the implement diff (`443cfca`) before the handoff summary. Aspect passes:
correctness of the scrub set, DRY/drift risk, coupling to `cadre-cli`
internals, resource cleanup, error handling, type safety, test coverage
(happy path / leak-through / pass-through), source hygiene (function size,
comment intent), docs accuracy. Ran `yarn workspace @serfab/cadre-host test`,
`yarn workspace @serfab/cadre-host build`, `yarn lint`.

## Fixed in this pass (minor)

- **The denylist was incomplete — `CADRE_ADMIN_PORT` still leaked.** The
  implementation scrubbed `Object.keys(ENV_MAPPINGS)` plus a hand-maintained
  `ORCHESTRATOR_ENV_VARS` list. `CADRE_ADMIN_PORT` is in neither, yet
  `packages/cadre-cli/src/commands/start.ts:305` reads it directly
  (`process.env.CADRE_ADMIN_PORT ?? options.adminPort`). Set on the manager, it
  would push every child at the same admin port — the exact bug class this
  ticket exists to close. Two-key list maintenance is also inherently
  drift-prone: any future `CADRE_*` var in `cadre-cli` reintroduces the leak by
  omission. Replaced both lists with a prefix scrub (delete every key starting
  with `CADRE_`). Verified nothing a child needs arrives by inheritance:
  children take config from their `cadre.json` plus the vars set explicitly at
  spawn, and the only other `CADRE_*` vars in the repo are `CADRE_HOST_*`
  (read by the manager's own `bin/host.ts`, never by a child). Side benefit:
  drops the `ENV_MAPPINGS` import, so `cadre-host` no longer couples to a
  `cadre-cli` data table for this.
- **Test extended** to set `CADRE_ADMIN_PORT` on the test process and assert it
  is absent in the child — a key deliberately outside `ENV_MAPPINGS`, so the
  test fails if the scrub is ever narrowed back to a key list. The `DEBUG`
  pass-through assertion still guards the other direction.
- **Docs were silent on child env construction.** Added a paragraph to
  `docs/cadre-host.md` stating the rule, why it exists, what still passes
  through, and that new `cadre-cli` vars are covered automatically.

## Checked, no action

- **Implementer's open item: does `cadre-provider` have the same leak?** No.
  `packages/cadre-provider/src/service/docker-orchestrator.ts` builds the
  container's `Env` as an explicit array of literals — it never spreads
  `process.env`, and Docker does not inherit the daemon client's environment.
  No ticket filed.
- **Implementer's open item: no test for two orchestrators / manager env
  changing between spawns.** `scrubbedParentEnv()` snapshots and deletes per
  call, so there is no cached state to go stale. Agreed with the implementer
  that a test here would assert a property of `{ ...process.env }` rather than
  of this code.
- **Implementer's open item: per-key coverage of every `ENV_MAPPINGS` entry.**
  Moot — the scrub is no longer keyed off that table.
- `NODE_OPTIONS` is still composed from the *raw* `process.env.NODE_OPTIONS`
  (heap-limit append). Intentional and correct: it is not a `CADRE_*` var and
  inheriting the operator's node flags is the wanted behavior.
- Comment on `CADRE_NODE_STATE_DIR` correctly downgraded from "this is the
  defense" to "belt and suspenders" now that the scrub is the primary defense.

## Major findings (new tickets)

None. The one real defect found (`CADRE_ADMIN_PORT`) resolved at the same code
site as the change under review, so it was fixed in this pass rather than
filed.

## Tripwires

None recorded. No concern here is conditional-on-a-future-state — the scrub is
either complete or it is not, and the prefix rule makes it complete by
construction.

# Validation

- `yarn workspace @serfab/cadre-host test` — 60 files, 512 passed / 4 skipped,
  0 failed (includes the extended env-scrub test and `orchestrator-pin-keys`,
  which proves `extraEnv`/`CADRE_OWNER_KEYS` still threads through post-scrub).
- `yarn workspace @serfab/cadre-host build` — clean.
- `yarn lint` — clean, exit 0.
