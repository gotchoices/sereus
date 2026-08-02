import { expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { StrandFilter } from '../src/types.js';

/**
 * Shared boot for the "self-owner node" starting point several node-level specs need: a
 * running `CadreNode` whose libp2p identity key is also its own signing key
 * (`ed25519KeyPairFromLibp2p`), optionally enrolled as an `OwnerKey` so the writes it
 * self-signs pass the control schema's authorization constraints.
 *
 * Lifted out of `publish-strand.spec.ts`, `strand-unpublish.spec.ts`,
 * `publish-formation-invite.spec.ts` and `validation-key-enrollment.spec.ts`, which each
 * grew a near-identical copy (see `debt-self-owner-node-test-harness-duplicated`).
 */
export interface SelfOwnerNode {
  node: CadreNode;
  ownerKey: Ed25519KeyPair;
}

export interface SelfOwnerNodeOptions {
  /** Enroll the node's own key in `OwnerKey` so its self-signed writes are authorised. Default true. */
  enrollOwner?: boolean;
  /** Polling interval for the strand watcher in ms — forwarded to `CadreNodeConfig`. */
  strandWatchInterval?: number;
  /** Which strands the node's watcher admits — forwarded to `CadreNodeConfig`. */
  strandFilter?: StrandFilter;
}

/**
 * @param partyIdPrefix - Distinguishes each spec's control-network party id so parallel
 *   suites never collide (e.g. `'publish-strand-'`, `'strand-unpublish-'`).
 */
export async function startSelfOwnerNode(
  partyIdPrefix: string,
  opts: SelfOwnerNodeOptions = {},
): Promise<SelfOwnerNode> {
  const { enrollOwner = true, strandWatchInterval, strandFilter } = opts;
  const nodeKey = await generateKeyPair('Ed25519');
  const ownerKey = ed25519KeyPairFromLibp2p(nodeKey);

  const node = new CadreNode({
    controlNetwork: {
      partyId: partyIdPrefix + Math.random().toString(36).slice(2),
      bootstrapNodes: [],
    },
    privateKey: nodeKey,
    profile: 'transaction',
    strandWatchInterval,
    strandFilter,
  });
  await node.start();

  if (enrollOwner) {
    const db = node.getControlDatabase();
    expect(db).not.toBeNull();
    await db!.insertOwnerKey(ownerKey.publicKeyB64);
  }
  return { node, ownerKey };
}
