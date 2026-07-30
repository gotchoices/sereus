import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';
import { strandTransportKey } from '../src/strand-transport-key.js';

/**
 * Unit coverage for the `launchStrand` wiring itself (cadre-node.ts ~L3161):
 * that it actually derives and forwards the per-strand transport key to
 * `StrandInstanceManager.startStrand`, rather than reusing the control node's
 * identity key. `strandTransportKey` the derivation function is covered in
 * strand-transport-key.spec.ts and the relay collision it fixes is pinned in
 * strand-transport-relay.spec.ts with real libp2p nodes; neither would catch a
 * regression that reintroduces `privateKey: this.identityKey` here.
 */

function createConfig(): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'launch-key-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes: []
    },
    profile: 'transaction'
  };
}

/** Records every `startStrand` config without booting a real libp2p node. */
function injectFakeStrandManager(node: CadreNode): { configs: StartStrandConfig[] } {
  const configs: StartStrandConfig[] = [];
  (node as unknown as { strandManager: unknown }).strandManager = {
    startStrand: async (config: StartStrandConfig) => {
      configs.push(config);
      return {
        strandId: config.strandRow.Id,
        status: 'active',
        connectedPeers: 0,
        lastActivity: new Date(0),
        latencyHint: config.defaultLatencyHint
      };
    }
  };
  return { configs };
}

function injectIdentityKey(node: CadreNode, key: PrivateKey): void {
  (node as unknown as { identityKey: PrivateKey }).identityKey = key;
}

function launchStrand(node: CadreNode, strandId: string): Promise<unknown> {
  return (node as unknown as {
    launchStrand(strand: { Id: string; MemberPrivateKey: string | null; Type: 'o' | 'c' }, sAppConfig: unknown): Promise<unknown>;
  }).launchStrand(
    { Id: strandId, MemberPrivateKey: null, Type: 'o' },
    { id: 'sapp-author', version: '1.0.0', schema: '' }
  );
}

describe('CadreNode.launchStrand transport-key wiring', () => {
  it('passes a transport key whose peerId differs from the control node identity', async () => {
    const identity = await generateKeyPair('Ed25519');
    const node = new CadreNode(createConfig());
    injectIdentityKey(node, identity);
    const { configs } = injectFakeStrandManager(node);

    await launchStrand(node, 'strand-a');

    expect(configs).toHaveLength(1);
    const passedKey = configs[0]!.privateKey;
    expect(passedKey).toBeDefined();
    expect(peerIdFromPrivateKey(passedKey!).toString()).not.toBe(peerIdFromPrivateKey(identity).toString());
  });

  it('passes exactly the derived strandTransportKey, not a fresh random key', async () => {
    const identity = await generateKeyPair('Ed25519');
    const node = new CadreNode(createConfig());
    injectIdentityKey(node, identity);
    const { configs } = injectFakeStrandManager(node);

    await launchStrand(node, 'strand-a');

    const expected = await strandTransportKey(identity, 'strand-a');
    expect(configs[0]!.privateKey!.raw).toEqual(expected.raw);
  });

  it('derives a distinct key per strand on the same node', async () => {
    const identity = await generateKeyPair('Ed25519');
    const node = new CadreNode(createConfig());
    injectIdentityKey(node, identity);
    const { configs } = injectFakeStrandManager(node);

    await launchStrand(node, 'strand-a');
    await launchStrand(node, 'strand-b');

    const [keyA, keyB] = configs.map((c) => c.privateKey!);
    expect(peerIdFromPrivateKey(keyA).toString()).not.toBe(peerIdFromPrivateKey(keyB).toString());
  });

  it('passes no private key when no identity key is configured (libp2p generates its own)', async () => {
    const node = new CadreNode(createConfig());
    const { configs } = injectFakeStrandManager(node);

    await launchStrand(node, 'strand-a');

    expect(configs).toHaveLength(1);
    expect(configs[0]!.privateKey).toBeUndefined();
  });
});
