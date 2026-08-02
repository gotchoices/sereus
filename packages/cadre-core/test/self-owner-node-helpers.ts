import { expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { StrandFilter } from '../src/types.js';

/**
 * Shared boot for the "self-owner node" starting point several node-level specs need: a
 * `CadreNode` whose libp2p identity key is also its own signing key
 * (`ed25519KeyPairFromLibp2p`), optionally started and enrolled as an `OwnerKey` so the
 * writes it self-signs pass the control schema's authorization constraints.
 *
 * Lifted out of `publish-strand.spec.ts`, `strand-unpublish.spec.ts`,
 * `publish-formation-invite.spec.ts` and `validation-key-enrollment.spec.ts`, which each
 * grew a near-identical copy (see `debt-self-owner-node-test-harness-duplicated`).
 *
 * Not a `*.spec.ts` file, so vitest's `test/**\/*.spec.ts` glob never runs it as a suite.
 */
export interface SelfOwnerNode {
  node: CadreNode;
  ownerKey: Ed25519KeyPair;
}

/** `CadreNodeConfig` fields the watcher-driven specs vary; both default to production values. */
export interface SelfOwnerNodeConfig {
  /** Polling interval for the strand watcher in ms. Omitted/`undefined` → the node's 5s default. */
  strandWatchInterval?: number;
  /** Which strands the node's watcher admits. Omitted/`undefined` → `{ mode: 'all' }`. */
  strandFilter?: StrandFilter;
}

export interface SelfOwnerNodeOptions extends SelfOwnerNodeConfig {
  /** Enroll the node's own key in `OwnerKey` so its self-signed writes are authorised. Default true. */
  enrollOwner?: boolean;
}

/**
 * Construct a self-owner node WITHOUT starting it — what the "throws if the node has not
 * been started" guards need. Nothing to tear down afterwards: `start` never ran.
 *
 * @param partyIdPrefix - Distinguishes each spec's control-network party id so parallel
 *   suites never collide (e.g. `'publish-strand-stopped-'`).
 */
export async function newUnstartedNode(
  partyIdPrefix: string,
  config: SelfOwnerNodeConfig = {},
): Promise<SelfOwnerNode> {
  const nodeKey = await generateKeyPair('Ed25519');
  const node = new CadreNode({
    controlNetwork: {
      partyId: partyIdPrefix + Math.random().toString(36).slice(2),
      bootstrapNodes: [],
    },
    privateKey: nodeKey,
    profile: 'transaction',
    strandWatchInterval: config.strandWatchInterval,
    strandFilter: config.strandFilter,
  });
  return { node, ownerKey: ed25519KeyPairFromLibp2p(nodeKey) };
}

/**
 * Start a self-owner node, enrolling its own key in `OwnerKey` unless told otherwise.
 *
 * @param partyIdPrefix - See {@link newUnstartedNode}.
 */
export async function startSelfOwnerNode(
  partyIdPrefix: string,
  opts: SelfOwnerNodeOptions = {},
): Promise<SelfOwnerNode> {
  const { enrollOwner = true, ...config } = opts;
  const started = await newUnstartedNode(partyIdPrefix, config);
  await started.node.start();

  try {
    if (enrollOwner) {
      const db = started.node.getControlDatabase();
      expect(db).not.toBeNull();
      await db!.insertOwnerKey(started.ownerKey.publicKeyB64);
    }
  } catch (error) {
    // The caller never receives the node, so nothing else can stop it — a leaked libp2p
    // node keeps handles open and can hang the whole vitest run.
    await started.node.stop().catch((stopError: unknown) =>
      console.error('startSelfOwnerNode: stopping the node after a failed boot also failed', stopError));
    throw error;
  }
  return started;
}
