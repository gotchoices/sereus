/**
 * The handle rules `HostProcessOrchestrator` and its test stand-in
 * `FakeOrchestrator` (`donation/__tests__/fake-orchestrator.ts`) must both obey,
 * written once and run against each: `orchestrator.test.ts` registers them over
 * the real class, `fake-orchestrator.test.ts` over the fake. A rule one of them
 * stops obeying fails in that file's run.
 *
 * Not a `.test.ts` file, so vitest does not collect it on its own.
 *
 * Only what both classes can satisfy belongs here — no ports, no files on disk,
 * none of the fake's recording arrays. Those stay in the two calling files.
 */

import { describe, expect, it } from 'vitest';

import type { OrchestratorCreateRequest, OrchestratorCreateResult } from '@serfab/cadre-provider';

import type { HostProcessOrchestrator } from '../orchestrator/host-process-orchestrator.js';

/** What the contract needs from either orchestrator. */
export type ContractOrchestrator = Pick<
  HostProcessOrchestrator,
  'createContainer' | 'stopContainer' | 'removeContainer' | 'resolveDockerId'
>;

export interface HandleContractHarness<O extends ContractOrchestrator> {
  /** A fresh orchestrator. Teardown is the calling file's own afterEach. */
  make(): O;
  request(containerId: string): OrchestratorCreateRequest;
  /** Resolve once the spawn named by `dockerId` can be stopped. */
  started(orch: O, dockerId: string): Promise<void>;
  /**
   * Make `createContainer` for `containerId` throw from here on. Only called
   * after that container has been spawned once and stopped, and no case creates
   * again afterwards.
   */
  failNextCreate(orch: O, containerId: string): void;
}

const CONTAINER = 'grn_contract_a';
const OTHER_CONTAINER = 'grn_contract_b';

export function describeHandleContract<O extends ContractOrchestrator>(
  label: string,
  harness: HandleContractHarness<O>,
): void {
  async function spawn(orch: O, containerId: string): Promise<OrchestratorCreateResult> {
    const result = await orch.createContainer(harness.request(containerId));
    await harness.started(orch, result.dockerId);
    return result;
  }

  // The real class refuses to start a container whose previous child is still
  // alive; the fake does not model that refusal. Stopping first keeps both on
  // the path they share.
  async function respawn(orch: O, containerId: string, previousDockerId: string): Promise<OrchestratorCreateResult> {
    await orch.stopContainer(previousDockerId);
    return spawn(orch, containerId);
  }

  describe(`${label} handle contract`, () => {
    it('rejects a dockerId it never issued', async () => {
      const orch = harness.make();

      await expectNotFound(orch.stopContainer('never-issued'), 'never-issued');
      await expectNotFound(orch.removeContainer('never-issued'), 'never-issued');
    });

    it('rejects a dockerId once its container has been removed', async () => {
      const orch = harness.make();
      const { dockerId } = await spawn(orch, CONTAINER);
      await orch.stopContainer(dockerId);

      await orch.removeContainer(dockerId);

      await expectNotFound(orch.stopContainer(dockerId), dockerId);
      await expectNotFound(orch.removeContainer(dockerId), dockerId);
    });

    it('replaces the first spawn\'s dockerId when the container re-spawns', async () => {
      const orch = harness.make();
      const first = await spawn(orch, CONTAINER);

      const second = await respawn(orch, CONTAINER, first.dockerId);

      await expectNotFound(orch.stopContainer(first.dockerId), first.dockerId);
      expect(orch.resolveDockerId(CONTAINER)).toBe(second.dockerId);
      await expect(orch.stopContainer(second.dockerId)).resolves.toBeUndefined();
    });

    // The drop on re-spawn filters on containerId; an orchestrator that cleared
    // every handle would still pass the same-container case above.
    it('leaves another container\'s dockerId alone when one container re-spawns', async () => {
      const orch = harness.make();
      const other = await spawn(orch, OTHER_CONTAINER);
      const first = await spawn(orch, CONTAINER);

      await respawn(orch, CONTAINER, first.dockerId);

      expect(orch.resolveDockerId(OTHER_CONTAINER)).toBe(other.dockerId);
      await expect(orch.stopContainer(other.dockerId)).resolves.toBeUndefined();
    });

    // What lets a caller still clean up the node it knows about after a re-spawn
    // that did not happen.
    it('keeps the first spawn\'s dockerId when the re-spawn fails', async () => {
      const orch = harness.make();
      const first = await spawn(orch, CONTAINER);
      await orch.stopContainer(first.dockerId);

      harness.failNextCreate(orch, CONTAINER);
      await expect(orch.createContainer(harness.request(CONTAINER))).rejects.toThrow();

      expect(orch.resolveDockerId(CONTAINER)).toBe(first.dockerId);
      await expect(orch.removeContainer(first.dockerId)).resolves.toBeUndefined();
    });
  });
}

/** The whole message, not a substring, so the two classes cannot come to word it differently. */
async function expectNotFound(call: Promise<void>, dockerId: string): Promise<void> {
  await expect(call).rejects.toHaveProperty('message', `Container not found: ${dockerId}`);
}
