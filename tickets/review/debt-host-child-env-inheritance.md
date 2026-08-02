description: The self-hosted manager used to hand its own entire environment to every node it launches, so a single setting meant for the manager could silently reconfigure — or misconfigure — all of its child nodes at once. Fixed by scrubbing the manager's `CADRE_*` config-override vars before spawn.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/__tests__/orchestrator-env-scrub.test.ts
difficulty: easy
---

# What changed

`HostProcessOrchestrator.launchChild` (`packages/cadre-host/src/orchestrator/host-process-orchestrator.ts`)
used to build each child's environment as `{ ...process.env, ...extraEnv,
<fixed per-child vars> }`. Any `CADRE_*` var set on the manager process leaked
into every spawned child, and `@serfab/cadre-cli`'s `ENV_MAPPINGS` table turns
an inherited var into a config override that beats the per-child config file
the orchestrator writes — so e.g. a `CADRE_PARTY_ID` set on the manager would
silently pull every child into that party.

Fix, following the plan in the superseded ticket:

1. Imports `ENV_MAPPINGS` from `@serfab/cadre-cli` (already an existing
   dependency of `cadre-host`, already exported from `@serfab/cadre-cli`'s
   `src/config/index.ts`).
2. Adds a module-level `ORCHESTRATOR_ENV_VARS` list — the env-only vars the
   orchestrator itself sets per child that have no `ENV_MAPPINGS`
   config-file equivalent: `CADRE_STARTUP_TOKEN`, `CADRE_HEALTH_PORT`,
   `CADRE_METRICS_PORT`, `CADRE_SEED_TOKEN`, `CADRE_OWNER_KEYS`.
3. Adds `scrubbedParentEnv()` — copies `process.env` and deletes every key in
   `ENV_MAPPINGS` and `ORCHESTRATOR_ENV_VARS`.
4. `launchChild`'s env-object construction now spreads `scrubbedParentEnv()`
   instead of raw `process.env`. `opts.extraEnv` and the fixed per-child vars
   (`CADRE_STARTUP_TOKEN`, `CADRE_HEALTH_PORT`, `CADRE_METRICS_PORT`,
   `CADRE_LISTEN_ADDRS`, `CADRE_SEED_TOKEN`, `CADRE_NODE_STATE_DIR`) are still
   spread after it in the same object literal, so they're unaffected and
   still always win.
5. Everything NOT in `ENV_MAPPINGS` / `ORCHESTRATOR_ENV_VARS` (`PATH`,
   `NODE_OPTIONS`, `DEBUG`, `HOME`/`APPDATA`, proxy/TLS vars, etc.) still
   flows through untouched — this is a denylist, not an allowlist.
6. Both spawn paths (`createContainer` → donated/generic nodes, and
   `ensureOwnerNode` → the host's own owner node) go through the same
   `launchChild`, so both get the same scrub with no special-casing needed.
7. `extraEnv` (e.g. `CADRE_OWNER_KEYS` for donated/foreign-party nodes) still
   wins over the scrub, applied by the orchestrator after it, same as before.

# Testing performed

New test: `packages/cadre-host/src/__tests__/orchestrator-env-scrub.test.ts`,
following the fake-CLI-script pattern from
`packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts` (a small
`.mjs` script driven through the real `HostProcessOrchestrator` + `spawn`,
which records what it sees in `process.env` to a file).

- Sets `CADRE_PARTY_ID` and `CADRE_STORAGE_PATH` on the **test process's
  own** `process.env` before constructing the orchestrator, spawns two
  children via `createContainer` with different `partyId`s, and asserts
  each child's recorded `CADRE_PARTY_ID` / `CADRE_STORAGE_PATH` is absent
  (`null` in the JSON the fake CLI writes) — proving the scrub removed the
  vars rather than merely being overridden by luck of key order.
- Also sets `DEBUG` on the test process and asserts it **does** reach the
  child — proving the fix scrubs only the config-override keys, not the
  whole environment.

Ran and passing:
- `yarn workspace @serfab/cadre-host test` — 60 test files, 512 passed / 4
  skipped (0 failed), including the new test file and the existing
  `orchestrator-pin-keys.test.ts` (proves `extraEnv`/`CADRE_OWNER_KEYS`
  still threads through correctly post-scrub).
- `yarn workspace @serfab/cadre-host build` (`tsc -p tsconfig.build.json &&
  vite build`) — clean, no type errors.
- `yarn lint` (repo-wide) — clean, exit 0.

# Known gaps / things the reviewer should double check

- No test spawns TWO orchestrators or restarts one mid-test with a changed
  `process.env`, so the "manager env changes between spawns" case isn't
  separately exercised — only "manager env is bad for the whole process
  lifetime" is covered. Judged low-value to add given the scrub itself is a
  pure snapshot-and-delete per call.
- Didn't add a test asserting the FULL set of `ENV_MAPPINGS` keys is
  individually scrubbed (only `CADRE_PARTY_ID` + `CADRE_STORAGE_PATH` were
  exercised as representative samples) — the scrub loop is generic
  (`Object.keys(ENV_MAPPINGS)`), so per-key coverage would be testing the
  data table more than the logic, but call it out in case the reviewer
  wants belt-and-suspenders coverage of e.g. `CADRE_IDENTITY_PROTOBUF` or
  `CADRE_PUSH` specifically.
- Did not touch `packages/cadre-provider` (the Docker-based multi-tenant
  orchestrator) — out of scope per the original ticket, which targeted only
  `cadre-host`'s process-based orchestrator. If `cadre-provider` has an
  analogous env-passthrough, it wasn't investigated here.
