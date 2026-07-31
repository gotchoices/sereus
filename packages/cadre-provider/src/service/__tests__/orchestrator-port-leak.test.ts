import { describe, it, expect, vi } from 'vitest';
import type Docker from 'dockerode';
import { DockerOrchestrator } from '../docker-orchestrator.js';
import type { DockerConfig } from '../../config/types.js';
import type { OrchestratorCreateRequest } from '../orchestrator.js';
import { volumeStubs } from './fake-docker.js';

const request: OrchestratorCreateRequest = {
  containerId: 'ctr_1',
  partyId: 'party-1',
  bootstrapNodes: [],
  profile: 'transaction',
};

/** Private surface we read to prove ports were freed back to the allocator. */
type OrchestratorInternal = {
  allocatePorts(count: number): number[];
};

/** DockerConfig with a tiny port range so a single leak exhausts the pool. */
function config(start: number, end: number): DockerConfig {
  return { image: 'test-image', portRange: { start, end } };
}

/** The subset of dockerode's create options this test asserts on. */
type CreateOpts = {
  Env: string[];
  HostConfig: { PortBindings: Record<string, Array<{ HostIp?: string; HostPort: string }>> };
};

describe('DockerOrchestrator port-leak on provisioning failure', () => {
  it('releases all ports when docker.createContainer rejects', async () => {
    let fail = true;
    const fakeDocker = {
      createContainer: vi.fn(async () => {
        if (fail) throw new Error('docker create failed');
        return { id: 'cid-ok', start: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
      }),
      getContainer: vi.fn(),
      ...volumeStubs(),
    } as unknown as Docker;

    // Exactly 3 ports: a leak from the first attempt would exhaust the range.
    const orch = new DockerOrchestrator(config(10000, 10002), fakeDocker);

    await expect(orch.createContainer(request)).rejects.toThrow('docker create failed');

    // Ports were freed — a second (non-failing) create still finds 3 ports.
    fail = false;
    const result = await orch.createContainer(request);
    expect(result.dockerId).toBe('cid-ok');
  });

  it('releases ports and force-removes the partial container when start rejects', async () => {
    let startFails = true;
    const removeSpy = vi.fn(async () => {});
    const fakeDocker = {
      createContainer: vi.fn(async () => ({
        id: 'cid-partial',
        start: vi.fn(async () => {
          if (startFails) throw new Error('start failed');
        }),
        remove: removeSpy,
      })),
      getContainer: vi.fn(),
      ...volumeStubs(),
    } as unknown as Docker;

    const orch = new DockerOrchestrator(config(10000, 10002), fakeDocker);

    await expect(orch.createContainer(request)).rejects.toThrow('start failed');
    // The created-but-unstarted container's reserved name + labels are freed.
    expect(removeSpy).toHaveBeenCalledWith({ force: true });

    // Ports freed too: a retry within the tiny range succeeds.
    startFails = false;
    const result = await orch.createContainer(request);
    expect(result.dockerId).toBe('cid-partial');
  });

  it('releases partially-allocated ports when the range cannot satisfy the request', async () => {
    const createSpy = vi.fn();
    const fakeDocker = { createContainer: createSpy, getContainer: vi.fn(), ...volumeStubs() } as unknown as Docker;

    // Only 2 ports available, but createContainer needs 3.
    const orch = new DockerOrchestrator(config(10000, 10001), fakeDocker);

    await expect(orch.createContainer(request)).rejects.toThrow('No available ports in range');
    // Allocation failed before reaching Docker.
    expect(createSpy).not.toHaveBeenCalled();

    // Both briefly-taken ports are back: a fresh 2-port allocation succeeds.
    expect(() => (orch as unknown as OrchestratorInternal).allocatePorts(2)).not.toThrow();
  });

  it('records ports and returns endpoints on success without any cleanup', async () => {
    const removeSpy = vi.fn(async () => {});
    const fakeDocker = {
      createContainer: vi.fn(async () => ({
        id: 'cid-1',
        start: vi.fn(async () => {}),
        remove: removeSpy,
      })),
      getContainer: vi.fn(),
      ...volumeStubs(),
    } as unknown as Docker;

    const orch = new DockerOrchestrator(config(10000, 10002), fakeDocker);

    const result = await orch.createContainer(request);
    expect(result.dockerId).toBe('cid-1');
    expect(result.healthEndpoint).toMatch(/^http:\/\/localhost:\d+\/health$/);
    expect(result.seedEndpoint).toMatch(/\/seed$/);
    expect(removeSpy).not.toHaveBeenCalled();

    // The 3 ports are now held/recorded — the range is exhausted on the next create.
    await expect(orch.createContainer(request)).rejects.toThrow('No available ports in range');
  });

  it('injects a per-container seed token and confines the seed/metrics ports to loopback', async () => {
    const createSpy = vi.fn(async (_opts: CreateOpts) => ({
      id: 'cid-secure',
      start: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    }));
    const fakeDocker = { createContainer: createSpy, getContainer: vi.fn(), ...volumeStubs() } as unknown as Docker;

    const orch = new DockerOrchestrator(config(10000, 10002), fakeDocker);
    const result = await orch.createContainer(request);

    // A non-empty, high-entropy token comes back for applySeed to present.
    expect(result.seedToken).toEqual(expect.any(String));
    expect(result.seedToken.length).toBeGreaterThan(20);

    const opts = createSpy.mock.calls[0]![0];

    // The same token is injected as CADRE_SEED_TOKEN so the container can gate POST /seed.
    expect(opts.Env).toContain(`CADRE_SEED_TOKEN=${result.seedToken}`);

    const bindings = opts.HostConfig.PortBindings;
    // Health (which also serves the authenticated seed route) and metrics are
    // loopback-only; the p2p port stays reachable on all interfaces for libp2p.
    expect(bindings['8080/tcp']![0]!.HostIp).toBe('127.0.0.1');
    expect(bindings['9090/tcp']![0]!.HostIp).toBe('127.0.0.1');
    expect(bindings['4001/tcp']![0]!.HostIp).toBeUndefined();
  });
});
