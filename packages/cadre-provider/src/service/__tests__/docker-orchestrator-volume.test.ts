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
    const createContainer = vi.fn(async (spec: {
      HostConfig: { Mounts: Array<{ Type: string; Source: string; Target: string }> };
    }) => {
      void spec;
      return { id: 'cid-1', start: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    });
    const fakeDocker = { createContainer, getContainer: vi.fn(), ...vol } as unknown as Docker;
    const orch = new DockerOrchestrator(config(), fakeDocker);

    await orch.createContainer(request);

    const expectedName = volumeNameFor(request.containerId);
    expect(vol.createVolume).toHaveBeenCalledWith({
      Name: expectedName,
      Labels: { 'sereus.container-id': request.containerId, 'sereus.party-id': request.partyId },
    });

    const opts = createContainer.mock.calls[0]![0];
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
