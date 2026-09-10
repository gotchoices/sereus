import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import { generatePrivateKey, getPublicKey, digest, verify } from '@optimystic/quereus-plugin-crypto';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import {
  signStrandPayload,
  bootstrapFounderMembership,
  PreSplitStrandIdentityError,
  addMemberByManager,
  addManager,
  removeManager,
  STRAND_ENGINE,
  STRAND_ENGINE_VERSION,
} from '../src/strand-membership-writer.js';
import { makeSAppConfig, tableCount } from './strand-spec-helpers.js';

/**
 * Unit + component coverage for the founder-bootstrap primitives.
 *
 * The pure-crypto tests (key bridge round-trip, single-digest signer) are fast and
 * need no DB. The founder-bootstrap tests run a REAL strand DB on the local
 * transactor (libp2p node + MemoryRawStorage, no peers consulted) via `connectToStrand`
 * — the same path `StrandDatabase` uses — so they exercise the real apply / DML /
 * deferred-constraint path, not a fake.
 */

// ── Crypto primitives (no DB) ────────────────────────────────────────────────

describe('strandMemberKeyPair (protobuf -> base64url bridge)', () => {
  it('derives a stable public key matching getPublicKey of the seed', async () => {
    const memberPrivateKey = await generateStrandMemberKey();
    const kp = strandMemberKeyPair(memberPrivateKey);

    // Stable: deriving twice from the same protobuf key yields the same pubkey.
    expect(strandMemberKeyPair(memberPrivateKey).publicKeyB64).toBe(kp.publicKeyB64);

    // The founding Member.Key (publicKeyB64) is exactly getPublicKey(seed), so a
    // later signature made with privateKeyB64 verifies against the stored Member.Key.
    const derivedPub = getPublicKey(kp.privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
    expect(derivedPub).toBe(kp.publicKeyB64);
  });

  it('produces a keypair whose signature verifies under the strand crypto idiom', async () => {
    const memberPrivateKey = await generateStrandMemberKey();
    const kp = strandMemberKeyPair(memberPrivateKey);

    const payload = `${kp.publicKeyB64}|2030-01-01T00:00:00`;
    const sig = signStrandPayload(payload, kp.privateKeyB64);

    // Mirror the constraint: verify(digest(payload), sig, pub, 'ed25519').
    const payloadDigest = digest([payload], 'sha256', 'base64url') as string;
    expect(verify(payloadDigest, sig, kp.publicKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url')).toBe(true);
  });
});

describe('signStrandPayload (single-digest ed25519 signer)', () => {
  it('output verifies via verify(digest(payload), sig, pub, ed25519)', () => {
    const priv = generatePrivateKey('ed25519', 'base64url') as string;
    const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
    const payload = 'invite-key|2031-03-04T12:34:56';

    const sig = signStrandPayload(payload, priv);
    const payloadDigest = digest([payload], 'sha256', 'base64url') as string;

    expect(verify(payloadDigest, sig, pub, 'ed25519', 'base64url', 'base64url', 'base64url')).toBe(true);
  });

  it('a signature over a different payload does NOT verify (binds to the payload)', () => {
    const priv = generatePrivateKey('ed25519', 'base64url') as string;
    const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;

    const sig = signStrandPayload('payload-A', priv);
    const wrongDigest = digest(['payload-B'], 'sha256', 'base64url') as string;

    expect(verify(wrongDigest, sig, pub, 'ed25519', 'base64url', 'base64url', 'base64url')).toBe(false);
  });
});

// ── Founder bootstrap against a real strand DB ───────────────────────────────

interface OpenStrand {
  db: Database;
  strandId: string;
  storage: MemoryRawStorage;
  shutdown: () => Promise<void>;
}

/**
 * Open a strand DB on the local transactor (real node + in-memory storage, no
 * peers consulted). Passing a prior run's `strandId`+`storage` reopens that
 * persisted strand (a fresh `Database` over the same blocks), exercising the
 * warm-restart / hydrate path.
 */
async function openStrandDb(
  strandId: string = randomUUID(),
  storage: MemoryRawStorage = new MemoryRawStorage(),
): Promise<OpenStrand> {
  const db = new Database();
  const result = await connectToStrand(db, { strandId, transactor: 'local', storage });
  return {
    db,
    strandId,
    storage,
    shutdown: async () => {
      await result.shutdown();
      db.close();
    },
  };
}

describe('bootstrapFounderMembership', () => {
  let open: OpenStrand | null = null;

  afterEach(async () => {
    if (open) {
      await open.shutdown();
      open = null;
    }
  });

  it('closed strand: writes exactly one Header(c), Member, and Manager sharing the founder key', async () => {
    open = await openStrandDb();
    const { db, strandId } = open;
    const founderKeyPair = strandMemberKeyPair(await generateStrandMemberKey());
    const sApp = makeSAppConfig();

    await bootstrapFounderMembership(db, { strandId, type: 'c', sApp, founderKeyPair });

    expect(await tableCount(db, 'Header')).toBe(1);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'Manager')).toBe(1);

    const header = await db.get('select * from Strand.Header');
    expect(header?.Id).toBe(strandId);
    expect(header?.Type).toBe('c');
    expect(header?.sAppId).toBe(sApp.id);
    expect(header?.sAppVersion).toBe(sApp.version);
    expect(header?.sAppSchema).toBe(sApp.schema);
    expect(header?.sAppSignature).toBe(sApp.signature);
    expect(header?.Engine).toBe(STRAND_ENGINE);
    expect(header?.EngineVersion).toBe(STRAND_ENGINE_VERSION);

    // Member.Key === Manager.MemberKey === the derived founder public key.
    const member = await db.get('select Key from Strand.Member');
    const manager = await db.get('select MemberKey from Strand.Manager');
    expect(member?.Key).toBe(founderKeyPair.publicKeyB64);
    expect(manager?.MemberKey).toBe(founderKeyPair.publicKeyB64);
  }, 30_000);

  it('open strand: writes a Header(o) only — no Member/Manager (OnlyClosed)', async () => {
    open = await openStrandDb();
    const { db, strandId } = open;

    await bootstrapFounderMembership(db, { strandId, type: 'o', sApp: makeSAppConfig() });

    expect(await tableCount(db, 'Header')).toBe(1);
    expect(await tableCount(db, 'Member')).toBe(0);
    expect(await tableCount(db, 'Manager')).toBe(0);

    const header = await db.get('select Type from Strand.Header');
    expect(header?.Type).toBe('o');
  }, 30_000);

  it('is idempotent: a second run inserts nothing and does not throw (InsertOnly safe)', async () => {
    open = await openStrandDb();
    const { db, strandId } = open;
    const founderKeyPair = strandMemberKeyPair(await generateStrandMemberKey());
    const params = { strandId, type: 'c' as const, sApp: makeSAppConfig(), founderKeyPair };

    await bootstrapFounderMembership(db, params);
    // Re-running (founder restart / re-addStrand) must be a no-op, not an
    // InsertOnly / PK violation.
    await expect(bootstrapFounderMembership(db, params)).resolves.toBeUndefined();

    expect(await tableCount(db, 'Header')).toBe(1);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  it('is idempotent across a reopen: a fresh DB over persisted storage re-runs without duplicating rows', async () => {
    const founderKeyPair = strandMemberKeyPair(await generateStrandMemberKey());

    // Cold session: bootstrap a closed strand, then shut the connection down,
    // leaving the rows persisted in the shared MemoryRawStorage blocks.
    const cold = await openStrandDb();
    const { strandId, storage } = cold;
    const params = { strandId, type: 'c' as const, sApp: makeSAppConfig(), founderKeyPair };
    await bootstrapFounderMembership(cold.db, params);
    await cold.shutdown();

    // Warm session: a brand-new Database hydrates the persisted strand. The rows
    // are already seated *before* any new write — proving this is a true reopen,
    // not a fresh insert into an empty catalog.
    open = await openStrandDb(strandId, storage);
    const { db } = open;
    expect(await tableCount(db, 'Header')).toBe(1);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'Manager')).toBe(1);

    // Re-running the founder bootstrap against the reopened DB (the real
    // cross-process restart path) is a no-op — the count guards see the hydrated
    // rows and skip, so no duplicate Header / InsertOnly violation.
    await expect(bootstrapFounderMembership(db, params)).resolves.toBeUndefined();
    expect(await tableCount(db, 'Header')).toBe(1);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  // The nearest in-process stand-in for a node that acquires an already-populated
  // strand: hydrate a strand that has GROWN past the founding state (3 members, 2
  // managers) into a brand-new `Database`. `Manager.Authorized`'s bootstrap branch is
  // gated on `count(Member) <= 1`, so if hydration replayed the membership rows as SQL
  // DML the founding `Manager` row would be re-checked against a 3-member strand and
  // rejected. It is not — rows arrive as committed blocks and the CHECKs do not re-run.
  it('hydrates a grown strand (3 members, 2 managers) into a fresh Database without re-running membership CHECKs', async () => {
    const founderKeyPair = strandMemberKeyPair(await generateStrandMemberKey());
    const secondManager = strandMemberKeyPair(await generateStrandMemberKey());
    const plainMember = strandMemberKeyPair(await generateStrandMemberKey());

    const cold = await openStrandDb();
    const { strandId, storage } = cold;
    const params = { strandId, type: 'c' as const, sApp: makeSAppConfig(), founderKeyPair };
    await bootstrapFounderMembership(cold.db, params);
    await addMemberByManager(cold.db, { managerKeyPair: founderKeyPair, memberKey: secondManager.publicKeyB64 });
    await addMemberByManager(cold.db, { managerKeyPair: founderKeyPair, memberKey: plainMember.publicKeyB64 });
    await addManager(cold.db, { byManagerKeyPair: founderKeyPair, newManagerKey: secondManager.publicKeyB64 });
    expect(await tableCount(cold.db, 'Member')).toBe(3);
    expect(await tableCount(cold.db, 'Manager')).toBe(2);
    await cold.shutdown();

    open = await openStrandDb(strandId, storage);
    const { db } = open;
    expect(await tableCount(db, 'Member')).toBe(3);
    expect(await tableCount(db, 'Manager')).toBe(2);

    // The hydrated strand is still writable, and the hydrated rows really back the
    // constraints: the manager appointed in the COLD session authorizes a promotion in
    // the WARM one, so hydration seats rows the CHECKs can verify against — not an
    // inert snapshot.
    await expect(
      addManager(db, { byManagerKeyPair: secondManager, newManagerKey: plainMember.publicKeyB64 }),
    ).resolves.toBeUndefined();
    expect(await tableCount(db, 'Manager')).toBe(3);
  }, 30_000);

  it('coalesces a missing sApp signature to empty string (NOT NULL Header column)', async () => {
    open = await openStrandDb();
    const { db, strandId } = open;
    // Unsigned config (dev requireSignedSchemas:false) — signature is undefined.
    const sApp = makeSAppConfig({ signature: undefined });

    await bootstrapFounderMembership(db, { strandId, type: 'o', sApp });

    const header = await db.get('select sAppSignature from Strand.Header');
    expect(header?.sAppSignature).toBe('');
  }, 30_000);

  it('throws for a closed strand with no founder key pair (would seat no manager)', async () => {
    open = await openStrandDb();
    const { db, strandId } = open;

    await expect(
      bootstrapFounderMembership(db, { strandId, type: 'c', sApp: makeSAppConfig() }),
    ).rejects.toThrow(/no founder key pair/i);

    // Fail-before-write: no closed Header is left stranded without a founding
    // Member/Manager (which could never admit anyone).
    expect(await tableCount(db, 'Header')).toBe(0);
    expect(await tableCount(db, 'Member')).toBe(0);
    expect(await tableCount(db, 'Manager')).toBe(0);
  }, 30_000);
});

describe('bootstrapFounderMembership: pre-split detection', () => {
  let open: OpenStrand | null = null;

  afterEach(async () => {
    if (open) {
      await open.shutdown();
      open = null;
    }
  });

  /** A strand whose founding was seated under the key derived from the SHARED read secret. */
  async function preSplitStrand() {
    open = await openStrandDb();
    const sharedKeyPair = strandMemberKeyPair(await generateStrandMemberKey());
    const partyKeyPair = strandMemberKeyPair(await generateStrandMemberKey());
    const sApp = makeSAppConfig();
    await bootstrapFounderMembership(open.db, { strandId: open.strandId, type: 'c', sApp, founderKeyPair: sharedKeyPair });
    return { db: open.db, strandId: open.strandId, sApp, sharedKeyPair, partyKeyPair };
  }

  it('refuses a closed strand whose manager is the shared-derived key, writing nothing', async () => {
    const { db, strandId, sApp, sharedKeyPair, partyKeyPair } = await preSplitStrand();

    const refused = bootstrapFounderMembership(db, {
      strandId, type: 'c', sApp, founderKeyPair: partyKeyPair, sharedMemberPublicKey: sharedKeyPair.publicKeyB64,
    });

    await expect(refused).rejects.toThrow(PreSplitStrandIdentityError);
    await expect(refused).rejects.toMatchObject({ strandId, message: expect.stringMatching(/recreate the strand/) });
    expect(await tableCount(db, 'Member')).toBe(1);
    const manager = await db.get('select MemberKey from Strand.Manager');
    expect(manager?.MemberKey).toBe(sharedKeyPair.publicKeyB64);
  }, 30_000);

  it('refuses a pre-split strand whose shared-derived founder handed management on and resigned', async () => {
    const { db, strandId, sApp, sharedKeyPair, partyKeyPair } = await preSplitStrand();
    const successor = strandMemberKeyPair(await generateStrandMemberKey());
    await addMemberByManager(db, { managerKeyPair: sharedKeyPair, memberKey: successor.publicKeyB64 });
    await addManager(db, { byManagerKeyPair: sharedKeyPair, newManagerKey: successor.publicKeyB64 });
    await removeManager(db, { byManagerKeyPair: sharedKeyPair, targetManagerKey: sharedKeyPair.publicKeyB64 });

    // The shared-derived key is no manager now, but its Member row still gives it away.
    await expect(bootstrapFounderMembership(db, {
      strandId, type: 'c', sApp, founderKeyPair: partyKeyPair, sharedMemberPublicKey: sharedKeyPair.publicKeyB64,
    })).rejects.toThrow(PreSplitStrandIdentityError);
  }, 30_000);

  it('without the shared key supplied, the same rows are skipped as insert-if-absent always did', async () => {
    const { db, strandId, sApp, sharedKeyPair, partyKeyPair } = await preSplitStrand();

    await expect(
      bootstrapFounderMembership(db, { strandId, type: 'c', sApp, founderKeyPair: partyKeyPair }),
    ).resolves.toBeUndefined();
    const manager = await db.get('select MemberKey from Strand.Manager');
    expect(manager?.MemberKey).toBe(sharedKeyPair.publicKeyB64);
  }, 30_000);

  it('with the shared key supplied, a fresh closed strand founds under the party key', async () => {
    open = await openStrandDb();
    const { db, strandId } = open;
    const sharedKeyPair = strandMemberKeyPair(await generateStrandMemberKey());
    const partyKeyPair = strandMemberKeyPair(await generateStrandMemberKey());
    const params = {
      strandId, type: 'c' as const, sApp: makeSAppConfig(), founderKeyPair: partyKeyPair,
      sharedMemberPublicKey: sharedKeyPair.publicKeyB64,
    };

    await bootstrapFounderMembership(db, params);
    // ...and re-running it (a founder restart) still passes the check.
    await expect(bootstrapFounderMembership(db, params)).resolves.toBeUndefined();

    const manager = await db.get('select MemberKey from Strand.Manager');
    expect(manager?.MemberKey).toBe(partyKeyPair.publicKeyB64);
    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  it('never checks an open strand (no managers to compare)', async () => {
    open = await openStrandDb();
    const { db, strandId } = open;

    await bootstrapFounderMembership(db, {
      strandId, type: 'o', sApp: makeSAppConfig(), sharedMemberPublicKey: freshPublicKey(),
    });
    expect(await tableCount(db, 'Header')).toBe(1);
  }, 30_000);
});

function freshPublicKey(): string {
  const priv = generatePrivateKey('ed25519', 'base64url') as string;
  return getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
}
