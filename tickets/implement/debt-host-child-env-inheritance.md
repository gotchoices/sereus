description: The self-hosted manager hands its own entire environment to every node it launches, so a single setting meant for the manager can silently reconfigure — or misconfigure — all of its child nodes at once.
files: packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-cli/src/config/types.ts
difficulty: easy
---

# Problem

`HostProcessOrchestrator.launchChild` (`packages/cadre-host/src/orchestrator/host-process-orchestrator.ts:436`)
builds each child node's environment as `{ ...process.env, ...extraEnv, <fixed
per-child vars> }`. Every `CADRE_*` var set on the manager process (not just
the ones the orchestrator deliberately sets) leaks into every child. The
cli's `ENV_MAPPINGS` table (`packages/cadre-cli/src/config/types.ts:100`)
turns an inherited var into a config override, and an env override beats the
per-child config file the orchestrator writes — so e.g. a `CADRE_PARTY_ID`
set on the manager silently pulls every child into that party, a
`CADRE_STORAGE_PATH` collapses every child onto one storage directory, a
`CADRE_IDENTITY_PROTOBUF` gives every child the same libp2p peer id. See the
full table of affected vars in the original ticket
(`tickets/plan/22-debt-host-child-env-inheritance.md`, now superseded by this
file).

`ENV_MAPPINGS` is already exported from `@serfab/cadre-cli` (via
`src/config/index.ts` → `export * from './types.js'`), and
`packages/cadre-host` already depends on `@serfab/cadre-cli` (used today for
`resolveCadreCliBin`) — so no new dependency or cli-side export change is
needed, just import and consume it from cadre-host.

# Fix

In `host-process-orchestrator.ts`:

1. Import `ENV_MAPPINGS` from `@serfab/cadre-cli`.
2. Add a module-level list of the env-only vars the orchestrator itself sets
   per child (not present in `ENV_MAPPINGS` because they have no config-file
   equivalent): `CADRE_STARTUP_TOKEN`, `CADRE_HEALTH_PORT`,
   `CADRE_METRICS_PORT`, `CADRE_SEED_TOKEN`, `CADRE_OWNER_KEYS`.
3. Add a helper, e.g.:

   ```ts
   function scrubbedParentEnv(): NodeJS.ProcessEnv {
     const env = { ...process.env };
     for (const key of Object.keys(ENV_MAPPINGS)) delete env[key];
     for (const key of ORCHESTRATOR_ENV_VARS) delete env[key];
     return env;
   }
   ```

4. In `launchChild`, replace the `...process.env` spread with
   `...scrubbedParentEnv()`. Everything after it in the object literal
   (`...opts.extraEnv`, then the fixed `CADRE_STARTUP_TOKEN` /
   `CADRE_HEALTH_PORT` / `CADRE_METRICS_PORT` / `CADRE_LISTEN_ADDRS` /
   `CADRE_SEED_TOKEN` / `CADRE_NODE_STATE_DIR`) is unchanged — those still win
   because they're spread later in the same literal; scrubbing only removes
   what would otherwise leak from the manager's own ambient environment.
   `CADRE_NODE_STATE_DIR` is already covered because it's one of the
   `ENV_MAPPINGS` keys.
5. Leave everything NOT in `ENV_MAPPINGS` / `ORCHESTRATOR_ENV_VARS` flowing
   through untouched — `PATH`, `NODE_OPTIONS`, `DEBUG`, `HOME`/`APPDATA`,
   proxy/TLS vars (`HTTP_PROXY`, `NODE_EXTRA_CA_CERTS`, etc.) all still need
   to reach the child. Don't build an allowlist; build a scrub (deny)list —
   an allowlist would need to be kept in sync with every env var Node itself
   or a future dependency reads, which is a much bigger surface than the
   fixed set of `CADRE_*` config-override keys.
6. The existing `env.NODE_OPTIONS = ...` line already reads
   `process.env.NODE_OPTIONS` directly (not the scrubbed copy) — leave it as
   is; `NODE_OPTIONS` is not a scrubbed key so this is equivalent either way,
   but no need to touch it.

## Test

Add a test (pattern to follow: `packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts`,
which uses a small fake-CLI `.mjs` script that records what it sees in
`process.env` to a file, driven through the real `HostProcessOrchestrator` +
`spawn`).

New test file (or add to an existing one covering `createContainer`):
- Set `CADRE_PARTY_ID=conflicting-party` (and ideally `CADRE_STORAGE_PATH`)
  on the **test process's own** `process.env` before constructing the
  orchestrator.
- Spawn two children via `createContainer` with two different `partyId`
  values.
- Have the fake CLI script write `process.env.CADRE_PARTY_ID` (and any other
  var under test) to a file next to the startup token.
- Assert each child's recorded `CADRE_PARTY_ID` is `undefined`/absent — not
  the conflicting value from the parent — proving the scrub removed it
  rather than merely being overridden by luck of key order.
- Also assert a passthrough var (e.g. set `DEBUG=some:value` on the test
  process and have the fake CLI record it) still reaches the child, so the
  fix is proven to scrub only the config-override keys and not the whole
  environment.

# Edge cases & interactions

- `extraEnv` (e.g. `CADRE_OWNER_KEYS` for donated/foreign-party nodes) must
  still win over the scrub — it's applied by the orchestrator itself, after
  the scrub, same as today.
- The owner-node path (`ensureOwnerNode` → `launchChild`) goes through the
  same `launchChild` and must get the same scrub — no separate code path to
  special-case.
- `ENV_MAPPINGS` keys not currently set on the manager process are inert to
  delete (`delete` on an absent key is a no-op) — no need to guard.
- Don't scrub `CADRE_NODE_STATE_DIR` twice / don't hand-list it in
  `ORCHESTRATOR_ENV_VARS` — it's already a member of `ENV_MAPPINGS`, and the
  orchestrator sets it explicitly per child regardless.
- Verify a non-`CADRE_*` var (`DEBUG`, `PATH`) still passes through after the
  scrub — the point is a denylist of specific keys, not a full environment
  reset.

## TODO

- Import `ENV_MAPPINGS` from `@serfab/cadre-cli` in `host-process-orchestrator.ts`.
- Add `ORCHESTRATOR_ENV_VARS` (or similarly named) list + `scrubbedParentEnv()` helper.
- Replace `...process.env` in `launchChild`'s env-object construction with `...scrubbedParentEnv()`.
- Add/extend a test proving a conflicting `CADRE_PARTY_ID` (and ideally `CADRE_STORAGE_PATH`) on the manager process does NOT leak into a spawned child, while a non-`CADRE_*` var (e.g. `DEBUG`) still does.
- Run `yarn workspace @serfab/cadre-host test` and `yarn lint` for the touched package.
