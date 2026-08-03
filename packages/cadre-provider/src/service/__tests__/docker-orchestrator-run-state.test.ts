/**
 * `DockerOrchestrator.inspectRunState` is what tells the provider's enrollment
 * wait that a node crashed instead of merely being slow, so the mapping off
 * Docker's inspect payload — especially Go's zero timestamp — is pinned here.
 */

import { describe, it, expect, vi } from 'vitest';
import type Docker from 'dockerode';
import { DockerOrchestrator } from '../docker-orchestrator.js';
import type { DockerConfig } from '../../config/types.js';

function config(): DockerConfig {
  return { image: 'test-image', portRange: { start: 13100, end: 13199 } };
}

/** Orchestrator over a fake daemon whose `getContainer(...).inspect()` is `inspect`. */
function orchestratorWithInspect(inspect: () => Promise<unknown>): DockerOrchestrator {
  const docker = {
    getContainer: vi.fn(() => ({ inspect })),
  } as unknown as Docker;
  return new DockerOrchestrator(config(), docker);
}

/** Inspect payload shaped like dockerode's, with the State fields we read. */
function inspectPayload(state: {
  Running: boolean;
  ExitCode: number;
  FinishedAt: string;
}, restartCount = 0) {
  return async () => ({ State: state, RestartCount: restartCount });
}

const ZERO_TIME = '0001-01-01T00:00:00Z';

describe('DockerOrchestrator.inspectRunState', () => {
  it('reports a live, never-exited container with no exit fields', async () => {
    const orch = orchestratorWithInspect(
      inspectPayload({ Running: true, ExitCode: 0, FinishedAt: ZERO_TIME })
    );

    const state = await orch.inspectRunState('cid-live');

    expect(state).toEqual({ running: true, restartCount: 0 });
    // Go's zero time parses to a valid year-1 Date; it must NOT read as an exit.
    expect(state?.exitedAt).toBeUndefined();
    expect(state?.exitCode).toBeUndefined();
  });

  it('maps a real exit through, with the restart count', async () => {
    const orch = orchestratorWithInspect(
      inspectPayload({ Running: false, ExitCode: 137, FinishedAt: '2026-06-01T00:00:05.000Z' }, 3)
    );

    const state = await orch.inspectRunState('cid-dead');

    expect(state).toEqual({
      running: false,
      restartCount: 3,
      exitedAt: new Date('2026-06-01T00:00:05.000Z'),
      exitCode: 137,
    });
  });

  it('treats an empty FinishedAt as never-exited', async () => {
    const orch = orchestratorWithInspect(
      inspectPayload({ Running: true, ExitCode: 0, FinishedAt: '' })
    );

    expect(await orch.inspectRunState('cid-blank')).toEqual({ running: true, restartCount: 0 });
  });

  it('resolves undefined when the container is gone (404)', async () => {
    const orch = orchestratorWithInspect(async () => {
      throw Object.assign(new Error('no such container'), { statusCode: 404 });
    });

    expect(await orch.inspectRunState('cid-gone')).toBeUndefined();
  });

  // A daemon outage must never be reported as "the child is fine" — the caller
  // has to be able to tell "cannot see it" from "it is up".
  it('rethrows any inspect failure that is not a 404', async () => {
    const orch = orchestratorWithInspect(async () => {
      throw Object.assign(new Error('daemon unreachable'), { statusCode: 500 });
    });

    await expect(orch.inspectRunState('cid-blip')).rejects.toThrow('daemon unreachable');
  });
});
