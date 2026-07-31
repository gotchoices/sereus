---
description: The fix that lets a hosted customer node keep one network identity across restarts is written and working, but it still needs automated tests and a documentation update so the behaviour cannot quietly break again.
files: packages/cadre-cli/docker/entrypoint.sh, packages/cadre-cli/test/entrypoint.spec.ts (new), packages/cadre-provider/src/service/docker-orchestrator.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/__tests__/fake-docker.ts, packages/cadre-provider/src/service/__tests__/docker-orchestrator-volume.test.ts (new), packages/cadre-provider/src/service/__tests__/container-peer-id-record.test.ts (new), docs/architecture.md, docs/STATUS.md
difficulty: easy
---

<!-- resume-note -->
Prior run hit the session's soft token budget partway through the **implement**
stage, after finishing all research/reading but **before writing any of the four
deliverables**. No test files exist yet; no docs edits made yet. Everything below
is fully drafted and verified against the actual landed code (re-read in this
run) — the next agent should be able to write these files close to verbatim,
run the test suites, and move on to review with minimal rediscovery.

Nothing in `packages/cadre-cli/docker/entrypoint.sh`,
`packages/cadre-provider/src/service/docker-orchestrator.ts`,
`packages/cadre-provider/src/service/container-service.ts`,
`packages/cadre-provider/src/types.ts`, or
`packages/cadre-provider/src/service/__tests__/fake-docker.ts` needs to change —
all confirmed already landed exactly as the original ticket described. This is
pure test + docs work.

# Durable container identity — remaining tests + docs

The behaviour change from `provider-container-durable-identity` **has landed**; this
ticket is only the test coverage and docs that a budget cut short (twice now).
Nothing here changes runtime behaviour.

## What already landed (do not redo) — re-verified this run

**`packages/cadre-cli/docker/entrypoint.sh`** (unchanged from prior handoff)
- `create_identity` runs *before* the `generate_config` guard, so the key file exists
  when the `identity:` block is written.
- `CADRE_KEY_FILE` and `CADRE_NODE_STATE_DIR` are `export`ed. `applyEnvironmentOverrides`
  re-applies the env value over the loaded config every start.
- The `start` branch logs the resolved identity path and node-state dir.

**`packages/cadre-provider/src/service/docker-orchestrator.ts`**
- Exported `volumeNameFor(containerId)` → `cadre-<containerId>-data`.
- `ensureVolume` inspects first; a pre-existing volume is reused (returns `false`,
  not-created). A non-404 inspect error is rethrown.
- `HostConfig.Mounts` = `[{ Type: 'volume', Source: volumeNameFor(containerId), Target: '/data' }]`;
  the volume is created with `Labels: { 'sereus.container-id': containerId, 'sereus.party-id': partyId }`.
- The create-failure path removes the volume **only when that attempt created it**
  (`createdVolume` flag) — a pre-existing volume is left alone.
- `removeContainer` reads `Mounts` via `container.inspect()` **before** removal (helper
  `durableVolumesOf`, filters on the `sereus.container-id` label + `/data` destination +
  the expected volume name), removes the container with `{ force: true, v: true }`, then
  removes each matching named volume via `removeVolume` — which swallows and logs any
  removal error (never throws).

**`packages/cadre-provider/src/service/container-service.ts` / `src/types.ts`**
- `Container.peerId?: string` already present.
- `waitForEnrollment` polls `/status` via `fetchContainerHealthStatus` (not raw `/health`);
  on `health.status === 'healthy'` it calls
  `this.updateStatus(containerId, 'running', health.peerId ? { peerId: health.peerId } : undefined)`.
  `updateStatus(id, status, patch?)` does `Object.assign(container, patch)` before stamping
  `status`, so a `peerId: null` health payload correctly leaves `Container.peerId` unset
  (the ternary above only passes a patch object when `health.peerId` is truthy).
- `fetchContainerHealthStatus` (`container-health.ts`) derives the URL via
  `statusUrlFromHealthEndpoint` = `healthEndpoint.replace('/health', '/status')`, and calls
  bare `fetch(url)` with no options — so asserting the mock's call arg is the derived URL
  string is sufficient to prove it hit `/status` not `/health`.

