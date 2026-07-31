import { describe, it, expect, vi } from 'vitest';
import type Docker from 'dockerode';
import { DockerOrchestrator, volumeNameFor } from '../docker-orchestrator.js';
import type { DockerConfig } from '../../config/types.js';
import type { OrchestratorCreateRequest } from '../orchestrator.js';
import { volumeStubs, type VolumeStubs } from './fake-docker.js';

const request: OrchestratorCreateRequest = {
  containerId: 'ctr_vol',
  partyId: 'party-1',
  bootstrapNodes: [],
  profile: 'storage',
};

const volumeName = volumeNameFor(request.containerId);

function config(): DockerConfig {
  return { image: 'test-image', portRange: { start: 13000, end: 13099 } };
}

/** Fake dockerode Container handle: inspect/remove as removeContainer needs; stats/logs
 * stubbed only so the shape matches dockerode's Container interface. */
function fakeContainerHandle(opts: {
  labels?: Record<string, string>;
  mounts?: Array<{ Type: string; Name?: string; Destination: string }>;
  inspect?: ReturnType<typeof vi.fn>;
  remove?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    inspect: opts.inspect ?? vi.fn(async () => ({
      Config: { Labels: opts.labels ?? {} },
      Mounts: opts.mounts ?? [],
    })),
    remove: opts.remove ?? vi.fn(async () => {}),
    stats: vi.fn(),
    logs: vi.fn(),
  };
}

/** Handle a successful `createContainer` resolves to — only `id`/`start` are exercised. */
function createdContainer(id: string) {
  return { id, start: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
}

/** Orchestrator over a fake daemon carrying `vol`'s volume surface plus the given container calls. */
function orchestratorOver(
  vol: VolumeStubs,
  calls: { createContainer?: unknown; getContainer?: unknown } = {}
): DockerOrchestrator {
  const docker = {
    createContainer: calls.createContainer ?? vi.fn(),
    getContainer: calls.getContainer ?? vi.fn(),
    ...vol,
  } as unknown as Docker;
  return new DockerOrchestrator(config(), docker);
}

const createFails = () => vi.fn(async () => { throw new Error('boom'); });

describe('DockerOrchestrator durable volume wiring', () => {
  it('mounts a fresh named volume at /data and labels it on create', async () => {
    const vol = volumeStubs();
    const createContainer = vi.fn(async (spec: {
      HostConfig: { Mounts: Array<{ Type: string; Source: string; Target: string }> };
    }) => {
      void spec;
      return createdContainer('cid-1');
    });

    await orchestratorOver(vol, { createContainer }).createContainer(request);

    expect(vol.createVolume).toHaveBeenCalledWith({
      Name: volumeName,
      Labels: { 'sereus.container-id': request.containerId, 'sereus.party-id': request.partyId },
    });

    const opts = createContainer.mock.calls[0]![0];
    expect(opts.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: volumeName, Target: '/data' }]);
  });

  it('reuses a pre-existing volume instead of creating one', async () => {
    const vol = volumeStubs([volumeName]);
    const createContainer = vi.fn(async () => createdContainer('cid-2'));

    await orchestratorOver(vol, { createContainer }).createContainer(request);

    expect(vol.createVolume).not.toHaveBeenCalled();
  });

  // An inspect that fails for any reason OTHER than 404 must not be read as
  // "absent": creating over a volume that does exist, or deleting on the failure
  // path below, would destroy a tenant's identity. Failing the provision is the
  // cheap outcome, so the error propagates untouched.
  it('aborts the provision when the volume inspect fails for a non-404 reason', async () => {
    const vol = volumeStubs([volumeName]);
    vol.getVolume.mockImplementation(() => ({
      inspect: async () => { throw Object.assign(new Error('daemon unreachable'), { statusCode: 500 }); },
    }));
    const createContainer = vi.fn(async () => createdContainer('cid-3'));

    await expect(orchestratorOver(vol, { createContainer }).createContainer(request))
      .rejects.toThrow('daemon unreachable');

    expect(vol.createVolume).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
    expect(vol.volumes.has(volumeName)).toBe(true);
    expect(vol.removed).toEqual([]);
  });

  it('removes the volume it created when the create attempt fails', async () => {
    const vol = volumeStubs();

    await expect(orchestratorOver(vol, { createContainer: createFails() }).createContainer(request))
      .rejects.toThrow('boom');

    expect(vol.volumes.has(volumeName)).toBe(false);
    expect(vol.removed).toContain(volumeName);
  });

  it('leaves a pre-existing volume alone when a recreate attempt fails (image-upgrade case)', async () => {
    const vol = volumeStubs([volumeName]);

    await expect(orchestratorOver(vol, { createContainer: createFails() }).createContainer(request))
      .rejects.toThrow('boom');

    expect(vol.volumes.has(volumeName)).toBe(true);
    expect(vol.removed).not.toContain(volumeName);
  });

  it('removeContainer reads Mounts via inspect, force-removes, then removes the named volume', async () => {
    const vol = volumeStubs([volumeName]);
    const removeSpy = vi.fn(async () => {});
    const handle = fakeContainerHandle({
      labels: { 'sereus.container-id': request.containerId },
      mounts: [{ Type: 'volume', Name: volumeName, Destination: '/data' }],
      remove: removeSpy,
    });

    await orchestratorOver(vol, { getContainer: vi.fn(() => handle) }).removeContainer('docker-id-1');

    expect(handle.inspect).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith({ force: true, v: true });
    expect(vol.removed).toContain(volumeName);
  });

  it('terminates cleanly when the volume is already gone', async () => {
    const vol = volumeStubs(); // not seeded — getVolume().remove() throws a 404
    const handle = fakeContainerHandle({
      labels: { 'sereus.container-id': request.containerId },
      mounts: [{ Type: 'volume', Name: volumeName, Destination: '/data' }],
    });

    await expect(orchestratorOver(vol, { getContainer: vi.fn(() => handle) }).removeContainer('docker-id-2'))
      .resolves.toBeUndefined();
  });

  it('removes no named volume for a legacy container with no matching label/mount', async () => {
    const vol = volumeStubs();
    const handle = fakeContainerHandle({ labels: {}, mounts: [] });

    await orchestratorOver(vol, { getContainer: vi.fn(() => handle) }).removeContainer('docker-id-3');

    expect(vol.removed).toEqual([]);
  });

  // An unreadable container must still be reaped: the volume name is unknown, so it
  // is left behind rather than guessed at, but the container removal proceeds.
  it('still force-removes the container when the pre-removal inspect fails', async () => {
    const vol = volumeStubs([volumeName]);
    const removeSpy = vi.fn(async () => {});
    const handle = fakeContainerHandle({
      inspect: vi.fn(async () => { throw new Error('no such container'); }),
      remove: removeSpy,
    });

    await orchestratorOver(vol, { getContainer: vi.fn(() => handle) }).removeContainer('docker-id-4');

    expect(removeSpy).toHaveBeenCalledWith({ force: true, v: true });
    expect(vol.removed).toEqual([]);
  });
});
