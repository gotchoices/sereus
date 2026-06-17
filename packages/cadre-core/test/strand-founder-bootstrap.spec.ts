import { describe, it, expect, afterEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { StrandInstanceManager } from '../src/strand-instance-manager.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';
import { signSchema } from '../src/schema-verification.js';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import type { StrandRow, SAppConfig } from '../src/types.js';

/**
 * End-to-end plumbing test for the founder flag: `addStrand`/`startStrand`
 * threading `founder` (+ strandType + memberPrivateKey) down to the StrandDatabase,
 * which runs the founder bootstrap in `initialize()`. Drives the real
 * StrandInstanceManager (real libp2p node + StrandDatabase) in `bootstrap` mode so
 * the membership rows land on the local transactor without cohort consensus.
 *
 * Only the FOUNDER writes. A joiner (`founder:false`) writes nothing locally — in a
 * networked cadre it would instead receive the rows via Optimystic sync (covered by
 * the lifecycle/invite tickets, not here).
 */

const SCHEMA = 'create table Note (Id text primary key);';
const VERSION = '1.0.0';

function signedSApp(): SAppConfig {
  const priv = generatePrivateKey('ed25519', 'base64url') as string;
  const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
  return { id: pub, version: VERSION, schema: SCHEMA, signature: signSchema(SCHEMA, VERSION, priv) };
}

function startConfig(strandRow: StrandRow, founder: boolean): StartStrandConfig {
  return {
    strandRow,
    sAppConfig: signedSApp(),
    profile: 'transaction',
    defaultLatencyHint: 'interactive',
    mode: 'bootstrap',
    founder,
  };
}

async function count(db: Database, table: 'Header' | 'Member' | 'Authority'): Promise<number> {
  for await (const row of db.eval(`select count(1) as c from Strand.${table}`)) {
    return (row as { c: number }).c;
  }
  return 0;
}

describe('founder bootstrap plumbing (StrandInstanceManager)', () => {
  let manager: StrandInstanceManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.stopAll();
      manager = null;
    }
  });

  it('founder of a closed strand seats Header + founding Member/Authority from MemberPrivateKey', async () => {
    manager = new StrandInstanceManager();
    const memberPrivateKey = await generateStrandMemberKey();
    const strandRow: StrandRow = { Id: 'founder-closed', MemberPrivateKey: memberPrivateKey, Type: 'c' };

    const instance = await manager.startStrand(startConfig(strandRow, true));
    expect(instance.status).toBe('active');

    const db = instance.database!.getDatabase();
    expect(await count(db, 'Header')).toBe(1);
    expect(await count(db, 'Member')).toBe(1);
    expect(await count(db, 'Authority')).toBe(1);

    const expectedKey = strandMemberKeyPair(memberPrivateKey).publicKeyB64;
    const member = await db.get('select Key from Strand.Member');
    const authority = await db.get('select MemberKey from Strand.Authority');
    expect(member?.Key).toBe(expectedKey);
    expect(authority?.MemberKey).toBe(expectedKey);
  }, 30_000);

  it('joiner of a closed strand writes nothing locally (founder:false)', async () => {
    manager = new StrandInstanceManager();
    const memberPrivateKey = await generateStrandMemberKey();
    const strandRow: StrandRow = { Id: 'joiner-closed', MemberPrivateKey: memberPrivateKey, Type: 'c' };

    const instance = await manager.startStrand(startConfig(strandRow, false));
    expect(instance.status).toBe('active');

    const db = instance.database!.getDatabase();
    // No bootstrap ran: the rows would arrive via sync in a real cadre.
    expect(await count(db, 'Header')).toBe(0);
    expect(await count(db, 'Member')).toBe(0);
    expect(await count(db, 'Authority')).toBe(0);
  }, 30_000);

  it('founder of an open strand seats only a Header(o) — no Member/Authority', async () => {
    manager = new StrandInstanceManager();
    const strandRow: StrandRow = { Id: 'founder-open', MemberPrivateKey: null, Type: 'o' };

    const instance = await manager.startStrand(startConfig(strandRow, true));
    expect(instance.status).toBe('active');

    const db = instance.database!.getDatabase();
    expect(await count(db, 'Header')).toBe(1);
    expect(await count(db, 'Member')).toBe(0);
    expect(await count(db, 'Authority')).toBe(0);

    const header = await db.get('select Type from Strand.Header');
    expect(header?.Type).toBe('o');
  }, 30_000);

  it('founding a closed strand with no MemberPrivateKey fails and tears the runtime down', async () => {
    manager = new StrandInstanceManager();
    const strandRow: StrandRow = { Id: 'founder-closed-nokey', MemberPrivateKey: null, Type: 'c' };

    await expect(manager.startStrand(startConfig(strandRow, true))).rejects.toThrow(/MemberPrivateKey/i);

    // The failed bring-up rolled back: no live database handle leaks (releaseRuntime
    // ran via buildStrandRuntime's catch), and the instance is marked errored.
    const instance = manager.getInstance('founder-closed-nokey');
    expect(instance?.status).toBe('error');
    expect(instance?.database).toBeUndefined();
  }, 30_000);
});