**`packages/cadre-provider/src/service/__tests__/fake-docker.ts`** (already exists, not a suite)
- `volumeStubs(existing?: string[])` → `{ volumes: Set<string>, removed: string[], createVolume, getVolume }`.
  `getVolume(name)` returns `{ name, inspect, remove }` — `inspect` throws a dockerode-shaped
  404 (`{ statusCode: 404 }`) when absent; `remove` throws the same 404 if not present, else
  deletes from `volumes` and pushes to `removed`.

### Reference test patterns already in the repo (read these before writing new ones)
- `packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts` — shows the
  `volumeStubs()` spread pattern into a fake `Docker` object, and the
  `OrchestratorCreateRequest` shape used across these tests.
- `packages/cadre-provider/src/service/__tests__/docker-orchestrator-push.test.ts` — same
  fake-docker pattern, minimal.
- `packages/cadre-provider/src/service/__tests__/container-provision-cleanup.test.ts` — shows
  the `ProvisionInternal` private-cast pattern to drive `ContainerService.provisionContainer`
  directly, `pendingContainer()` / `provisionRequest` / `createResult` fixtures, and stubbing
  `globalThis.fetch` with `afterEach` restore. The new peerId test should follow this file's
  shape closely (same fixtures, same orchestrator stub style).
- `packages/cadre-cli/test/env-override-empty.spec.ts` — style reference only (not a shell
  test); `packages/cadre-cli/vitest.config.ts` collects `test/**/*.spec.ts`.
- `packages/cadre-host/src/__tests__/orchestrator-node-identity.test.ts` — the cadre-host
  analog being extended in docs; NOT a pattern to copy for the entrypoint test (it spawns a
  fake Node CLI directly, not `sh`).

## TODO

### 1. Entrypoint test — `packages/cadre-cli/test/entrypoint.spec.ts` (NEW FILE)

Gate the whole suite on `sh` being runnable so it skips on a Windows box without Git Bash:
`describe.skipIf(!shAvailable())(...)` where `shAvailable()` runs
`spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' })` in a try/catch and checks
`result.status === 0`.

Below is a **fully drafted, ready-to-write** implementation. It was designed against the
exact entrypoint.sh contents re-read this run but has **not been executed** — run it, fix
any shell quoting issues that only show up at runtime (Windows Git Bash / MSYS is finicky),
and iterate.

```ts
/**
 * cadre-cli docker entrypoint identity wiring.
 *
 * Verifies the ordering + export fix from provider-container-durable-identity:
 * `create_identity` runs before `generate_config` (so the `identity:` block is
 * written on first start) and `CADRE_KEY_FILE`/`CADRE_NODE_STATE_DIR` are
 * `export`ed (POSIX `sh` never exposes a plain assignment to the `exec`'d
 * child). Runs the real entrypoint.sh under `sh` against a fake `node` stub on
 * PATH — skipped when `sh` is not runnable (e.g. a Windows box without Git
 * Bash).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypointPath = join(dirname(fileURLToPath(import.meta.url)), '../docker/entrypoint.sh');

function shAvailable(): boolean {
  try {
    const result = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Windows path -> Git-Bash/MSYS posix form (`C:\foo\bar` -> `/c/foo/bar`). Passing a
 * Windows-style path through `sh -c` args mangles it; only the posix form survives. */
function toPosixPath(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/');
  const drive = normalized.match(/^([A-Za-z]):(\/.*)$/);
  return drive ? `/${drive[1]!.toLowerCase()}${drive[2]}` : normalized;
}

const NODE_STUB = `#!/bin/sh
# $1 = cadre.js path (ignored, this is a stub); $2 = subcommand.
shift
cmd="$1"
shift
case "$cmd" in
  enroll)
    shift # 'create'
    output=""
    name=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --output) output="$2"; shift 2 ;;
        --name) name="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    echo "stub-key-material" > "$output/$name.key"
    ;;
  start)
    echo "CHILD_KEY_FILE=\${CADRE_KEY_FILE:-<UNSET>}"
    echo "CHILD_STATE_DIR=\${CADRE_NODE_STATE_DIR:-<UNSET>}"
    ;;
