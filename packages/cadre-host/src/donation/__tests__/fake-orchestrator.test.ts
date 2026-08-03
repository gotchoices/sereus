/**
 * Contract tests for `FakeOrchestrator` itself — the handle lifecycle it borrows
 * from `HostProcessOrchestrator`. The donation suites lean on these semantics to
 * express races that only exist because the real class drops and rejects
 * handles, so this file exists to stop a later relaxation of the fake from
 * quietly turning one of those tests green. Each case names the real behaviour
 * it mirrors.
 */

import { describe, expect, it } from 'vitest';

import type { OrchestratorCreateRequest } from '@serfab/cadre-provider';

import { FakeOrchestrator } from './fake-orchestrator.js';

const request = (containerId: string): OrchestratorCreateRequest => ({
  containerId,
  partyId: 'party-P',
  bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq'],
  profile: 'storage',
});

describe('FakeOrchestrator handle lifecycle', () => {
  it('drops the prior handle when a re-spawn succeeds (mirrors dropStaleHandle)', async () => {
    const orch = new FakeOrchestrator();
    const first = await orch.createContainer(request('grn_1'));
    const second = await orch.createContainer(request('grn_1'));

    await expect(orch.stopContainer(first.dockerId)).rejects.toThrow(
      `Container not found: ${first.dockerId}`,
    );
    // The rejected call left no trace: `stopped` records handles acted on, not
    // calls attempted.
    expect(orch.stopped).toEqual([]);
    // …and the container now resolves only to the new spawn.
    expect(orch.resolveDockerId('grn_1')).toBe(second.dockerId);

    await orch.stopContainer(second.dockerId);
    expect(orch.stopped).toEqual([second.dockerId]);
  });

  it('drops only the re-spawned container, leaving another container untouched', async () => {
    const orch = new FakeOrchestrator();
    const other = await orch.createContainer(request('grn_2'));
    await orch.createContainer(request('grn_1'));
    await orch.createContainer(request('grn_1'));

    // The real drop filters on containerId; a fake that cleared the whole map
    // would still pass every same-container case above.
    await expect(orch.stopContainer(other.dockerId)).resolves.toBeUndefined();
    expect(orch.resolveDockerId('grn_2')).toBe(other.dockerId);
  });

  it('keeps the prior handle live across the whole pre-drop await window', async () => {
    const orch = new FakeOrchestrator();
    const first = await orch.createContainer(request('grn_1'));

    // The invariant the donation race tests rest on: a concurrent stop started
    // from `onCreate` still finds the old handle. Deferring it onto a microtask
    // puts it strictly after `onCreate` returns and strictly before the
    // `createDelayMs` timer, so this one case pins the drop behind BOTH — with
    // no dependence on wall-clock timing. The outcome is captured rather than
    // rethrown so a regression fails this assertion instead of surfacing as an
    // unhandled rejection.
    orch.createDelayMs = 1;
    let outcome: Promise<string> | undefined;
    orch.onCreate = () => {
      outcome ??= Promise.resolve()
        .then(() => orch.stopContainer(first.dockerId))
        .then(() => 'stopped', (err: Error) => `rejected: ${err.message}`);
    };

    const second = await orch.createContainer(request('grn_1'));

    expect(await outcome).toBe('stopped');
    expect(orch.stopped).toEqual([first.dockerId]);
    expect(orch.resolveDockerId('grn_1')).toBe(second.dockerId);
  });

  it('leaves the prior handle in place when the re-spawn fails (mirrors restoreDroppedHandles)', async () => {
    const orch = new FakeOrchestrator();
    const first = await orch.createContainer(request('grn_1'));

    orch.failCreate = true;
    await expect(orch.createContainer(request('grn_1'))).rejects.toThrow('spawn boom');

    // Host state is exactly as the failed attempt found it — which is what lets
    // `DonationSupervisor.giveUp` still stop the child it knows about.
    await expect(orch.stopContainer(first.dockerId)).resolves.toBeUndefined();
    expect(orch.stopped).toEqual([first.dockerId]);
    expect(orch.resolveDockerId('grn_1')).toBe(first.dockerId);
  });

  it('rejects a never-issued dockerId (mirrors requireHandle)', async () => {
    const orch = new FakeOrchestrator();

    await expect(orch.removeContainer('dock_nope')).rejects.toThrow(
      'Container not found: dock_nope',
    );
    expect(orch.removed).toEqual([]);
  });

  it('rejects a second call once a handle has been removed (mirrors removeContainer deleting it)', async () => {
    const orch = new FakeOrchestrator();
    const { dockerId } = await orch.createContainer(request('grn_1'));

    await orch.removeContainer(dockerId);
    expect(orch.removed).toEqual([dockerId]);

    await expect(orch.stopContainer(dockerId)).rejects.toThrow(
      `Container not found: ${dockerId}`,
    );
    expect(orch.stopped).toEqual([]);
  });

  it('fires onStop for a rejected stop, so a test can still observe the attempt', async () => {
    const orch = new FakeOrchestrator();
    const attempted: string[] = [];
    orch.onStop = (id) => { attempted.push(id); };

    await expect(orch.stopContainer('dock_nope')).rejects.toThrow('Container not found');
    expect(attempted).toEqual(['dock_nope']);
    expect(orch.stopped).toEqual([]);
  });

  it('fires onSpawned after the drop, with the new handle live and the old one gone', async () => {
    const orch = new FakeOrchestrator();
    const first = await orch.createContainer(request('grn_1'));

    let observed: { spawned: string; resolves: string | undefined } | undefined;
    orch.onSpawned = (dockerId) => {
      observed = { spawned: dockerId, resolves: orch.resolveDockerId('grn_1') };
    };
    const second = await orch.createContainer(request('grn_1'));

    // The post-drop world: the container already resolves to the new handle, so
    // work driven from here sees what `abandonRespawn`'s caller would see.
    expect(observed).toEqual({ spawned: second.dockerId, resolves: second.dockerId });
    expect(second.dockerId).not.toBe(first.dockerId);
  });
});
