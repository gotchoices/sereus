import { describe, it, expect, afterEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import { bootstrapFounderMembership, issueInvite } from '../src/strand-membership-writer.js';
import type { StrandRow, SAppConfig } from '../src/types.js';

/**
 * Reproduction for `strand-founder-identity-missing-on-pre-split-strands`: a closed strand
 * whose founding Member/Manager were seated BEFORE the per-party identity split (derived
 * from the shared `MemberPrivateKey` every joiner holds). A later founder bootstrap under
 * the party's own key writes nothing (the tables are non-empty), so the shared-derived key
 * stays the only manager and the party key can never sign a founder write.
 *
 * Drives the real StrandInstanceManager solo: launch as a joiner (writes nothing), seat
 * the pre-split rows by hand, then found in place — the same `bootstrapFounder` a fresh
 * founder launch runs in `StrandDatabase.initialize()`.
 */

const SCHEMA = 'create table Note (Id text primary key);';
const VERSION = '1.0.0';

function signedSApp(): SAppConfig {
  const priv = generatePrivateKey('ed25519', 'base64url') as string;
  const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
  return { id: pub, version: VERSION, schema: SCHEMA, signature: signSchema(SCHEMA, VERSION, priv) };
}

async function managerKeys(db: Database): Promise<string[]> {
  const keys: string[] = [];
  for await (const row of db.eval('select MemberKey from Strand.Manager')) {
    keys.push(row.MemberKey as string);
  }
  return keys;
}

describe('founder bootstrap on a pre-split closed strand', () => {
  let manager: StrandInstanceManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.stopAll();
      manager = null;
    }
  });

  it('REPRO: founding in place leaves the shared-derived key as sole manager', async () => {
    manager = new StrandInstanceManager();
    const memberPrivateKey = await generateStrandMemberKey();
    const partyMemberPrivateKey = await generateStrandMemberKey();
    const sApp = signedSApp();
    const strandRow: StrandRow = { Id: 'pre-split-closed', MemberPrivateKey: memberPrivateKey, Type: 'c', FounderOwnerKey: null };

    const instance = await manager.startStrand({
      strandRow,
      sAppConfig: sApp,
      profile: 'transaction',
      defaultLatencyHint: 'interactive',
      founder: false,
    });
    const db = instance.database!.getDatabase();

    // The pre-split founding: identity derived from the SHARED read secret.
    const sharedKeyPair = strandMemberKeyPair(memberPrivateKey);
    await bootstrapFounderMembership(db, { strandId: strandRow.Id, type: 'c', sApp, founderKeyPair: sharedKeyPair });

    // Today: the founder request succeeds silently.
    const outcome = await manager.foundExistingStrand(strandRow.Id, async () => partyMemberPrivateKey);
    expect(outcome).toBe('bootstrapped');

    // ...the shared-derived key is still the only manager (any joiner can sign as it)...
    const partyKeyPair = strandMemberKeyPair(partyMemberPrivateKey);
    expect(await managerKeys(db)).toEqual([sharedKeyPair.publicKeyB64]);

    // ...and the party's own identity cannot issue an invitation.
    await expect(issueInvite(db, { managerKeyPair: partyKeyPair })).rejects.toThrow();
  }, 30_000);
});
