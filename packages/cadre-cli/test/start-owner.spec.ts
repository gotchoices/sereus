/**
 * `cadre start --owner` against a real solo node: what the server's owner key does on its party.
 * The three arms are the decision `wireServerOwnerKey` makes from the party's `OwnerKey` table:
 * a party with no owner is founded by the key, a party that lists it gets it wired as it is, and
 * a party whose owners do not include it refuses the start with nothing written.
 *
 * Each "restart" is a second node over the first one's stores, so the second meets the party the
 * first left, as a restarted server does. No node binds a port (`listenAddrs: []`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '@serfab/cadre-core';
import { loadServerOwnerKey, wireServerOwnerKey } from '../src/commands/start-owner.js';
import { ownerKeyFingerprint } from '../src/commands/owner-key-file.js';

/** Booting a node takes longer than vitest's 5 s default. */
const NODE_TEST_TIMEOUT_MS = 60_000;

const LABEL = 'server test-host';

let dir: string;
let partyId: string;
let identity: PrivateKey;
/** One store per scope, kept across the nodes of a test, as a server's files are across restarts. */
let stores: Map<string, MemoryRawStorage>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cadre-start-owner-'));
  partyId = `cli-start-owner-${Math.random().toString(36).slice(2)}`;
  identity = await generateKeyPair('Ed25519');
  stores = new Map();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function withNode(body: (node: CadreNode) => Promise<void>): Promise<void> {
  const provider = (scope: string): MemoryRawStorage => {
    let store = stores.get(scope);
    if (!store) {
      store = new MemoryRawStorage();
      stores.set(scope, store);
    }
    return store;
  };
  const node = new CadreNode({
    privateKey: identity,
    controlNetwork: { partyId, bootstrapNodes: [] },
    profile: 'storage',
    strandFilter: { mode: 'none' },
    storage: { provider },
    network: { listenAddrs: [] },
  });
  try {
    await node.start();
    await body(node);
  } finally {
    await node.stop();
  }
}

/** Start with `--owner` over the owner key file `name`, as `cadre start` does once the node is up. */
async function startAsOwner(node: CadreNode, name: string): Promise<string> {
  const owner = await loadServerOwnerKey(join(dir, name), partyId);
  await wireServerOwnerKey(node, owner, LABEL);
  return owner.signer.publicKey;
}

describe('cadre start --owner', () => {
  it('founds a party that has no owner with the server\'s key, under its label', async () => {
    await withNode(async (node) => {
      const key = await startAsOwner(node, 'owner.key');

      expect(await node.listOwnerKeys()).toEqual([expect.objectContaining({ key, label: LABEL, vouchedBy: null, heldHere: true })]);
      expect(node.getOwnerSigner()?.publicKey).toBe(key);
    });
  }, NODE_TEST_TIMEOUT_MS);

  it('wires the key on a party that lists it, inserting nothing', async () => {
    let key = '';
    await withNode(async (node) => { key = await startAsOwner(node, 'owner.key'); });

    await withNode(async (node) => {
      expect(await startAsOwner(node, 'owner.key')).toBe(key);

      expect((await node.listOwnerKeys()).map((row) => row.key)).toEqual([key]);
      expect(await node.isOwner()).toBe(true);
    });
  }, NODE_TEST_TIMEOUT_MS);

  it('refuses a key the party\'s owners do not include, naming it, with nothing written or wired', async () => {
    let founder = '';
    await withNode(async (node) => { founder = await startAsOwner(node, 'owner.key'); });

    await withNode(async (node) => {
      const stranger = await loadServerOwnerKey(join(dir, 'other-owner.key'), partyId);

      await expect(wireServerOwnerKey(node, stranger, LABEL))
        .rejects.toThrow(`owner key ${ownerKeyFingerprint(stranger.signer.publicKey)} (${join(dir, 'other-owner.key')}) is not an owner of party ${partyId}`);
      expect((await node.listOwnerKeys()).map((row) => row.key)).toEqual([founder]);
      expect(node.getOwnerSigner()).toBeNull();
    });
  }, NODE_TEST_TIMEOUT_MS);
});
