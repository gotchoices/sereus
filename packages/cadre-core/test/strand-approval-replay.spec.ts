import { describe, it, expect, afterEach } from 'vitest';
import debug from 'debug';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import {
  bootstrapFounderMembership,
  addMemberByManager,
  revokeMember,
  addManager,
  removeManager,
  registerMemberPeer,
  removeMemberPeer,
  leaveStrand,
  signStrandApproval,
} from '../src/strand-membership-writer.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { SAppConfig } from '../src/types.js';

/**
 * The six CAPTURE-AND-REPLAY attacks the single-use stamp mechanism closes.
 *
 * Every one of R1-R6 below was reproduced as SUCCEEDING against a real closed
 * strand before `Strand.*` approvals were bound to a per-row `StampId` and paired
 * with a mandatory `Strand.Revocation` tombstone. Each test here performs the same
 * capture and replay and asserts the rejection, then runs the LEGITIMATE operation
 * the replay was derived from — so a rejection can never come from the strand
 * being in a state where the operation is impossible anyway.
 *
 * | #  | Captured approval                      | Replayed as                          | Rejector       |
 * |----|----------------------------------------|--------------------------------------|----------------|
 * | R1 | addManager promotion of X at gen 1     | re-insert Manager(X, 1) after removal| NotRevoked     |
 * | R2 | removeManager removal of X             | delete Manager(X) after re-promotion | Authorized     |
 * | R3 | X's own resignation                    | delete Manager(X) after re-promotion | Authorized     |
 * | R4 | addMemberByManager admission of X      | re-insert Member(X) after revocation | NotRevoked     |
 * | R5 | revokeMember removal of X              | delete Member(X) after re-admission  | Authorized     |
 * | R6 | registerMemberPeer binding (M, P)      | re-insert (M, P) after removal       | NotRevoked     |
 * | R7 | X's own departure (leaveStrand)        | delete Member(X) after re-admission  | Authorized     |
 *
 * "Capturing" an approval means re-minting the signature the writer itself
 * produced: the same signer over the same digest element vector, read off the LIVE
 * row before the legitimate removal. Ed25519 is deterministic (RFC 8032), so the
 * bytes are identical to the ones that authorized the real operation — an attacker
 * who observed that write holds exactly this. That determinism is the load-bearing
 * assumption of every capture here, so it is pinned rather than asserted in prose —
 * see 'a re-minted approval IS the captured one' below.
 *
 * PIN DISCIPLINE. Replays that re-INSERT a retired stamp pin `/NotRevoked/`: every
 * other constraint on those inserts genuinely passes (the captured signature still
 * verifies — that is the whole point), so the name identifies the one gate that
 * fired. Replays that DELETE pin `/Authorized/`, but only because each supplies a
 * valid same-transaction tombstone over the row's CURRENT stamp; without one,
 * `RevocationRecorded` fires alongside and the reported constraint would be engine
 * evaluation order rather than the gate under test. `Strand.Revocation` carries an
 * `Authorized` constraint of its OWN, and the engine's message names the constraint
 * without its table (`CHECK constraint failed: Authorized`), so `/Authorized/` alone
 * cannot tell the two apart — the control test below commits the identical
 * delete+tombstone shape with a VALID approval, proving the tombstone leg is never
 * the constraint the replays trip.
 *
 * Every test runs against a REAL closed strand DB in bootstrap mode (libp2p node +
 * MemoryRawStorage + the optimystic local transactor) via `connectToStrand` — the
 * same path `StrandDatabase` uses.
 */

const log = debug('sereus:cadre:test:strand-approval-replay');

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
function freshKeyPair(): Ed25519KeyPair {
  const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
  const publicKeyB64 = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
  return { privateKeyB64, publicKeyB64 };
}

type StrandTable = 'Member' | 'MemberPeer' | 'Manager' | 'Revocation';

async function tableCount(db: Database, table: StrandTable): Promise<number> {
  for await (const row of db.eval(`select count(1) as c from Strand.${table}`)) {
    return (row as { c: number }).c;
  }
  return 0;
}

interface Strand {
  db: Database;
  strandId: string;
  /** The founder keypair — Member #1 and the sole founding Manager (generation 0). */
  founder: Ed25519KeyPair;
  shutdown: () => Promise<void>;
}