esac
`;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-entrypoint-'));
  const binDir = join(tmpRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  const nodeStub = join(binDir, 'node');
  writeFileSync(nodeStub, NODE_STUB, 'utf8');
  chmodSync(nodeStub, 0o755);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Run the real entrypoint.sh's `start` branch against the fake node stub. */
function runEntrypointStart(): { status: number | null; stdout: string; stderr: string } {
  const tmpPosix = toPosixPath(tmpRoot);
  const entryPosix = toPosixPath(entrypointPath);
  const outerScript = [
    'set -e',
    'export PATH="$1/bin:$PATH"',
    'export DATA_DIR="$1/data"',
    'export CADRE_PARTY_ID="party-1"',
    'export CADRE_BOOTSTRAP_NODES="/ip4/127.0.0.1/tcp/4001"',
    'sh "$2" start',
  ].join('\n');
  const result = spawnSync('sh', ['-c', outerScript, 'sh', tmpPosix, entryPosix], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!shAvailable())('cadre-cli docker entrypoint identity wiring', () => {
  it('creates the identity before the config, exports it to the started child, and records it in cadre.yaml', () => {
    const result = runEntrypointStart();
    expect(result.status, `entrypoint failed: ${result.stderr}`).toBe(0);

    const dataDir = join(tmpRoot, 'data');
    const keyFile = join(dataDir, 'cadre-peer.key');
    expect(readFileSync(keyFile, 'utf8')).toBe('stub-key-material\n');

    const keyFilePosix = `${toPosixPath(dataDir)}/cadre-peer.key`;
    expect(result.stdout).toContain(`CHILD_KEY_FILE=${keyFilePosix}`);
    expect(result.stdout).toContain(`CHILD_STATE_DIR=${toPosixPath(dataDir)}`);

    const config = readFileSync(join(dataDir, 'cadre.yaml'), 'utf8');
    expect(config).toContain('identity:');
    expect(config).toContain(`keyFile: ${keyFilePosix}`);
  });

  it('reuses the same key byte-for-byte on a second start against the same data dir', () => {
    const first = runEntrypointStart();
    expect(first.status).toBe(0);

    const keyFile = join(tmpRoot, 'data', 'cadre-peer.key');
    const before = readFileSync(keyFile);

    const second = runEntrypointStart();
    expect(second.status, `entrypoint failed: ${second.stderr}`).toBe(0);
    expect(second.stdout).toContain('Using existing peer identity');

    const after = readFileSync(keyFile);
    expect(after).toEqual(before);
  });
});
```

Argv trace to sanity-check the stub against `entrypoint.sh`'s actual invocations (both
confirmed by re-reading the file this run):
- `enroll`: `node <cadre.js> enroll create --output <dirname keyfile> --name <basename keyfile .key>`
  → after 2 shifts (cadre.js, then `enroll`→`cmd`) + 1 more inside the `enroll)` branch
  (`create`), `$1` lands on `--output`.
- `start`: `node <cadre.js> start -c <configfile> [--debug]` → after 2 shifts `cmd=start`;
  remaining args are ignored, stub just echoes the two env vars.

If `sh` under test turns out to reject `--output`/`--name` as shown (unlikely, but this
recipe was hand-verified with a *simpler* stub in the original run, not this exact one),
fall back to a case-insensitive positional parse rather than a `while`/`case` flag loop.

### 2. Provider volume tests — `packages/cadre-provider/src/service/__tests__/docker-orchestrator-volume.test.ts` (NEW FILE)

Fully drafted below, built against `volumeStubs` (existing, unchanged) and a new richer
`getContainer` fake (the existing tests only stub `getContainer: vi.fn()`, this file needs
one returning `inspect`/`remove`/`stats`/`logs`).

