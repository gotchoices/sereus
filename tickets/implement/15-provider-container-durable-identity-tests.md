---
description: The fix that lets a hosted customer node keep one network identity across restarts is written and working, but it still needs automated tests and a documentation update so the behaviour cannot quietly break again.
files: packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/test/env-override-empty.spec.ts, packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/fake-docker.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, docs/architecture.md, docs/STATUS.md
difficulty: easy
---

# Durable container identity — remaining tests + docs

The behaviour change from `provider-container-durable-identity` **has landed**; this
ticket is only the test coverage and docs that the budget cut short. Nothing here changes
runtime behaviour.

## What already landed (do not redo)

**`packages/cadre-cli/docker/entrypoint.sh`**
- `create_identity` now runs *before* the `generate_config` guard, so the key file exists
  when the `identity:` block is written.
- `CADRE_KEY_FILE` and `CADRE_NODE_STATE_DIR` are now `export`ed (POSIX `sh` does not
  export a plain assignment, which is why the started node never saw them). The env value
  is the authoritative source — `applyEnvironmentOverrides` re-applies it over the loaded
  config every start, so it also repairs containers whose `cadre.yaml` predates the fix.
- The `start` branch logs the resolved identity path and node-state dir.

**`packages/cadre-provider/src/service/docker-orchestrator.ts`**
- Exported `volumeNameFor(containerId)` → `cadre-<containerId>-data`.
- `ensureVolume` inspects first; a pre-existing volume is reused and reported as
  not-created, so the failure path never destroys the state of a container being
  recreated. A non-404 inspect error is rethrown rather than guessed at.
- `HostConfig.Mounts` mounts that volume at `/data`; the volume carries
  `sereus.container-id` / `sereus.party-id` labels.
- The create failure path removes the volume only when that attempt created it.
- `removeContainer` reads the container's `Mounts` via `inspect` *before* removal, removes
  the container with `{ force: true, v: true }`, then removes the matching named volume;
  volume-removal failure is logged and swallowed.

**`packages/cadre-provider/src/types.ts` / `container-service.ts`**
- `Container.peerId?: string`.
- `waitForEnrollment` now polls `/status` through `fetchContainerHealthStatus` (same helper
  `getPeerInfo` uses) instead of raw `/health`, and stamps `peerId` on the record via a new
  optional `patch` argument on `updateStatus`. `getPeerInfo` still reads live — multiaddrs
  genuinely change.

**`packages/cadre-provider/src/service/__tests__/fake-docker.ts`** (new, not a suite)
- `volumeStubs(existing?)` — in-memory `createVolume` / `getVolume` with a
  dockerode-shaped 404 for a missing volume. Already spread into the fake dockers in
  `orchestrator-port-leak.test.ts` and `docker-orchestrator-push.test.ts`.

### Verification already performed

- `yarn typecheck` and `yarn test` in `packages/cadre-provider`: clean, 97/97 passing.
- The entrypoint was run by hand under `sh` with a stub `node` on `PATH`. Observed: key
  created first, `identity: keyFile: <data>/cadre-peer.key` present in the generated
  config, `CADRE_KEY_FILE` and `CADRE_NODE_STATE_DIR` both visible to the started child,
  and a second start reusing the same key. That manual run is what the entrypoint test
  below should automate.

## TODO

### Entrypoint test — `packages/cadre-cli/test/entrypoint.spec.ts`

`cadre-cli`'s vitest config collects `test/**/*.spec.ts`. Gate the whole suite on `sh`
being runnable (`spawnSync('sh', ['-c', 'echo ok'])`) so it skips rather than fails on a
Windows dev box without Git Bash.

Recipe (verified by hand — reproduce it in the test):

- Temp dir with a `bin/node` stub, `chmod +x`, shebang `#!/bin/sh`. `$1` is the cadre.js
  path, `$2` the subcommand. For `enroll` it parses `--output`/`--name` and writes
  `<output>/<name>.key`; for `start` it echoes `CHILD_KEY_FILE=${CADRE_KEY_FILE:-<UNSET>}`
  and `CHILD_STATE_DIR=${CADRE_NODE_STATE_DIR:-<UNSET>}`.
- Set `PATH`, `DATA_DIR`, `CADRE_PARTY_ID`, `CADRE_BOOTSTRAP_NODES` *inside* the shell
  (`sh -c '<script>' sh <tmp> <entrypoint>`), not through node's `env` — passing a
  POSIX-style `PATH` across the Windows/MSYS boundary gets mangled. Convert Windows paths
  to `/c/...` form for the two positional args.

Assert: the child sees `CADRE_KEY_FILE` pointing at a file that exists; the generated
`cadre.yaml` carries the `identity:` block with that path; `CADRE_NODE_STATE_DIR` equals
the data dir; and a second run reuses the same key file byte-for-byte.

### Provider volume tests — `packages/cadre-provider/src/service/__tests__/docker-orchestrator-volume.test.ts`

Use `volumeStubs` from `./fake-docker.js` (already written). Cover:

- the `createContainer` call carries `HostConfig.Mounts` = one `Type: 'volume'` entry with
  `Source: cadre-<containerId>-data`, `Target: '/data'`, and `createVolume` was called with
  the `sereus.container-id` label;
- a pre-existing volume (seed `volumeStubs([name])`) is reused — `createVolume` not called;
- a create that fails removes the volume that attempt made;
- a create that fails against a *pre-existing* volume leaves it alone (this is the
  image-upgrade case — deleting it would destroy the tenant's identity);
- `removeContainer` calls `remove({ force: true, v: true })` and then removes the named
  volume, having read `Mounts` from `inspect` first;
- a container whose volume is already gone still terminates cleanly (the stub's `remove`
  throws a 404);
- a legacy container (inspect returns no `sereus.container-id` label / no matching mount)
  removes no named volume.

The fake `getContainer(id)` must return an object with `inspect`, `remove`, `stats`, `logs`
as needed — the existing tests only stub `getContainer: vi.fn()`, so this file needs a
richer one.

### ContainerService peerId test — `packages/cadre-provider/src/service/__tests__/container-peer-id-record.test.ts`

Follow the shape of `container-provision-cleanup.test.ts` (it drives the private
`provisionContainer` through a typed cast and stubs `globalThis.fetch`). Cover:

- a `/status` payload with `status: 'healthy'` and a `peerId` leaves the stored record at
  `status: 'running'` with that `peerId`;
- `status: 'healthy'` with `peerId: null` still reaches `running`, with `peerId` unset;
- the poll hits the derived `/status` URL, not `/health`.

### Docs

- `docs/architecture.md` — the durable-identity and cold-start-retry bullets currently
  describe cadre-host only. Extend them to the container path: the node mints its own key
  into a per-container named Docker volume on first start, keeps it for the life of that
  volume, and the bootstrap-peer store and trusted-owner anchor ride along on the same
  volume.
- `docs/STATUS.md` — record that the provider-side equivalent of the donated-node identity
  fix has landed.

## Out of scope

Seed *trust* is a separate defect with its own ticket (`provider-owner-key-pinning`) — a
provider container still rejects every seed regardless of this work. Do not conflate them.
