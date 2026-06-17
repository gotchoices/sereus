import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import {
  bootstrapFounderMembership,
  addMemberByAuthority,
  registerMemberPeer,
  addAuthority,
  removeAuthority,
  signStrandPayload,
} from '../src/strand-membership-writer.js';
import type { AuthorityKeyPair } from '../src/authority-key.js';
import type { SAppConfig } from '../src/types.js';

/**
 * Component coverage for the two remaining founder-reachable writers:
 * `MemberPeer` registration (a member binds its own network nodes, self-signed) and
 * `Authority` rotation (an existing authority promotes/removes admins, or an
 * authority resigns itself). Every test runs against a REAL closed strand DB in
 * bootstrap mode (libp2p node + MemoryRawStorage + the optimystic local transactor)
 * via `connectToStrand` — the same path `StrandDatabase` uses — so the real
 * apply/DML/deferred-constraint path is exercised, not a fake.
 *
 * The founder is bootstrapped first (Member #1 + the sole founding Authority), so an
 * authority add genuinely runs past the `count(Authority) <= 1` bootstrap branch
 * (at commit the new row makes the count ≥ 2), exercising signature verification.
 */

function makeSAppConfig(overrides: Partial<SAppConfig> = {}): SAppConfig {
  return {
    id: 'sapp-author-pubkey',
    version: '1.2.3',
    schema: 'table Note (Id integer primary key, Body text not null)',
    signature: 'sapp-signature',
    ...overrides,
  };
}

/** A fresh, unrelated ed25519 keypair in the base64url shape the constraints consume. */
function freshKeyPair(): AuthorityKeyPair {
  const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
  const publicKeyB64 = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
  return { privateKeyB64, publicKeyB64 };
}

type StrandTable = 'Header' | 'Member' | 'MemberPeer' | 'Authority';

async function tableCount(db: Database, table: StrandTable): Promise<number> {
  for await (const row of db.eval(`select count(1) as c from Strand.${table}`)) {
    return (row as { c: number }).c;
  }
  return 0;
}

interface Strand {
  db: Database;
  strandId: string;
  /** The founder keypair — Member #1 and the sole founding Authority. */
  founder: AuthorityKeyPair;
  shutdown: () => Promise<void>;
}

const opened: Strand[] = [];

/** Open a strand DB in bootstrap mode and run the founder bootstrap for the type. */
async function openStrand(type: 'o' | 'c'): Promise<Strand> {
  const strandId = randomUUID();
  const storage = new MemoryRawStorage();
  const db = new Database();
  const result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });
  const founder = strandMemberKeyPair(await generateStrandMemberKey());
  await bootstrapFounderMembership(db, {
    strandId,
    type,
    sApp: makeSAppConfig(),
    founderKeyPair: type === 'c' ? founder : undefined,
  });
  const strand: Strand = {
    db,
    strandId,
    founder,
    shutdown: async () => {
      await result.shutdown();
      db.close();
    },
  };
  opened.push(strand);
  return strand;
}

afterEach(async () => {
  while (opened.length > 0) {
    const strand = opened.pop()!;
    await strand.shutdown();
  }
});

// ── Phase 1: MemberPeer registration (member self-signs its own peer) ─────────

