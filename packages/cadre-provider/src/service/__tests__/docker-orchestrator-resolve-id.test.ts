/**
 * `DockerOrchestrator.resolveDockerId` is how the reap finds a container the
 * provider lost the id for — a provider that died mid-provision never wrote one.
 * It must ask the daemon (labels survive a provider restart; the in-memory port
 * map does not) and must not report a daemon failure as "nothing there".
 */

import { describe, it, expect, vi } from 'vitest';
import type Docker from 'dockerode';
import { DockerOrchestrator } from '../docker-orchestrator.js';
import type { DockerConfig } from '../../config/types.js';

function config(): DockerConfig {
  return { image: 'test-image', portRange: { start: 13200, end: 13299 } };
}

/** Fake daemon whose `listContainers` answers from a fixed label → id table. */
function orchestratorOver(
  byLabel: Record<string, string>,
  listContainers = vi.fn(async (opts: { all?: boolean; filters?: { label?: string[] } }) => {
    const label = opts.filters?.label?.[0] ?? '';
    const id = byLabel[label];
    return id ? [{ Id: id }] : [];
  })
): { orch: DockerOrchestrator; listContainers: ReturnType<typeof vi.fn> } {
  const docker = { listContainers } as unknown as Docker;
  return { orch: new DockerOrchestrator(config(), docker), listContainers };
}

describe('DockerOrchestrator.resolveDockerId', () => {
  it('returns the id of the container wearing the container-id label', async () => {
    const { orch, listContainers } = orchestratorOver({
      'sereus.container-id=ctr_abc': 'docker-abc',
    });

    expect(await orch.resolveDockerId('ctr_abc')).toBe('docker-abc');
    // `all: true` — an orphan to reclaim has usually stopped by now.
    expect(listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['sereus.container-id=ctr_abc'] },
    });
  });

  it('returns undefined when the daemon knows no such container', async () => {
    const { orch } = orchestratorOver({ 'sereus.container-id=ctr_abc': 'docker-abc' });

    expect(await orch.resolveDockerId('ctr_missing')).toBeUndefined();
  });

  // "The daemon could not answer" must never reach the reap as "nothing to reclaim".
  it('rethrows a daemon failure rather than reporting no match', async () => {
    const { orch } = orchestratorOver({}, vi.fn(async () => { throw new Error('daemon unreachable'); }));

    await expect(orch.resolveDockerId('ctr_abc')).rejects.toThrow('daemon unreachable');
  });
});
