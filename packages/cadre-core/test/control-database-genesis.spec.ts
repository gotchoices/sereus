import { describe, it, expect } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';

/**
 * Exercises the idempotent genesis path used by `cadre-cli start --authority`.
 * Boots a real CadreNode (empty bootstrap, transaction profile — no network
 * peers required) and drives `ControlDatabase.ensureAuthorityKey` directly.
 */
describe('ControlDatabase genesis (ensureAuthorityKey)', () => {
  it('inserts exactly one AuthorityKey on a fresh party and is idempotent on re-run', async () => {
    const authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    const authorityPublicKey = getPublicKey(authorityPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    const node = new CadreNode({
      controlNetwork: {
        partyId: 'genesis-test-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      profile: 'transaction',
    });

    try {
      await node.start();
      const db = node.getControlDatabase();
      expect(db).not.toBeNull();

      expect(await db!.hasAuthorityKey()).toBe(false);

      // First genesis inserts.
      expect(await db!.ensureAuthorityKey(authorityPublicKey)).toBe(true);
      expect(await db!.hasAuthorityKey()).toBe(true);

      // Re-run is a no-op (no duplicate, no throw).
      expect(await db!.ensureAuthorityKey(authorityPublicKey)).toBe(false);

      // Exactly one row.
      const inner = db!.getDatabase();
      let count = 0;
      for await (const row of inner.eval('select Key from CadreControl.AuthorityKey')) {
        expect(row.Key).toBe(authorityPublicKey);
        count++;
      }
      expect(count).toBe(1);
    } finally {
      await node.stop();
    }
  }, 60_000);
});