```ts
import { describe, it, expect, vi } from 'vitest';
import type Docker from 'dockerode';
import { DockerOrchestrator, volumeNameFor } from '../docker-orchestrator.js';
import type { DockerConfig } from '../../config/types.js';
import type { OrchestratorCreateRequest } from '../orchestrator.js';
import { volumeStubs } from './fake-docker.js';

const request: OrchestratorCreateRequest = {
  containerId: 'ctr_vol',
  partyId: 'party-1',
  bootstrapNodes: [],
  profile: 'storage',
};

function config(): DockerConfig {
  return { image: 'test-image', portRange: { start: 13000, end: 13099 } };
}

/** Fake dockerode Container handle: inspect/remove as removeContainer needs; stats/logs
 * stubbed only so the shape matches dockerode's Container interface. */
function fakeContainerHandle(opts: {
  labels?: Record<string, string>;
  mounts?: Array<{ Type: string; Name?: string; Destination: string }>;
  remove?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    inspect: vi.fn(async () => ({
      Config: { Labels: opts.labels ?? {} },
      Mounts: opts.mounts ?? [],
    })),
    remove: opts.remove ?? vi.fn(async () => {}),
    stats: vi.fn(),
    logs: vi.fn(),
  };
}

describe('DockerOrchestrator durable volume wiring', () => {
  it('mounts a fresh named volume at /data and labels it on create', async () => {
    const vol = volumeStubs();
    const createContainer = vi.fn(async () => ({
      id: 'cid-1', start: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    }));
    const fakeDocker = { createContainer, getContainer: vi.fn(), ...vol } as unknown as Docker;
    const orch = new DockerOrchestrator(config(), fakeDocker);

    await orch.createContainer(request);

    const expectedName = volumeNameFor(request.containerId);
    expect(vol.createVolume).toHaveBeenCalledWith({
      Name: expectedName,
      Labels: { 'sereus.container-id': request.containerId, 'sereus.party-id': request.partyId },
    });

    const opts = createContainer.mock.calls[0]![0] as {
      HostConfig: { Mounts: Array<{ Type: string; Source: string; Target: string }> };
    };
    expect(opts.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: expectedName, Target: '/data' }]);
  });

  it('reuses a pre-existing volume instead of creating one', async () => {
    const expectedName = volumeNameFor(request.containerId);
    const vol = volumeStubs([expectedName]);
    const fakeDocker = {
      createContainer: vi.fn(async () => ({ id: 'cid-2', start: vi.fn(async () => {}), remove: vi.fn(async () => {}) })),
      getContainer: vi.fn(),
      ...vol,
    } as unknown as Docker;
    const orch = new DockerOrchestrator(config(), fakeDocker);

    await orch.createContainer(request);

    expect(vol.createVolume).not.toHaveBeenCalled();
  });

  it('removes the volume it created when the create attempt fails', async () => {
    const vol = volumeStubs();
    const fakeDocker = {
      createContainer: vi.fn(async () => { throw new Error('boom'); }),
      getContainer: vi.fn(),
      ...vol,
    } as unknown as Docker;
    const orch = new DockerOrchestrator(config(), fakeDocker);

    await expect(orch.createContainer(request)).rejects.toThrow('boom');

    const expectedName = volumeNameFor(request.containerId);
    expect(vol.volumes.has(expectedName)).toBe(false);
    expect(vol.removed).toContain(expectedName);
  });

  it('leaves a pre-existing volume alone when a recreate attempt fails (image-upgrade case)', async () => {
    const expectedName = volumeNameFor(request.containerId);
    const vol = volumeStubs([expectedName]);
    const fakeDocker = {
      createContainer: vi.fn(async () => { throw new Error('boom'); }),
      getContainer: vi.fn(),
      ...vol,
    } as unknown as Docker;
    const orch = new DockerOrchestrator(config(), fakeDocker);

    await expect(orch.createContainer(request)).rejects.toThrow('boom');

    expect(vol.volumes.has(expectedName)).toBe(true);
    expect(vol.removed).not.toContain(expectedName);
  });

  it('removeContainer reads Mounts via inspect, force-removes, then removes the named volume', async () => {
    const expectedName = volumeNameFor(request.containerId);
    const vol = volumeStubs([expectedName]);
    const removeSpy = vi.fn(async () => {});
    const handle = fakeContainerHandle({
      labels: { 'sereus.container-id': request.containerId },
      mounts: [{ Type: 'volume', Name: expectedName, Destination: '/data' }],
      remove: removeSpy,
    });
    const fakeDocker = { createContainer: vi.fn(), getContainer: vi.fn(() => handle), ...vol } as unknown as Docker;
    const orch = new DockerOrchestrator(config(), fakeDocker);

    await orch.removeContainer('docker-id-1');

    expect(handle.inspect).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith({ force: true, v: true });
    expect(vol.removed).toContain(expectedName);
  });

  it('terminates cleanly when the volume is already gone', async () => {
    const expectedName = volumeNameFor(request.containerId);
    const vol = volumeStubs(); // not seeded — getVolume().remove() throws a 404
    const handle = fakeContainerHandle({
      labels: { 'sereus.container-id': request.containerId },
      mounts: [{ Type: 'volume', Name: expectedName, Destination: '/data' }],
    });
    const fakeDocker = { createContainer: vi.fn(), getContainer: vi.fn(() => handle), ...vol } as unknown as Docker;
    const orch = new DockerOrchestrator(config(), fakeDocker);

    await expect(orch.removeContainer('docker-id-2')).resolves.toBeUndefined();
  });

  it('removes no named volume for a legacy container with no matching label/mount', async () => {
    const vol = volumeStubs();
    const handle = fakeContainerHandle({ labels: {}, mounts: [] });
    const fakeDocker = { createContainer: vi.fn(), getContainer: vi.fn(() => handle), ...vol } as unknown as Docker;
    const orch = new DockerOrchestrator(config(), fakeDocker);

    await orch.removeContainer('docker-id-3');

    expect(vol.removed).toEqual([]);
  });
});
```