const opened: Strand[] = [];

/** Open a closed strand DB in bootstrap mode and run the founder bootstrap. */
async function openStrand(): Promise<Strand> {
  const strandId = randomUUID();
  const storage = new MemoryRawStorage();
  const db = new Database();
  const result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });
  const founder = strandMemberKeyPair(await generateStrandMemberKey());
  await bootstrapFounderMembership(db, {
    strandId,
    type: 'c',
    sApp: makeSAppConfig(),
    founderKeyPair: founder,
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

/** Run `statements` in one explicit transaction: commit on success, rollback on failure. */
async function inTransaction(db: Database, statements: () => Promise<void>): Promise<void> {
  await db.beginTransaction();
  try {
    await statements();
    await db.commit();
  } catch (error) {
    // A failed commit() already tore the transaction down, so rollback() throws
    // "no transaction active" — log it rather than masking the real cause.
    try {
      await db.rollback();
    } catch (rollbackError) {
      log('Rollback after a rejected transaction was a no-op: %s', rollbackError);
    }
    throw error;
  }
}

// ── Live-row readers (unfiltered scan + JS filter, the writer's scan-not-seek idiom) ──

async function memberStamp(db: Database, key: string): Promise<string> {
  for await (const row of db.eval('select Key, StampId from Strand.Member')) {
    if (row.Key === key) return row.StampId as string;
  }
  throw new Error(`no Member row for ${key}`);
}

async function managerRow(db: Database, key: string): Promise<{ generation: number; stampId: string }> {
  for await (const row of db.eval('select MemberKey, Generation, StampId from Strand.Manager')) {
    if (row.MemberKey === key) return { generation: Number(row.Generation), stampId: row.StampId as string };
  }
  throw new Error(`no Manager row for ${key}`);
}

async function memberPeerStamp(db: Database, memberKey: string, peerId: string): Promise<string> {
  for await (const row of db.eval('select MemberKey, PeerId, StampId from Strand.MemberPeer')) {
    if (row.MemberKey === memberKey && row.PeerId === peerId) return row.StampId as string;
  }
  throw new Error(`no MemberPeer row for (${memberKey}, ${peerId})`);
}

async function isMember(db: Database, key: string): Promise<boolean> {
  return (await db.get('select Key from Strand.Member where Key = ?', [key])) != null;
}

async function isManager(db: Database, key: string): Promise<boolean> {
  return (await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [key])) != null;
}

/**
 * File the `Strand.Revocation` tombstone retiring `stampId`, signed by `retiree`.
 * Every replayed DELETE below rides one of these so `RevocationRecorded` is
 * satisfied and the `/Authorized/` pin names the authorization gate alone. (The
 * writer's own tombstone helper is module-private, so the idiom is duplicated
 * here — same as in the two sibling specs.)
 */
async function fileTombstone(
  db: Database,
  tableName: 'Member' | 'Manager' | 'MemberPeer',
  stampId: string,
  retiree: Ed25519KeyPair,
): Promise<void> {
  const signature = signStrandApproval(['Strand.Revocation', 'retire', tableName, stampId], retiree.privateKeyB64);
  await db.exec(
    `insert into Strand.Revocation (TableName, StampId)
       with context MemberKey = ?, Signature = ?
       values (?, ?)`,
    [retiree.publicKeyB64, signature, tableName, stampId],
  );
}

/** Seat a fresh member (admitted by the founder) and return its keypair. */
async function seatMember(db: Database, founder: Ed25519KeyPair): Promise<Ed25519KeyPair> {
  const member = freshKeyPair();
  await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
  return member;
}

// ── Controls: the two premises every pin below rests on ──────────────────────

describe('replay-pin premises', () => {
  it('a re-minted approval IS the captured one (ed25519 signing is deterministic)', () => {
    // Nothing here can intercept the bytes the writers actually emit, so every
    // capture below re-mints them. That is only an attacker's real capability if
    // signing the same digest with the same key always yields the same signature —
    // true for ed25519 (RFC 8032 derives the nonce from the key and message), and
    // pinned here so a future signer swap that introduced randomness would fail
    // loudly instead of quietly turning R1-R7 into strawmen.
    const signer = freshKeyPair();
    const vector = ['Strand.Manager', 'add', 'member-key-b64url', 3, 'stamp-abc'];
    expect(signStrandApproval(vector, signer.privateKeyB64))
      .toBe(signStrandApproval(vector, signer.privateKeyB64));
  });

  it('the delete+tombstone shape the DELETE replays ride is itself accepted', async () => {
    // R2/R3/R5/R6/R7 assert `/Authorized/` on a transaction pairing a raw delete
    // with `fileTombstone`. `Strand.Revocation.Authorized` shares that name, so the
    // regex alone cannot prove which constraint refused. This runs the SAME shape —
    // raw delete + the same helper — against all three guarded tables with a VALID
    // approval, and it commits: the tombstone leg passes on its own, so the only
    // input that differs in a replay is the delete's captured signature.
    const { db, founder } = await openStrand();
    const x = await seatMember(db, founder);

    await addManager(db, { byManagerKeyPair: founder, newManagerKey: x.publicKeyB64 });
    const managerStamp = (await managerRow(db, x.publicKeyB64)).stampId;
    await inTransaction(db, async () => {
      const removal = signStrandApproval(
        ['Strand.Manager', 'remove', x.publicKeyB64, managerStamp],
        founder.privateKeyB64,
      );
      await db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, removal, x.publicKeyB64],
      );
      await fileTombstone(db, 'Manager', managerStamp, founder);
    });
    expect(await isManager(db, x.publicKeyB64)).toBe(false);

    const peerId = 'peer-control';
    await registerMemberPeer(db, { memberKeyPair: x, peerId });
    const peerStamp = await memberPeerStamp(db, x.publicKeyB64, peerId);
    await inTransaction(db, async () => {
      const unbind = signStrandApproval(
        ['Strand.MemberPeer', 'remove', x.publicKeyB64, peerId, peerStamp],
        x.privateKeyB64,
      );
      await db.exec(
        `delete from Strand.MemberPeer
           with context Signature = ?, ManagerKey = null, ManagerSignature = null
           where MemberKey = ? and PeerId = ?`,
        [unbind, x.publicKeyB64, peerId],
      );
      await fileTombstone(db, 'MemberPeer', peerStamp, x);
    });
    expect(await tableCount(db, 'MemberPeer')).toBe(0);

    const stamp = await memberStamp(db, x.publicKeyB64);
    await inTransaction(db, async () => {
      const eviction = signStrandApproval(
        ['Strand.Member', 'remove', x.publicKeyB64, stamp],
        founder.privateKeyB64,
      );
      await db.exec(
        `delete from Strand.Member
           with context ManagerKey = ?, ManagerSignature = ?, MemberSignature = null
           where Key = ?`,
        [founder.publicKeyB64, eviction, x.publicKeyB64],
      );
      await fileTombstone(db, 'Member', stamp, founder);
    });
    expect(await isMember(db, x.publicKeyB64)).toBe(false);
  }, 30_000);
});