describe('registerMemberPeer', () => {
  it('the founder member registers a peer → exactly one MemberPeer row bound to its key', async () => {
    const { db, founder } = await openStrand('c');

    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-alpha' });

    expect(await tableCount(db, 'MemberPeer')).toBe(1);
    const row = await db.get('select MemberKey, PeerId from Strand.MemberPeer');
    expect(row?.MemberKey).toBe(founder.publicKeyB64);
    expect(row?.PeerId).toBe('peer-alpha');
  }, 30_000);

  it('rejects a peer insert signed by a key other than the member key (self-signature only)', async () => {
    const { db, founder } = await openStrand('c');
    const peerId = 'peer-impostor';
    const impostor = freshKeyPair();

    // The MemberKey is the real founder member (so the deferred MemberExists passes),
    // but the Signature is made by an unrelated key over the same payload — so the
    // immediate Authorized check (verify against MemberKey itself) fails.
    const payload = `${founder.publicKeyB64}|${peerId}`;
    const wrongSignature = signStrandPayload(payload, impostor.privateKeyB64);

    await expect(
      db.exec(
        `insert into Strand.MemberPeer (MemberKey, PeerId)
           with context Signature = ?
           values (?, ?)`,
        [wrongSignature, founder.publicKeyB64, peerId],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);

  it('rejects registering a peer for a key with no Member row (deferred MemberExists)', async () => {
    const { db } = await openStrand('c');
    const notAMember = freshKeyPair();

    // Self-signature is valid (registerMemberPeer self-signs), but no Member row
    // exists for this key, so the deferred MemberExists rejects at commit.
    await expect(
      registerMemberPeer(db, { memberKeyPair: notAMember, peerId: 'peer-ghost' }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);

  it('a member may register multiple distinct peers (multi-device) → one row per PeerId', async () => {
    const { db, founder } = await openStrand('c');

    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-phone' });
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-laptop' });

    expect(await tableCount(db, 'MemberPeer')).toBe(2);
    const peers = await db.get(
      'select count(1) as c from Strand.MemberPeer where MemberKey = ?',
      [founder.publicKeyB64],
    );
    expect(peers?.c).toBe(2);
  }, 30_000);

  it('re-registering the same (MemberKey, PeerId) is an insert-if-absent no-op (restart-safe)', async () => {
    const { db, founder } = await openStrand('c');

    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-stable' });
    // A second call (e.g. on founder restart) must not throw and must not duplicate
    // the row — the writer's existence guard skips the redundant insert (so it never
    // depends on the platform's PK-uniqueness rejection, which is not enforced in
    // bootstrap mode — see optimystic-insert-pk-uniqueness-not-enforced).
    await expect(
      registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-stable' }),
    ).resolves.toBeUndefined();

    expect(await tableCount(db, 'MemberPeer')).toBe(1);
  }, 30_000);

  it('a non-founder member admitted by authority can register its own peer (count > 1 branch)', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByAuthority(db, { authorityKeyPair: founder, memberKey: member.publicKeyB64 });

    await registerMemberPeer(db, { memberKeyPair: member, peerId: 'peer-member' });

    expect(await tableCount(db, 'MemberPeer')).toBe(1);
    const row = await db.get('select MemberKey, PeerId from Strand.MemberPeer');
    expect(row?.MemberKey).toBe(member.publicKeyB64);
    expect(row?.PeerId).toBe('peer-member');
  }, 30_000);

  it('rejects peer registration on an open strand (no Member can exist → MemberExists)', async () => {
    const { db } = await openStrand('o');
    const stranger = freshKeyPair();

    // Open strands seat no Member (Member is OnlyClosed), so MemberExists has nothing
    // to match and the peer insert is rejected.
    await expect(
      registerMemberPeer(db, { memberKeyPair: stranger, peerId: 'peer-open' }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);
});

// ── Phase 2: Authority rotation (add / remove admins) ─────────────────────────

/** Add `count` extra authorities (signed by the founder) and return their keypairs. */
async function addExtraAuthorities(db: Database, founder: AuthorityKeyPair, count: number): Promise<AuthorityKeyPair[]> {
  const extras: AuthorityKeyPair[] = [];
  for (let i = 0; i < count; i++) {
    const kp = freshKeyPair();
    await addAuthority(db, { byAuthorityKeyPair: founder, newAuthorityKey: kp.publicKeyB64 });
    extras.push(kp);
  }
  return extras;
}

describe('addAuthority', () => {
  it('an existing authority promotes a second authority (non-bootstrap signature branch)', async () => {
    const { db, founder } = await openStrand('c');
    const second = freshKeyPair();

    await addAuthority(db, { byAuthorityKeyPair: founder, newAuthorityKey: second.publicKeyB64 });

    // At commit the count is 2, so the `count(Authority) <= 1` bootstrap branch is
    // false — this genuinely passed via the existing-authority signature branch.
    expect(await tableCount(db, 'Authority')).toBe(2);
    const row = await db.get('select MemberKey from Strand.Authority where MemberKey = ?', [second.publicKeyB64]);
    expect(row?.MemberKey).toBe(second.publicKeyB64);
  }, 30_000);

  it('rejects an add whose signer is not an authority (no count<=1 shortcut once founder exists)', async () => {
    const { db } = await openStrand('c');
    const notAnAuthority = freshKeyPair();
    const target = freshKeyPair();

    await expect(
      addAuthority(db, { byAuthorityKeyPair: notAnAuthority, newAuthorityKey: target.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Authority')).toBe(1); // only the founder
  }, 30_000);

  it('rejects an add whose signature is over the wrong key (signature binding)', async () => {
    const { db, founder } = await openStrand('c');
    const target = freshKeyPair();
    const someOtherKey = freshKeyPair().publicKeyB64;

    // A real authority (founder) signs, but over a DIFFERENT key than the one being
    // inserted, so verify(digest(new.MemberKey=target), sig, founder) fails.
    const wrongSignature = signStrandPayload(someOtherKey, founder.privateKeyB64);

    await expect(
      db.exec(
        `insert into Strand.Authority (MemberKey)
           with context AuthorityKey = ?, Signature = ?
           values (?)`,
        [founder.publicKeyB64, wrongSignature, target.publicKeyB64],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Authority')).toBe(1);
  }, 30_000);

  it('rejects an authority add on an open strand (Authority is OnlyClosed)', async () => {
    const { db } = await openStrand('o');
    const target = freshKeyPair();

    // Open strands have no founding Authority and Authority is OnlyClosed; any add is rejected.
    await expect(
      addAuthority(db, { byAuthorityKeyPair: freshKeyPair(), newAuthorityKey: target.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Authority')).toBe(0);
  }, 30_000);
});

describe('removeAuthority', () => {
  // NOTE on what these prove: the writer builds a correctly-signed delete (the
  // existing-authority branch for admin removal, the former-authority self branch
  // for self-resignation — see removeAuthority's doc). HOWEVER, the optimystic
  // bootstrap-mode transactor does NOT currently evaluate deferred (subquery-bearing)
  // CHECK constraints on DELETE — `Authority.Authorized` is one — so the platform
  // accepts ANY delete regardless of signature (filed as
  // `optimystic-deferred-check-not-enforced-on-delete`, backlog; the KNOWN GAP test
  // below pins this). These two acceptance tests therefore currently assert that the
  // writer removes the correct row and leaves the others intact; once delete-side
  // constraint enforcement lands they will ALSO exercise the signature branches
  // unchanged (the founder/self signatures are already valid for those branches).
  it('an authority removes a DIFFERENT authority and leaves the other authorities intact', async () => {
    const { db, founder } = await openStrand('c');
    // 3 authorities total so removing one leaves 2 (≥ 2 after delete keeps the
    // `count(Authority) <= 1` bootstrap branch false, so once delete enforcement
    // lands this genuinely takes the existing-authority signature branch).
    const [a2, a3] = await addExtraAuthorities(db, founder, 2);
    expect(await tableCount(db, 'Authority')).toBe(3);

    await removeAuthority(db, { byAuthorityKeyPair: founder, targetAuthorityKey: a3.publicKeyB64 });

    expect(await tableCount(db, 'Authority')).toBe(2);
    expect(await db.get('select MemberKey from Strand.Authority where MemberKey = ?', [a3.publicKeyB64])).toBeUndefined();
    // The other authorities are untouched (only the targeted row was removed).
    expect(await db.get('select MemberKey from Strand.Authority where MemberKey = ?', [a2.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Authority where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('an authority resigns itself (self-targeted removal removes only its own row)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraAuthorities(db, founder, 2);
    expect(await tableCount(db, 'Authority')).toBe(3);

    await removeAuthority(db, { byAuthorityKeyPair: a2, targetAuthorityKey: a2.publicKeyB64 });

    expect(await tableCount(db, 'Authority')).toBe(2);
    expect(await db.get('select MemberKey from Strand.Authority where MemberKey = ?', [a2.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Authority where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  // KNOWN PLATFORM GAP — delete-side constraint enforcement is not implemented.
  //
  // `Authority.Authorized` (a deferred, subquery-bearing CHECK) SHOULD reject a
  // removal whose signer is neither an existing authority nor the target itself.
  // But the optimystic bootstrap-mode vtab transactor evaluates deferred CHECK
  // constraints only on INSERT, not on DELETE (the engine never re-checks the
  // constraint for the delete), so the delete is silently accepted — any party can
  // remove any Authority row. Proven directly: a delete carrying a null AuthorityKey
  // and null Signature still drops the row (see the probe rationale in the review
  // handoff). Filed as `optimystic-deferred-check-not-enforced-on-delete` (backlog),
  // a sibling of `optimystic-insert-pk-uniqueness-not-enforced`.
  //
  // This test pins the ACTUAL (insecure) behavior so it fails loudly the moment the
  // platform starts enforcing delete-side constraints — at which point these
  // assertions flip to `rejects.toThrow()` + an unchanged count of 3.
  it('KNOWN GAP: a non-authority removal currently SUCCEEDS (deferred CHECK not enforced on delete)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraAuthorities(db, founder, 2);
    const notAnAuthority = freshKeyPair();
    expect(await tableCount(db, 'Authority')).toBe(3);

    // Intended behavior: reject (no accepting branch matches; post-delete count 2
    // keeps the bootstrap branch false). Current behavior: resolves and removes the
    // row because the delete-side CHECK is never evaluated.
    await expect(
      removeAuthority(db, { byAuthorityKeyPair: notAnAuthority, targetAuthorityKey: a2.publicKeyB64 }),
    ).resolves.toBeUndefined();
    expect(await tableCount(db, 'Authority')).toBe(2); // a2 was removed despite no authorization
    expect(await db.get('select MemberKey from Strand.Authority where MemberKey = ?', [a2.publicKeyB64])).toBeUndefined();
  }, 30_000);
});
