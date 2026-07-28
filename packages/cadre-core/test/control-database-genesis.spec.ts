import { describe, it, expect } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';

/**
 * Exercises the idempotent genesis path used by `cadre-cli start --owner`.
 * Boots a real CadreNode (empty bootstrap, transaction profile — no network
 * peers required) and drives `ControlDatabase.ensureOwnerKey` directly.
 *
 * Scope: this is the **listening** cadre-of-one — default transports (TCP) and
 * the default `listenAddrs`, i.e. the server/CLI shape. Its companion
 * `control-database-solo.spec.ts` covers the **non-listening** cadre-of-one that
 * mobile and browser embedders actually configure (WebSockets-only,
 * `listenAddrs: []`), and adds the post-genesis write, the read-back, and the
 * warm-restart read. The two are a matched pair: keep both, and put new
 * no-listen-address coverage in the solo spec.
 */
describe('ControlDatabase genesis (ensureOwnerKey)', () => {
  it('inserts exactly one OwnerKey on a fresh party and is idempotent on re-run', async () => {
    const ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    const ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

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

      expect(await db!.hasOwnerKey()).toBe(false);

      // First genesis inserts.
      expect(await db!.ensureOwnerKey(ownerPublicKey)).toBe(true);
      expect(await db!.hasOwnerKey()).toBe(true);

      // Re-run is a no-op (no duplicate, no throw).
      expect(await db!.ensureOwnerKey(ownerPublicKey)).toBe(false);

      // Exactly one row.
      const inner = db!.getDatabase();
      let count = 0;
      for await (const row of inner.eval('select Key from CadreControl.OwnerKey')) {
        expect(row.Key).toBe(ownerPublicKey);
        count++;
      }
      expect(count).toBe(1);
    } finally {
      await node.stop();
    }
  }, 60_000);
});