// ── R1 / R2 / R3: Manager promotion, removal, and resignation approvals ───────

describe('Strand.Manager approval replay', () => {
  it('R1: a captured promotion cannot re-seat a removed manager (NotRevoked)', async () => {
    const { db, founder } = await openStrand();
    const x = await seatMember(db, founder);
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: x.publicKeyB64 });

    // Capture the promotion approval off the live row: the same founder signature
    // over the same (key, generation, stamp) vector addManager itself minted.
    const seated = await managerRow(db, x.publicKeyB64);
    expect(seated.generation).toBe(1);
    const capturedPromotion = signStrandApproval(
      ['Strand.Manager', 'add', x.publicKeyB64, seated.generation, seated.stampId],
      founder.privateKeyB64,
    );

    // X is legitimately demoted, which retires its stamp into Revocation.
    await removeManager(db, { byManagerKeyPair: founder, targetManagerKey: x.publicKeyB64 });
    expect(await isManager(db, x.publicKeyB64)).toBe(false);
    expect(await tableCount(db, 'Revocation')).toBe(1);

    // THE REPLAY: re-inserting the exact removed row. The promotion branch of
    // Authorized still accepts (the founder's generation 0 is below 1 and the
    // digest matches byte for byte) — NotRevoked is what refuses it, so the name
    // pins the retired stamp as the load-bearing gate, not the signature.
    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = ?, Signature = ?
           values (?, ?, ?)`,
        [founder.publicKeyB64, capturedPromotion, x.publicKeyB64, seated.generation, seated.stampId],
      ),
    ).rejects.toThrow(/NotRevoked/);
    expect(await isManager(db, x.publicKeyB64)).toBe(false);
    expect(await tableCount(db, 'Manager')).toBe(1); // the founder alone

    // POSITIVE PATH: a genuine re-promotion still works — a fresh stamp and a
    // fresh signature over it, at the same generation.
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: x.publicKeyB64 });
    const reseated = await managerRow(db, x.publicKeyB64);
    expect(reseated.generation).toBe(1);
    expect(reseated.stampId).not.toBe(seated.stampId);
  }, 30_000);

  it('R2: a captured manager removal cannot demote a re-promoted manager (Authorized)', async () => {
    const { db, founder } = await openStrand();
    const x = await seatMember(db, founder);
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: x.publicKeyB64 });
    const firstStamp = (await managerRow(db, x.publicKeyB64)).stampId;

    // Capture the founder's removal approval over the FIRST incarnation, then spend
    // it legitimately (removeManager mints this identical signature).
    const capturedRemoval = signStrandApproval(
      ['Strand.Manager', 'remove', x.publicKeyB64, firstStamp],
      founder.privateKeyB64,
    );
    await removeManager(db, { byManagerKeyPair: founder, targetManagerKey: x.publicKeyB64 });

    // X is re-promoted — a new incarnation under a new stamp.
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: x.publicKeyB64 });
    const secondStamp = (await managerRow(db, x.publicKeyB64)).stampId;
    expect(secondStamp).not.toBe(firstStamp);

    // THE REPLAY: the captured approval presented against the new row. The digest
    // binds old.StampId, which is now the SECOND stamp, so verify fails. A founder
    // tombstone over that second stamp rides the transaction, so RevocationRecorded
    // and Revocation's own checks all pass and Authorized is the one rejector.
    await expect(inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, capturedRemoval, x.publicKeyB64],
      );
      await fileTombstone(db, 'Manager', secondStamp, founder);
    })).rejects.toThrow(/Authorized/);
    expect(await isManager(db, x.publicKeyB64)).toBe(true);
    expect(await tableCount(db, 'Manager')).toBe(2);

    // POSITIVE PATH: the same founder removing the same manager through the writer,
    // which signs over the CURRENT stamp, succeeds.
    await removeManager(db, { byManagerKeyPair: founder, targetManagerKey: x.publicKeyB64 });
    expect(await isManager(db, x.publicKeyB64)).toBe(false);
  }, 30_000);

  it('R3: a captured resignation cannot demote its re-promoted signer (Authorized)', async () => {
    const { db, founder } = await openStrand();
    const x = await seatMember(db, founder);
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: x.publicKeyB64 });
    const firstStamp = (await managerRow(db, x.publicKeyB64)).stampId;

    // X's own resignation proof, captured and then legitimately spent.
    const capturedResignation = signStrandApproval(
      ['Strand.Manager', 'resign', x.publicKeyB64, firstStamp],
      x.privateKeyB64,
    );
    await removeManager(db, { byManagerKeyPair: x, targetManagerKey: x.publicKeyB64 });

    await addManager(db, { byManagerKeyPair: founder, newManagerKey: x.publicKeyB64 });
    const secondStamp = (await managerRow(db, x.publicKeyB64)).stampId;
    expect(secondStamp).not.toBe(firstStamp);

    // THE REPLAY, mounted by a party that never held X's private key: it names X as
    // context.ManagerKey (the resignation branch requires old.MemberKey =
    // context.ManagerKey) and presents X's captured proof. That branch is the only
    // reachable one — the admin-removal branch excludes an authorizer equal to the
    // target — and it hashes the SECOND stamp, so the captured signature fails.
    await expect(inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [x.publicKeyB64, capturedResignation, x.publicKeyB64],
      );
      await fileTombstone(db, 'Manager', secondStamp, founder);
    })).rejects.toThrow(/Authorized/);
    expect(await isManager(db, x.publicKeyB64)).toBe(true);

    // POSITIVE PATH: X resigning again for real (a fresh self-signature over the
    // current stamp) still works.
    await removeManager(db, { byManagerKeyPair: x, targetManagerKey: x.publicKeyB64 });
    expect(await isManager(db, x.publicKeyB64)).toBe(false);
  }, 30_000);
});

// ── R4 / R5: Member admission and revocation approvals ───────────────────────

describe('Strand.Member approval replay', () => {
  it('R4: a captured admission cannot re-admit a revoked member (NotRevoked)', async () => {
    const { db, founder } = await openStrand();
    const x = await seatMember(db, founder);
    const firstStamp = await memberStamp(db, x.publicKeyB64);

    // The founder's admission approval, exactly as addMemberByManager minted it.
    const capturedAdmission = signStrandApproval(
      ['Strand.Member', 'add', x.publicKeyB64, firstStamp],
      founder.privateKeyB64,
    );

    await revokeMember(db, { managerKeyPair: founder, memberKey: x.publicKeyB64 });
    expect(await isMember(db, x.publicKeyB64)).toBe(false);

    // THE REPLAY: re-seating the exact revoked row. The direct-manager branch of
    // Authorized still verifies (same key, same stamp, same signer), so NotRevoked
    // is the sole rejector — the pin proves the stamp retirement is what holds.
    await expect(
      db.exec(
        `insert into Strand.Member (Key, StampId)
           with context ManagerKey = ?, ManagerSignature = ?, MemberSignature = null
           values (?, ?)`,
        [founder.publicKeyB64, capturedAdmission, x.publicKeyB64, firstStamp],
      ),
    ).rejects.toThrow(/NotRevoked/);
    expect(await isMember(db, x.publicKeyB64)).toBe(false);
    expect(await tableCount(db, 'Member')).toBe(1); // the founder alone

    // POSITIVE PATH: a fresh manager admission re-admits X under a new stamp.
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: x.publicKeyB64 });
    expect(await memberStamp(db, x.publicKeyB64)).not.toBe(firstStamp);
  }, 30_000);

  it('R5: a captured revocation cannot evict a re-admitted member (Authorized)', async () => {
    const { db, founder } = await openStrand();
    const x = await seatMember(db, founder);
    const firstStamp = await memberStamp(db, x.publicKeyB64);

    // The founder's eviction approval over the FIRST incarnation, then spent.
    const capturedRevocation = signStrandApproval(
      ['Strand.Member', 'remove', x.publicKeyB64, firstStamp],
      founder.privateKeyB64,
    );
    await revokeMember(db, { managerKeyPair: founder, memberKey: x.publicKeyB64 });

    await addMemberByManager(db, { managerKeyPair: founder, memberKey: x.publicKeyB64 });
    const secondStamp = await memberStamp(db, x.publicKeyB64);
    expect(secondStamp).not.toBe(firstStamp);

    // THE REPLAY against the new incarnation. MinOneMember (the founder remains)
    // and NotAManager (X holds no Manager row) pass, and the founder's tombstone
    // over the current stamp satisfies RevocationRecorded — Authorized alone rejects.
    await expect(inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.Member
           with context ManagerKey = ?, ManagerSignature = ?, MemberSignature = null
           where Key = ?`,
        [founder.publicKeyB64, capturedRevocation, x.publicKeyB64],
      );
      await fileTombstone(db, 'Member', secondStamp, founder);
    })).rejects.toThrow(/Authorized/);
    expect(await isMember(db, x.publicKeyB64)).toBe(true);

    // POSITIVE PATH: the writer's revocation, signing over the current stamp, works.
    await revokeMember(db, { managerKeyPair: founder, memberKey: x.publicKeyB64 });
    expect(await isMember(db, x.publicKeyB64)).toBe(false);
  }, 30_000);

  it('R7: a captured departure cannot evict its re-admitted signer (Authorized)', async () => {
    // The self-departure branch is the one Member delete path R5 does not reach: it
    // verifies against old.Key itself via context.MemberSignature, with no manager
    // involved. A member that legitimately left and was later re-admitted must not
    // be evictable by anyone replaying the leave proof it published on the way out.
    const { db, founder } = await openStrand();
    const x = await seatMember(db, founder);
    const firstStamp = await memberStamp(db, x.publicKeyB64);

    const capturedDeparture = signStrandApproval(
      ['Strand.Member', 'leave', x.publicKeyB64, firstStamp],
      x.privateKeyB64,
    );
    await leaveStrand(db, { memberKeyPair: x });
    expect(await isMember(db, x.publicKeyB64)).toBe(false);

    await addMemberByManager(db, { managerKeyPair: founder, memberKey: x.publicKeyB64 });
    const secondStamp = await memberStamp(db, x.publicKeyB64);
    expect(secondStamp).not.toBe(firstStamp);

    // THE REPLAY, mounted by a party that never held X's key. The manager branch is
    // unreachable (context.ManagerKey is null), so the leave branch is the only one
    // left, and it hashes the SECOND stamp — the captured proof does not verify. The
    // founder's tombstone over that stamp rides along, so Authorized alone rejects.
    await expect(inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.Member
           with context ManagerKey = null, ManagerSignature = null, MemberSignature = ?
           where Key = ?`,
        [capturedDeparture, x.publicKeyB64],
      );
      await fileTombstone(db, 'Member', secondStamp, founder);
    })).rejects.toThrow(/Authorized/);
    expect(await isMember(db, x.publicKeyB64)).toBe(true);

    // POSITIVE PATH: X leaving again for real, over the current stamp, still works.
    await leaveStrand(db, { memberKeyPair: x });
    expect(await isMember(db, x.publicKeyB64)).toBe(false);
  }, 30_000);
});

// ── R6: MemberPeer binding approvals ─────────────────────────────────────────

describe('Strand.MemberPeer approval replay', () => {
  it('R6: a captured peer registration cannot re-bind a cleared peer, nor authorize its removal', async () => {
    const { db, founder } = await openStrand();
    const member = await seatMember(db, founder);
    const peerId = 'peer-replay-r6';
    await registerMemberPeer(db, { memberKeyPair: member, peerId });
    const firstStamp = await memberPeerStamp(db, member.publicKeyB64, peerId);

    // The member's own registration approval, exactly as registerMemberPeer minted it.
    const capturedRegistration = signStrandApproval(
      ['Strand.MemberPeer', 'add', member.publicKeyB64, peerId, firstStamp],
      member.privateKeyB64,
    );

    await removeMemberPeer(db, { memberKeyPair: member, peerId });
    expect(await tableCount(db, 'MemberPeer')).toBe(0);

    // THE REPLAY: re-binding the cleared row. MemberExists passes (the member is
    // still seated) and the add branch of Authorized still verifies, so NotRevoked
    // is the sole rejector.
    await expect(
      db.exec(
        `insert into Strand.MemberPeer (MemberKey, PeerId, StampId)
           with context Signature = ?, ManagerKey = null, ManagerSignature = null
           values (?, ?, ?)`,
        [capturedRegistration, member.publicKeyB64, peerId, firstStamp],
      ),
    ).rejects.toThrow(/NotRevoked/);
    expect(await tableCount(db, 'MemberPeer')).toBe(0);

    // POSITIVE PATH: a genuine re-registration under a fresh stamp.
    await registerMemberPeer(db, { memberKeyPair: member, peerId });
    const secondStamp = await memberPeerStamp(db, member.publicKeyB64, peerId);
    expect(secondStamp).not.toBe(firstStamp);

    // The other half of R6: registration and removal are now DISTINCT digests, so a
    // registration approval over the CURRENT stamp — the strongest thing the member
    // itself can hand out without consenting to a removal — cannot delete the row.
    // The self-remove branch hashes the 'remove' tag, so verify fails; the member's
    // tombstone rides the transaction so Authorized is the one rejector.
    const currentRegistration = signStrandApproval(
      ['Strand.MemberPeer', 'add', member.publicKeyB64, peerId, secondStamp],
      member.privateKeyB64,
    );
    await expect(inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.MemberPeer
           with context Signature = ?, ManagerKey = null, ManagerSignature = null
           where MemberKey = ? and PeerId = ?`,
        [currentRegistration, member.publicKeyB64, peerId],
      );
      await fileTombstone(db, 'MemberPeer', secondStamp, member);
    })).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'MemberPeer')).toBe(1);

    // POSITIVE PATH: the writer's remove-tagged signature over the same stamp clears it.
    await removeMemberPeer(db, { memberKeyPair: member, peerId });
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);
});