### 3. ContainerService peerId test — `packages/cadre-provider/src/service/__tests__/container-peer-id-record.test.ts` (NEW FILE)

Fully drafted below, mirroring `container-provision-cleanup.test.ts`'s fixtures/style.

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import type { Orchestrator, OrchestratorCreateResult } from '../orchestrator.js';
import type { Container, CreateContainerRequest } from '../../types.js';

type ProvisionInternal = {
  provisionContainer(container: Container, request: CreateContainerRequest): Promise<void>;
};

function pendingContainer(overrides: Partial<Container> = {}): Container {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: 'ctr_1',
    customerId: 'cust-1',
    partyId: 'party-1',
    profile: 'transaction',
    status: 'pending',
    resources: {},
    tags: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const provisionRequest: CreateContainerRequest = {
  customerId: 'cust-1',
  partyId: 'party-1',
  bootstrapNodes: [],
  profile: 'transaction',
};

const createResult: OrchestratorCreateResult = {
  dockerId: 'docker-xyz',
  healthEndpoint: 'http://localhost:18080/health',
  metricsEndpoint: 'http://localhost:19090/metrics',
  seedEndpoint: 'http://localhost:18080/seed',
  seedToken: 'seed-token-xyz',
  p2pPort: 14001,
};

function stubOrchestrator(): { orchestrator: Orchestrator; createContainer: ReturnType<typeof vi.fn> } {
  const createContainer = vi.fn(async () => createResult);
  const orchestrator = {
    createContainer,
    removeContainer: vi.fn(async () => {}),
    stopContainer: vi.fn(async () => {}),
    getStats: vi.fn(),
    isRunning: vi.fn(async () => false),
    getLogs: vi.fn(async () => ''),
  } as unknown as Orchestrator;
  return { orchestrator, createContainer };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('ContainerService.provisionContainer peerId recording', () => {
  it('stamps peerId on the record and reaches running when /status reports healthy with a peerId', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    const { orchestrator } = stubOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    globalThis.fetch = vi.fn(async () =>
      ({ ok: true, json: async () => ({ status: 'healthy', peerId: '12D3KooWabc' }) }) as unknown as Response,
    ) as typeof globalThis.fetch;

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('running');
    expect(stored?.peerId).toBe('12D3KooWabc');
  });

  it('reaches running with peerId left unset when /status reports healthy but peerId is null', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    const { orchestrator } = stubOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    globalThis.fetch = vi.fn(async () =>
      ({ ok: true, json: async () => ({ status: 'healthy', peerId: null }) }) as unknown as Response,
    ) as typeof globalThis.fetch;

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('running');
    expect(stored?.peerId).toBeUndefined();
  });

  it('polls the derived /status URL, not /health', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    const { orchestrator } = stubOrchestrator();
    const service = new ContainerService({ store, orchestrator });

    const fetchMock = vi.fn(async () =>
      ({ ok: true, json: async () => ({ status: 'healthy', peerId: '12D3KooWxyz' }) }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:18080/status');
  });
});
```

### 4. Docs

**`docs/architecture.md`** — the long "Cold-start bootstrap retries" bullet under
"Control Network Seed" (search for `> - **Cold-start bootstrap retries.**`, currently around
line 199) ends with a sentence describing `cadre-host`'s per-donated-node identity workdir:
`"...Before that wiring landed, donated nodes were spawned with no identity at all: a fresh
peer id per process, and both stores silently in-memory."` — immediately followed by
`"Persistence is **one injectable seam, not one backend per platform**: ..."`.

Insert a new sentence **between those two**, extending the same durability property to the
multi-tenant Docker provider. Suggested text (adjust wording to fit the surrounding voice,
but keep the concrete facts — volume name, `create_identity` ordering, the env-export/
`applyEnvironmentOverrides` mechanism, and that the bootstrap-peer store + trusted-owner
anchor ride the same volume):

> The multi-tenant `@serfab/cadre-provider` Docker path carries the identical durability
> property via a different substrate: `DockerOrchestrator.createContainer` mounts a
> per-container **named Docker volume** (`cadre-<containerId>-data`, `volumeNameFor`) at
> `/data` — inspected-and-reused rather than recreated on every provision, so an
> image-upgrade recreate keeps the same volume and therefore the same identity — and the
> container's own `docker/entrypoint.sh` mints `cadre-peer.key` into that volume on first
> boot (`create_identity`, run *before* config generation so the generated `cadre.yaml`'s
> `identity:` block can name it) and exports `CADRE_KEY_FILE`/`CADRE_NODE_STATE_DIR` so
> `applyEnvironmentOverrides` re-applies them over the loaded config on every start — the env
> value stays authoritative and repairs a container whose `cadre.yaml` predates this fix.
> `CADRE_NODE_STATE_DIR` defaults to the same `/data` mount, so the bootstrap-peer store and
> trusted-owner anchor ride along on the identical volume and survive a container restart the
> same way the identity key does. `removeContainer` deletes the named volume alongside the
> container, so all of it dies with the tenant's lease — matching the `cadre-host`
> workdir-deletion behavior above.

**`docs/STATUS.md`** — under `## Cadre-host node-donation realignment` (around line 368),
the bullet reads:
```
- [x] Donated nodes hold a durable identity. ... The same gap on the multi-tenant provider is open
  (`tickets/backlog/bug-provider-container-identity-not-persisted.md`).
```
That backlog ticket has since been fixed and shipped (`bug-provider-container-identity-not-persisted`
→ `provider-container-durable-identity`, both already in git history — see `git log --oneline`
for `366c246` and `f01e715`). Replace the "is open" sentence with something like:

> The same gap on the multi-tenant provider has since been closed: `DockerOrchestrator` mounts
> a per-container named Docker volume at `/data` and `docker/entrypoint.sh` mints/exports the
> identity key into it on first boot, re-applying it every start — see
> [Provider Integration](architecture.md#provider-integration) and the "Cold-start bootstrap
> retries" bullet under [Control Network Seed](architecture.md#control-network-seed).

Do not remove the backlog ticket reference's surrounding sentence structure more than
necessary — this is a one-clause edit, not a rewrite.

## Verification steps for the next agent

1. Write the three new test files above.
2. `yarn workspace @serfab/cadre-provider test` (or `cd packages/cadre-provider && yarn test`) —
   expect all prior 97 passing tests plus the ~10 new ones in the two new files.
3. `yarn workspace @serfab/cadre-cli test` — expect the new `entrypoint.spec.ts` suite to run
   (assuming `sh` is available in the execution environment) or skip cleanly (assuming it
   isn't). If it runs and fails on shell quoting, iterate on the script — the underlying
   entrypoint.sh behavior is already hand-verified correct (see original ticket's
   "Verification already performed" note, preserved in git history at commit `f01e715`).
4. `yarn typecheck` in `packages/cadre-provider` and `packages/cadre-cli`.
5. Apply the two docs edits above.

## Out of scope

Seed *trust* is a separate defect with its own ticket (`provider-owner-key-pinning`) — a
provider container still rejects every seed regardless of this work. Do not conflate them.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
