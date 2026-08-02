import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig, SAppConfig, StrandRow } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';

/**
 * `handleStrandAdded` is the StrandWatcher's `onStrandAdded` callback. The watcher
 * uses the returned promise to decide whether the strand was really added: a
 * resolved promise means "launched, stop polling for it". So a launch failure must
 * both surface as `strand:error` (for the hosting app) AND reject (for the watcher,
 * which drops the strand from its known set and schedules a retry). Swallowing the
 * error here permanently disables the strand id for the life of the process.
 *
 * Driven directly against a fake strand manager - no real libp2p node boots.
 */

const STRAND_ROW: StrandRow = { Id: 'failing-strand', MemberPrivateKey: null, Type: 'o' };
const SAPP_CONFIG: SAppConfig = { id: 'sapp-author', version: '1.0.0', schema: '' };

function createConfig(): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'strand-added-failure-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes: []
    },
    profile: 'transaction'
  };
}

/** Strand manager whose `startStrand` always throws, without booting anything. */
function injectFailingStrandManager(node: CadreNode, error: Error): void {
  (node as unknown as { strandManager: unknown }).strandManager = {
    getInstance: () => undefined,
    startStrand: async (_config: StartStrandConfig) => { throw error; }
  };
}

/** Register an sAppConfig so handleStrandAdded takes the launch path, not `strand:discovered`. */
function registerSAppConfig(node: CadreNode, strandId: string): void {
  (node as unknown as { sAppConfigs: Map<string, SAppConfig> }).sAppConfigs.set(strandId, SAPP_CONFIG);
}

function handleStrandAdded(node: CadreNode, strand: StrandRow): Promise<void> {
  return (node as unknown as {
    handleStrandAdded(strand: StrandRow): Promise<void>;
  }).handleStrandAdded(strand);
}

describe('CadreNode.handleStrandAdded failure propagation', () => {
  it('emits strand:error and rejects when the launch fails', async () => {
    const node = new CadreNode(createConfig());
    (node as unknown as { identityKey: unknown }).identityKey = await generateKeyPair('Ed25519');
    const failure = new Error('transient storage fault');
    injectFailingStrandManager(node, failure);
    registerSAppConfig(node, STRAND_ROW.Id);

    const errors: { strandId: string; error: Error }[] = [];
    node.on('strand:error', (event) => { errors.push(event); });

    await expect(handleStrandAdded(node, STRAND_ROW)).rejects.toThrow('transient storage fault');

    expect(errors).toHaveLength(1);
    expect(errors[0]!.strandId).toBe(STRAND_ROW.Id);
    expect(errors[0]!.error).toBe(failure);
  });

  it('resolves without emitting strand:error when no sAppConfig is registered', async () => {
    // The discovery-only path is unchanged: an unconfigured strand is surfaced as
    // `strand:discovered` and must NOT reject - nothing was attempted.
    const node = new CadreNode(createConfig());
    injectFailingStrandManager(node, new Error('should never be reached'));

    const errors: unknown[] = [];
    const discovered: { strandId: string }[] = [];
    node.on('strand:error', (event) => { errors.push(event); });
    node.on('strand:discovered', (event) => { discovered.push(event); });

    await expect(handleStrandAdded(node, STRAND_ROW)).resolves.toBeUndefined();

    expect(errors).toHaveLength(0);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.strandId).toBe(STRAND_ROW.Id);
  });
});
