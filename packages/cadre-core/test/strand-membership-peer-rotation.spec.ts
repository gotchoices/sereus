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
  registerMemberPeer,
  listMemberPeers,
  removeMemberPeer,
  addManager,
  removeManager,
  signStrandApproval,
  generateStrandStampId,
} from '../src/strand-membership-writer.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { SAppConfig } from '../src/types.js';

/**
 * Component coverage for the two remaining founder-reachable writers:
 * `MemberPeer` registration (a member binds its own network nodes, self-signed) and
 * `Manager` rotation (an existing manager promotes/removes admins, or a
 * manager resigns itself). Every test runs against a REAL closed strand DB in
 * bootstrap mode (libp2p node + MemoryRawStorage + the optimystic local transactor)
 * via `connectToStrand` — the same path `StrandDatabase` uses — so the real
 * apply/DML/deferred-constraint path is exercised, not a fake.
 *
 * The founder is bootstrapped first (Member #1 + the sole founding Manager), so every
 * later rotation runs past `Manager.Authorized`'s bootstrap branch — which is gated to
 * INSERTs in the founding state — and genuinely exercises signature verification.
 */

const log = debug('sereus:cadre:test:strand-rotation');

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

type StrandTable = 'Header' | 'Member' | 'MemberPeer' | 'Manager';

async function tableCount(db: Database, table: StrandTable): Promise<number> {
  for await (const row of db.eval(`select count(1) as c from Strand.${table}`)) {
    return (row as { c: number }).c;
  }
  return 0;
}

interface Strand {
  db: Database;
  strandId: string;
  /** The founder keypair — Member #1 and the sole founding Manager. */
  founder: Ed25519KeyPair;
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

/** The live StampId of one Manager row, via unfiltered scan + JS filter (the writer's scan-not-seek idiom). */
async function managerStamp(db: Database, key: string): Promise<string> {
  for await (const row of db.eval('select MemberKey, StampId from Strand.Manager')) {
    if (row.MemberKey === key) return row.StampId as string;
  }
  throw new Error(`no Manager row for ${key}`);
}

/** The live StampId of one MemberPeer row, via unfiltered scan + JS filter. */
async function memberPeerStamp(db: Database, memberKey: string, peerId: string): Promise<string> {
  for await (const row of db.eval('select MemberKey, PeerId, StampId from Strand.MemberPeer')) {
    if (row.MemberKey === memberKey && row.PeerId === peerId) return row.StampId as string;
  }
  throw new Error(`no MemberPeer row for (${memberKey}, ${peerId})`);
}

/**
 * File the `Strand.Revocation` tombstone retiring `stampId`, signed by `retiree`.
 * Raw deletes that pin `/Authorized/` pair with one of these in the same
 * transaction — otherwise `RevocationRecorded` fires too and the reported
 * constraint becomes engine evaluation order. A retiree that is not a committed
 * member fails `Revocation.Authorized`, which shares the `Authorized` name, so
 * an attacker-signed tombstone keeps that pin truthful either way.
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
    // but the Signature is made by an unrelated key over the exact add-tagged digest —
    // so the Authorized check (verify against MemberKey itself) fails. Authorized
    // carries a subquery (the manager-cleanup branch), so Quereus auto-defers it: the
    // rejection lands at commit, not at statement time.
    const stampId = generateStrandStampId();
    const wrongSignature = signStrandApproval(
      ['Strand.MemberPeer', 'add', founder.publicKeyB64, peerId, stampId],
      impostor.privateKeyB64,
    );

    await expect(
      db.exec(
        `insert into Strand.MemberPeer (MemberKey, PeerId, StampId)
           with context Signature = ?, ManagerKey = null, ManagerSignature = null
           values (?, ?, ?)`,
        [wrongSignature, founder.publicKeyB64, peerId, stampId],
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
    // the row — the writer's existence guard skips the redundant insert, so the
    // restart path never has to catch the platform's duplicate-PK rejection.
    await expect(
      registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-stable' }),
    ).resolves.toBeUndefined();

    expect(await tableCount(db, 'MemberPeer')).toBe(1);
  }, 30_000);

  it('re-registering ONE of a member\'s peers skips only that peer (siblings + new peers unaffected)', async () => {
    const { db, founder } = await openStrand('c');

    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-phone' });
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-laptop' });
    expect(await tableCount(db, 'MemberPeer')).toBe(2);

    // The existence guard scans this member's peers, so `peer-laptop` is among the
    // rows it walks — an incorrect PeerId comparison would false-positive here.
    await expect(
      registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-phone' }),
    ).resolves.toBeUndefined();
    expect(await tableCount(db, 'MemberPeer')).toBe(2);

    // A genuinely new PeerId under the same member still inserts.
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-tablet' });
    expect(await tableCount(db, 'MemberPeer')).toBe(3);
  }, 30_000);

  it('two different members may register the SAME PeerId (guard keys on MemberKey too)', async () => {
    const { db, founder } = await openStrand('c');
    const second = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: second.publicKeyB64 });

    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-shared' });
    // The second member's registration must NOT be skipped just because some other
    // member already registered `peer-shared` — the guard re-checks MemberKey in JS.
    await registerMemberPeer(db, { memberKeyPair: second, peerId: 'peer-shared' });

    expect(await tableCount(db, 'MemberPeer')).toBe(2);
    // Per-MemberKey counts (not a bare table count) prove a row landed for EACH member.
    const founderPeers = await db.get(
      'select count(1) as c from Strand.MemberPeer where MemberKey = ?',
      [founder.publicKeyB64],
    );
    expect(founderPeers?.c).toBe(1);
    const secondPeers = await db.get(
      'select count(1) as c from Strand.MemberPeer where MemberKey = ?',
      [second.publicKeyB64],
    );
    expect(secondPeers?.c).toBe(1);
  }, 30_000);

  it('a non-founder member admitted by manager can register its own peer (count > 1 branch)', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });

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

// ── Phase 1b: MemberPeer removal (self-signed, or manager cleanup) ───────────
//
// `MemberPeer` rows do NOT cascade when a member is revoked — `MemberExists` is
// `on insert, update` only and nothing deletes them — so a revoked member's peer
// bindings survive as orphans. Only that member can sign the self branch, and a
// member removed against its will has no reason to cooperate, so `Authorized`
// carries a second branch letting a `committed.Manager` clear ANOTHER member's
// binding over a remove-tagged digest.

describe('removeMemberPeer', () => {
  it('a member deletes its OWN peer binding (deletes are signature-checked, not rejected)', async () => {
    const { db, founder } = await openStrand('c');
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-own' });
    expect(await tableCount(db, 'MemberPeer')).toBe(1);

    await removeMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-own' });

    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);

  it('a stranger cannot delete ANOTHER member\'s peer binding (neither branch is satisfied)', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    await registerMemberPeer(db, { memberKeyPair: member, peerId: 'peer-victim' });
    const stranger = freshKeyPair();

    // Route 1 — via the writer's manager branch: the stranger holds no Manager row, so
    // the `committed.Manager` lookup finds nothing and `Signature` is null (verify → false).
    await expect(
      removeMemberPeer(db, { managerKeyPair: stranger, memberKey: member.publicKeyB64, peerId: 'peer-victim' }),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'MemberPeer')).toBe(1);

    // Route 2 — raw, aiming at the SELF branch: a correctly-shaped remove-tagged
    // signature over the row's LIVE stamp, but minted by the wrong key. The branch
    // verifies against `old.MemberKey` (the victim), so the stranger's signature
    // cannot stand in for the member's own. A founder-filed tombstone rides the same
    // transaction so RevocationRecorded is satisfied and Authorized is the one rejector.
    const victimStamp = await memberPeerStamp(db, member.publicKeyB64, 'peer-victim');
    const wrongSignature = signStrandApproval(
      ['Strand.MemberPeer', 'remove', member.publicKeyB64, 'peer-victim', victimStamp],
      stranger.privateKeyB64,
    );
    await expect(inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.MemberPeer
           with context Signature = ?, ManagerKey = null, ManagerSignature = null
           where MemberKey = ? and PeerId = ?`,
        [wrongSignature, member.publicKeyB64, 'peer-victim'],
      );
      await fileTombstone(db, 'MemberPeer', victimStamp, founder);
    })).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'MemberPeer')).toBe(1);
  }, 30_000);

  it('peer rows SURVIVE their member\'s revocation, and a manager-signed cleanup clears them', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    await registerMemberPeer(db, { memberKeyPair: member, peerId: 'peer-orphan' });
    expect(await tableCount(db, 'Member')).toBe(2);

    // The founder stays (MinOneMember) and the second member holds no Manager row
    // (NotAManager), so the revocation is accepted.
    await revokeMember(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    expect(await tableCount(db, 'Member')).toBe(1);

    // Nothing cascaded: the binding is now an orphan naming a MemberKey with no Member row.
    expect(await tableCount(db, 'MemberPeer')).toBe(1);

    // The departed member would never sign this, so the manager branch is the only
    // way the row can ever be cleared.
    await removeMemberPeer(db, { managerKeyPair: founder, memberKey: member.publicKeyB64, peerId: 'peer-orphan' });
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);

  it('a manager may also clear a STILL-PRESENT member\'s binding (branch is not gated on removal)', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    await registerMemberPeer(db, { memberKeyPair: member, peerId: 'peer-live' });

    // Deliberate: the manager branch carries no "member is gone" condition, matching
    // "any manager can remove any member". A manager can evict a device without
    // evicting its owner.
    await removeMemberPeer(db, { managerKeyPair: founder, memberKey: member.publicKeyB64, peerId: 'peer-live' });

    expect(await tableCount(db, 'MemberPeer')).toBe(0);
    expect(await tableCount(db, 'Member')).toBe(2); // the member itself is untouched
  }, 30_000);

  it('a register-peer signature cannot be replayed as a manager remove-peer signature', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    await registerMemberPeer(db, { memberKeyPair: member, peerId: 'peer-replay' });

    // A REAL manager signs the add-tagged registration digest over another member's
    // LIVE row (same stamp) and presents it as the removal approval. The manager
    // branch verifies the manager-remove-tagged digest instead, so the two approvals
    // can never stand in for one another — every branch (self add, self remove,
    // manager remove) now carries a distinct action tag, so this holds for the self
    // branch too. A founder tombstone rides the transaction to keep Authorized the
    // one rejector.
    const liveStamp = await memberPeerStamp(db, member.publicKeyB64, 'peer-replay');
    const registrationShaped = signStrandApproval(
      ['Strand.MemberPeer', 'add', member.publicKeyB64, 'peer-replay', liveStamp],
      founder.privateKeyB64,
    );
    await expect(inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.MemberPeer
           with context Signature = null, ManagerKey = ?, ManagerSignature = ?
           where MemberKey = ? and PeerId = ?`,
        [founder.publicKeyB64, registrationShaped, member.publicKeyB64, 'peer-replay'],
      );
      await fileTombstone(db, 'MemberPeer', liveStamp, founder);
    })).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'MemberPeer')).toBe(1);

    // The properly manager-remove-tagged signature from the SAME manager over the SAME
    // row + stamp is accepted — proving the rejection above was the action tagging,
    // nothing else.
    const removeTagged = signStrandApproval(
      ['Strand.MemberPeer', 'manager-remove', member.publicKeyB64, 'peer-replay', liveStamp],
      founder.privateKeyB64,
    );
    await inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.MemberPeer
           with context Signature = null, ManagerKey = ?, ManagerSignature = ?
           where MemberKey = ? and PeerId = ?`,
        [founder.publicKeyB64, removeTagged, member.publicKeyB64, 'peer-replay'],
      );
      await fileTombstone(db, 'MemberPeer', liveStamp, founder);
    });
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);

  it('removing ONE peer leaves the member\'s other peers intact', async () => {
    const { db, founder } = await openStrand('c');
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-phone' });
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-laptop' });
    expect(await tableCount(db, 'MemberPeer')).toBe(2);

    await removeMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-phone' });

    expect(await tableCount(db, 'MemberPeer')).toBe(1);
    const row = await db.get('select PeerId from Strand.MemberPeer');
    expect(row?.PeerId).toBe('peer-laptop');
  }, 30_000);

  it('removing an already-absent binding is a quiet no-op (delete-if-present guard)', async () => {
    const { db, founder } = await openStrand('c');
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-once' });

    await removeMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-once' });
    // A repeated (or restarted) cleanup must not throw — the mirror of
    // registerMemberPeer's insert-if-absent.
    await expect(
      removeMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-once' }),
    ).resolves.toBeUndefined();
    // Never-registered is the same quiet no-op, on both branches.
    await expect(
      removeMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-never' }),
    ).resolves.toBeUndefined();
    await expect(
      removeMemberPeer(db, { managerKeyPair: founder, memberKey: freshKeyPair().publicKeyB64, peerId: 'peer-never' }),
    ).resolves.toBeUndefined();

    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);

  it('a member cannot hijack another member\'s binding via UPDATE (NoUpdate)', async () => {
    const { db, founder } = await openStrand('c');
    const victim = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: victim.publicKeyB64 });
    await registerMemberPeer(db, { memberKeyPair: victim, peerId: 'peer-target' });

    // Without NoUpdate this SUCCEEDED: Authorized reads the NEW image, so an attacker
    // re-points the victim's row at its OWN key and signs only over its own new values —
    // clearing a binding it holds no signature to delete. The victim never consented.
    // The digest shape is irrelevant here (NoUpdate fires before any signature check),
    // so a well-formed add-tagged approval over a fresh stamp is the strongest attempt.
    const stolen = signStrandApproval(
      ['Strand.MemberPeer', 'add', founder.publicKeyB64, 'peer-target', generateStrandStampId()],
      founder.privateKeyB64,
    );
    await expect(
      db.exec(
        `update Strand.MemberPeer
           with context Signature = ?, ManagerKey = null, ManagerSignature = null
           set MemberKey = ?
           where MemberKey = ? and PeerId = ?`,
        [stolen, founder.publicKeyB64, victim.publicKeyB64, 'peer-target'],
      ),
    ).rejects.toThrow(/NoUpdate/);

    const row = await db.get('select MemberKey from Strand.MemberPeer');
    expect(row?.MemberKey).toBe(victim.publicKeyB64);
  }, 30_000);

  it('a manager cannot reach the removal branch through an UPDATE either', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    await registerMemberPeer(db, { memberKeyPair: member, peerId: 'peer-upd' });

    // The manager branch is gated `new.MemberKey is null`, which an update never satisfies —
    // but NoUpdate is what makes that unreachable rather than merely unsatisfied.
    const removeTagged = signStrandApproval(
      ['Strand.MemberPeer', 'manager-remove', member.publicKeyB64, 'peer-upd',
        await memberPeerStamp(db, member.publicKeyB64, 'peer-upd')],
      founder.privateKeyB64,
    );
    await expect(
      db.exec(
        `update Strand.MemberPeer
           with context Signature = null, ManagerKey = ?, ManagerSignature = ?
           set PeerId = ?
           where MemberKey = ? and PeerId = ?`,
        [founder.publicKeyB64, removeTagged, 'peer-upd-renamed', member.publicKeyB64, 'peer-upd'],
      ),
    ).rejects.toThrow(/NoUpdate/);

    expect(await tableCount(db, 'MemberPeer')).toBe(1);
  }, 30_000);

  it('a manager seated in the SAME transaction cannot authorize its own cleanup', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    await registerMemberPeer(db, { memberKeyPair: member, peerId: 'peer-samet' });
    const climber = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: climber.publicKeyB64 });

    // The manager branch reads `committed.Manager` — the PRE-transaction snapshot. Seating
    // the climber and spending its authority in ONE transaction must not pass, or the
    // deferred check (it carries a subquery) would see its own freshly inserted seat.
    // The climber IS a committed member, so its tombstone passes Revocation.Authorized
    // and only the MemberPeer gate fails — the /Authorized/ pin names the right check.
    const seatStamp = generateStrandStampId();
    const seatSignature = signStrandApproval(
      ['Strand.Manager', 'add', climber.publicKeyB64, 1, seatStamp],
      founder.privateKeyB64,
    );
    const peerStamp = await memberPeerStamp(db, member.publicKeyB64, 'peer-samet');
    const removeTagged = signStrandApproval(
      ['Strand.MemberPeer', 'manager-remove', member.publicKeyB64, 'peer-samet', peerStamp],
      climber.privateKeyB64,
    );
    await db.exec('begin');
    try {
      await db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = ?, Signature = ?
           values (?, 1, ?)`,
        [founder.publicKeyB64, seatSignature, climber.publicKeyB64, seatStamp],
      );
      await db.exec(
        `delete from Strand.MemberPeer
           with context Signature = null, ManagerKey = ?, ManagerSignature = ?
           where MemberKey = ? and PeerId = ?`,
        [climber.publicKeyB64, removeTagged, member.publicKeyB64, 'peer-samet'],
      );
      await fileTombstone(db, 'MemberPeer', peerStamp, climber);
      await expect(db.exec('commit')).rejects.toThrow(/Authorized/);
    } finally {
      await db.exec('rollback').catch(() => undefined);
    }
    expect(await tableCount(db, 'MemberPeer')).toBe(1);
    expect(await tableCount(db, 'Manager')).toBe(1);

    // Positive control: the SAME seat and the SAME removal signature, only now the seat
    // is committed first — so the rejection above was the same-transaction ordering, not
    // a malformed seat or a bad removal payload.
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: climber.publicKeyB64 });
    await removeMemberPeer(db, { managerKeyPair: climber, memberKey: member.publicKeyB64, peerId: 'peer-samet' });
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
  }, 30_000);

  it('listMemberPeers enumerates exactly one member\'s bindings', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    await registerMemberPeer(db, { memberKeyPair: member, peerId: 'peer-b' });
    await registerMemberPeer(db, { memberKeyPair: member, peerId: 'peer-a' });
    await registerMemberPeer(db, { memberKeyPair: founder, peerId: 'peer-other' });

    expect((await listMemberPeers(db, member.publicKeyB64)).sort()).toEqual(['peer-a', 'peer-b']);
    expect(await listMemberPeers(db, freshKeyPair().publicKeyB64)).toEqual([]);

    // The manager cleanup loop this exists to drive: enumerate, then clear each.
    for (const peerId of await listMemberPeers(db, member.publicKeyB64)) {
      await removeMemberPeer(db, { managerKeyPair: founder, memberKey: member.publicKeyB64, peerId });
    }
    expect(await listMemberPeers(db, member.publicKeyB64)).toEqual([]);
    expect(await tableCount(db, 'MemberPeer')).toBe(1); // the founder's own is untouched
  }, 30_000);
});

// ── Phase 2: Manager rotation (add / remove admins) ─────────────────────────

/** Add `count` extra managers (signed by the founder) and return their keypairs. */
async function addExtraManagers(db: Database, founder: Ed25519KeyPair, count: number): Promise<Ed25519KeyPair[]> {
  const extras: Ed25519KeyPair[] = [];
  for (let i = 0; i < count; i++) {
    const kp = freshKeyPair();
    // Seat the Member row first (the real promotion flow — managers are members):
    // removeManager files a Revocation tombstone signed by the acting manager, and
    // Revocation.Authorized verifies that signer against committed.Member.
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: kp.publicKeyB64 });
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: kp.publicKeyB64 });
    extras.push(kp);
  }
  return extras;
}

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

/**
 * Raw generation-carrying `Manager` insert: `by` signs the add-tagged promotion
 * digest over `(key, generation, freshly-minted StampId)` — generation as a NUMBER,
 * matching the type-tagged digest framing — and binds itself as `context.ManagerKey`.
 * Unlike `addManager` (which derives the generation from its own row), the generation
 * is caller-chosen — exactly what an attacker controls, and what the accepted
 * non-successor case needs.
 */
async function insertManagerRow(db: Database, by: Ed25519KeyPair, key: string, generation: number): Promise<void> {
  const stampId = generateStrandStampId();
  const signature = signStrandApproval(['Strand.Manager', 'add', key, generation, stampId], by.privateKeyB64);
  await db.exec(
    `insert into Strand.Manager (MemberKey, Generation, StampId)
       with context ManagerKey = ?, Signature = ?
       values (?, ?, ?)`,
    [by.publicKeyB64, signature, key, generation, stampId],
  );
}

/** The `Generation` of one manager row, or undefined when the key holds no row. */
async function managerGeneration(db: Database, key: string): Promise<number | undefined> {
  const row = await db.get('select Generation from Strand.Manager where MemberKey = ?', [key]);
  return row == null ? undefined : Number(row.Generation);
}

describe('addManager', () => {
  it('an existing manager promotes a second manager (non-bootstrap signature branch)', async () => {
    const { db, founder } = await openStrand('c');
    const second = freshKeyPair();

    await addManager(db, { byManagerKeyPair: founder, newManagerKey: second.publicKeyB64 });

    // At commit the count is 2, so the `count(Manager) <= 1` bootstrap branch is
    // false — this genuinely passed via the existing-manager signature branch.
    expect(await tableCount(db, 'Manager')).toBe(2);
    const row = await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [second.publicKeyB64]);
    expect(row?.MemberKey).toBe(second.publicKeyB64);
  }, 30_000);

  it('rejects an add whose signer is not a manager (no count<=1 shortcut once founder exists)', async () => {
    const { db } = await openStrand('c');
    const notAManager = freshKeyPair();
    const target = freshKeyPair();

    await expect(
      addManager(db, { byManagerKeyPair: notAManager, newManagerKey: target.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(1); // only the founder
  }, 30_000);

  it('rejects an add whose signature is over the wrong key (signature binding)', async () => {
    const { db, founder } = await openStrand('c');
    const target = freshKeyPair();
    const someOtherKey = freshKeyPair().publicKeyB64;

    // A real manager (founder) signs a correctly-shaped add-tagged promotion digest,
    // but over a DIFFERENT key than the one being inserted, so the verify against
    // digest('Strand.Manager','add', new.MemberKey=target, 1, stamp) fails.
    const stampId = generateStrandStampId();
    const wrongSignature = signStrandApproval(
      ['Strand.Manager', 'add', someOtherKey, 1, stampId],
      founder.privateKeyB64,
    );

    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = ?, Signature = ?
           values (?, ?, ?)`,
        [founder.publicKeyB64, wrongSignature, target.publicKeyB64, 1, stampId],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  // Self-promotion guard: the existing-manager branch of `Manager.Authorized` is a
  // deferred (subquery-bearing) CHECK, so at commit it runs against the POST-insert
  // row set — the row being inserted is already in `Manager` and would otherwise
  // match itself. The branch's `A.MemberKey <> coalesce(new.MemberKey, old.MemberKey)`
  // excludes that row, so a key cannot authorize its own promotion.
  it('rejects a key promoting ITSELF (the row being inserted is not its own authorizer)', async () => {
    const { db, founder } = await openStrand('c');
    const attacker = freshKeyPair();

    // A perfectly-formed self-authorization: the attacker signs its own key and binds
    // itself as context.ManagerKey. Only the `<>` guard stands between this and admin.
    await expect(
      addManager(db, { byManagerKeyPair: attacker, newManagerKey: attacker.publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1); // only the founder
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [attacker.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects a manager add on an open strand (Manager is OnlyClosed)', async () => {
    const { db } = await openStrand('o');
    const target = freshKeyPair();

    // Open strands have no founding Manager and Manager is OnlyClosed; any add is rejected.
    await expect(
      addManager(db, { byManagerKeyPair: freshKeyPair(), newManagerKey: target.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(0);
  }, 30_000);
});

describe('removeManager', () => {
  // NOTE on what these prove: the writer builds a correctly-signed delete (the
  // existing-manager branch for admin removal, the former-manager self branch
  // for self-resignation — see removeManager's doc). The optimystic bootstrap-mode
  // transactor now evaluates deferred (subquery-bearing) CHECK constraints on DELETE
  // — `Manager.Authorized` is one — so these acceptance tests genuinely exercise
  // the signature branches (the founder/self signatures are valid for those
  // branches), and an unauthorized delete is rejected (see the test below). The
  // platform gap they previously documented is tracked by
  // `optimystic-deferred-check-not-enforced-on-delete` (backlog), now fixed.
  it('a manager removes a DIFFERENT manager and leaves the other managers intact', async () => {
    const { db, founder } = await openStrand('c');
    // 3 managers total so removing one leaves 2 (≥ 2 after delete keeps the
    // `count(Manager) <= 1` bootstrap branch false, so this genuinely takes the
    // existing-manager signature branch).
    const [a2, a3] = await addExtraManagers(db, founder, 2);
    expect(await tableCount(db, 'Manager')).toBe(3);

    await removeManager(db, { byManagerKeyPair: founder, targetManagerKey: a3.publicKeyB64 });

    expect(await tableCount(db, 'Manager')).toBe(2);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a3.publicKeyB64])).toBeUndefined();
    // The other managers are untouched (only the targeted row was removed).
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('a manager resigns itself (self-targeted removal removes only its own row)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 2);
    expect(await tableCount(db, 'Manager')).toBe(3);

    await removeManager(db, { byManagerKeyPair: a2, targetManagerKey: a2.publicKeyB64 });

    expect(await tableCount(db, 'Manager')).toBe(2);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  // Delete-side constraint enforcement: an unauthorized removal is rejected.
  //
  // `Manager.Authorized` (a deferred, subquery-bearing CHECK) rejects a removal
  // whose signer is neither an existing manager nor the target itself. The
  // optimystic bootstrap-mode vtab transactor now evaluates deferred CHECK
  // constraints on DELETE (not only on INSERT), so a non-manager can no longer
  // remove a Manager row. This pins the intended secure behavior; it previously
  // documented the platform gap tracked by
  // `optimystic-deferred-check-not-enforced-on-delete` (backlog), now fixed.
  it('a non-manager removal is rejected (deferred CHECK enforced on delete)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 2);
    const notAManager = freshKeyPair();
    expect(await tableCount(db, 'Manager')).toBe(3);

    // No accepting branch matches (post-delete count 2 keeps the bootstrap branch
    // false), so the deferred Authorized CHECK rejects the delete at commit.
    await expect(
      removeManager(db, { byManagerKeyPair: notAManager, targetManagerKey: a2.publicKeyB64 }),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(3); // unchanged — nothing was removed
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects a removal whose signature is over the wrong key (signature binding on delete)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 2);
    const someOtherKey = freshKeyPair().publicKeyB64;
    expect(await tableCount(db, 'Manager')).toBe(3);

    // A real manager (founder) signs the remove-tagged digest, but over a DIFFERENT
    // key than the row being deleted (the stamp is the row's live one), so the verify
    // against digest('Strand.Manager','remove', old.MemberKey=a2, old.StampId) fails —
    // the delete analog of the addManager signature-binding test. No tombstone rides
    // this delete, so RevocationRecorded also rejects; the pin stays loose.
    const wrongSignature = signStrandApproval(
      ['Strand.Manager', 'remove', someOtherKey, await managerStamp(db, a2.publicKeyB64)],
      founder.privateKeyB64,
    );

    await expect(
      db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, wrongSignature, a2.publicKeyB64],
      ),
    ).rejects.toThrow();
    expect(await tableCount(db, 'Manager')).toBe(3);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a2.publicKeyB64])).toBeTruthy();
  }, 30_000);

  // ── The min-one-manager floor + the no-bootstrap-bypass pin ─────────────────
  //
  // `Manager.MinOneManager` (`check on delete`, deferred → sees the POST-delete
  // count) keeps a closed strand from ever reaching zero managers: every admit path
  // (Invite, addMemberByManager, addManager) needs a Manager row, so an admin-less
  // strand is frozen forever. And `Manager.Authorized`'s bootstrap branch is gated to
  // INSERTs (`old.MemberKey is null`), so a delete that drops the count toward the
  // floor no longer waives the signature check.

  it('rejects the SOLE manager resigning (min-one-manager floor)', async () => {
    const { db, founder } = await openStrand('c');
    expect(await tableCount(db, 'Manager')).toBe(1);

    // A valid self-resignation signature — rejected purely because it would empty
    // the Manager table.
    // Authorized passes (the self-resignation branch is satisfied), so MinOneManager
    // is the ONLY constraint that can reject — pinning the name proves the floor fired.
    await expect(
      removeManager(db, { byManagerKeyPair: founder, targetManagerKey: founder.publicKeyB64 }),
    ).rejects.toThrow(/MinOneManager/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects a stranger removing the last manager (no unsigned drop to zero)', async () => {
    const { db, founder } = await openStrand('c');
    const stranger = freshKeyPair();
    expect(await tableCount(db, 'Manager')).toBe(1);

    // Both MinOneManager (post-delete count 0) and Authorized (stranger signature)
    // reject this; which one reports first is engine evaluation order, so only the
    // fact of a CHECK rejection is pinned.
    await expect(
      removeManager(db, { byManagerKeyPair: stranger, targetManagerKey: founder.publicKeyB64 }),
    ).rejects.toThrow(/CHECK constraint failed/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('still requires a valid signature for the SECOND-TO-LAST removal (bootstrap branch is insert-only)', async () => {
    const { db, founder } = await openStrand('c');
    const [a2] = await addExtraManagers(db, founder, 1);
    const stranger = freshKeyPair();
    expect(await tableCount(db, 'Manager')).toBe(2);

    // Post-delete count would be 1 — the old, ungated `count(Manager) <= 1` branch
    // accepted exactly this. Now it must fail on the signature.
    // MinOneManager is satisfied (1 would remain), so Authorized is the only rejector.
    await expect(
      removeManager(db, { byManagerKeyPair: stranger, targetManagerKey: a2.publicKeyB64 }),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(2);

    // The same removal, properly authorized by the OTHER manager, succeeds — proving
    // the rejection above was the signature, not the floor (1 manager still remains).
    await removeManager(db, { byManagerKeyPair: founder, targetManagerKey: a2.publicKeyB64 });
    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects any UPDATE of a Manager row (NoUpdate — a resignation signature is not a hand-off)', async () => {
    const { db, founder } = await openStrand('c');
    const attacker = freshKeyPair();

    // The strongest context an attacker could present: a genuine founder-signed
    // resign-tagged digest over the founder's OWN key and live stamp (i.e. a captured
    // self-resignation proof). The former-manager branch verifies only against the
    // old image, so without NoUpdate this would re-point the sole Manager row at an
    // attacker-chosen key.
    const founderSelfSignature = signStrandApproval(
      ['Strand.Manager', 'resign', founder.publicKeyB64, await managerStamp(db, founder.publicKeyB64)],
      founder.privateKeyB64,
    );

    await expect(
      db.exec(
        `update Strand.Manager
           with context ManagerKey = ?, Signature = ?
           set MemberKey = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, founderSelfSignature, attacker.publicKeyB64, founder.publicKeyB64],
      ),
    ).rejects.toThrow(/NoUpdate/); // not a parse error and not "updates unsupported"

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [attacker.publicKeyB64])).toBeUndefined();
  }, 30_000);

  it('rejects a same-transaction swap of the sole manager (hand-off must be add-then-resign)', async () => {
    const { db, founder } = await openStrand('c');
    // A second Member exists, so the bootstrap branch's `count(Member) <= 1` gate is
    // false — the successor cannot slip in as a "founding" manager.
    const successor = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: successor.publicKeyB64 });
    expect(await tableCount(db, 'Manager')).toBe(1);

    const founderStamp = await managerStamp(db, founder.publicKeyB64);
    const resignSignature = signStrandApproval(
      ['Strand.Manager', 'resign', founder.publicKeyB64, founderStamp],
      founder.privateKeyB64,
    );

    // Delete-then-insert in ONE transaction: the deferred checks see the post-image
    // (one manager: the successor), which is exactly the state the old schema's
    // ungated bootstrap branch would have waved through. The founder's tombstone
    // rides the transaction (a valid resignation would carry one), so the delete
    // side is fully satisfied and the successor's INSERT is the one rejector.
    const swap = (): Promise<void> => inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, resignSignature, founder.publicKeyB64],
      );
      await fileTombstone(db, 'Manager', founderStamp, founder);
      // Generation 0 is the successor's best shot — the bootstrap branch demands
      // exactly 0, and no smaller generation can have an authorizer beneath it.
      await db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = null, Signature = null
           values (?, 0, ?)`,
        [successor.publicKeyB64, generateStrandStampId()],
      );
    });

    // The successor's INSERT has no other manager to authorize it (the founder's row
    // is gone in the post-image) and the bootstrap branch is gated off, so Authorized
    // rejects — not MinOneManager, which the successor row satisfies.
    await expect(swap()).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [successor.publicKeyB64])).toBeUndefined();
  }, 30_000);
});

// ── Phase 3: the generation ordering (same-transaction takeover is closed) ────
//
// `Manager.Generation` orders every manager strictly after the manager that
// appointed it, and the promotion branch of `Manager.Authorized` accepts only an
// authorizer of STRICTLY SMALLER generation. The deferred check still sees
// same-transaction sibling rows as "existing" managers — but the
// minimum-generation row of any inserted set cannot find an authorizer among its
// siblings, so that authorizer must pre-exist the transaction. These tests replay
// the measured takeover shapes (mutual pair, founder eviction, rings, equal and
// below-founder generations) against the closed schema, and pin that what is
// enforced is the ORDERING — not an exact successor value, and not a privilege.

describe('Manager.Generation ordering', () => {
  it('rejects two keys signing each other\'s promotion in one transaction', async () => {
    const { db, founder } = await openStrand('c');
    const x = freshKeyPair();
    const y = freshKeyPair();

    // The exact measured takeover: each key binds the OTHER as its authorizer.
    // Whatever generations the attacker picks, the smaller one has no authorizer
    // beneath it — here Y (gen 3) is "authorized" by X (gen 5), so Y's row fails.
    await expect(inTransaction(db, async () => {
      await insertManagerRow(db, y, x.publicKeyB64, 5); // Y vouches for X
      await insertManagerRow(db, x, y.publicKeyB64, 3); // X vouches for Y
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1); // only the founder
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('rejects the full takeover: mutual promotion plus evicting the founder, one transaction', async () => {
    const { db, founder } = await openStrand('c');
    const x = freshKeyPair();
    const y = freshKeyPair();

    // The pre-fix schema COMMITTED exactly this: X and Y seat each other, then X
    // (a "manager" in the post-image) deletes the founder. The delete's own branch
    // is even satisfiable here — the rejection comes from the promotion ordering.
    // X files the founder-stamp tombstone itself so RevocationRecorded cannot report
    // first; X is no committed member, so Revocation.Authorized fails too — but that
    // check shares the `Authorized` name, so the pin holds either way.
    const founderStamp = await managerStamp(db, founder.publicKeyB64);
    await expect(inTransaction(db, async () => {
      await insertManagerRow(db, y, x.publicKeyB64, 5);
      await insertManagerRow(db, x, y.publicKeyB64, 3);
      await db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [
          x.publicKeyB64,
          signStrandApproval(['Strand.Manager', 'remove', founder.publicKeyB64, founderStamp], x.privateKeyB64),
          founder.publicKeyB64,
        ],
      );
      await fileTombstone(db, 'Manager', founderStamp, x);
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [x.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [y.publicKeyB64])).toBeUndefined();
  }, 30_000);

  it('rejects a three-key mutual-vouching ring in one transaction', async () => {
    const { db } = await openStrand('c');
    const x = freshKeyPair();
    const y = freshKeyPair();
    const z = freshKeyPair();

    // A ring's minimum-generation row (X at 1) is authorized by Z at 3 — not
    // strictly smaller, so the ring has no root and the transaction fails.
    await expect(inTransaction(db, async () => {
      await insertManagerRow(db, z, x.publicKeyB64, 1); // Z vouches for X
      await insertManagerRow(db, x, y.publicKeyB64, 2); // X vouches for Y
      await insertManagerRow(db, y, z.publicKeyB64, 3); // Y vouches for Z
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  it('rejects a mutual pair at EQUAL generations (the ordering is strict)', async () => {
    const { db } = await openStrand('c');
    const x = freshKeyPair();
    const y = freshKeyPair();

    await expect(inTransaction(db, async () => {
      await insertManagerRow(db, y, x.publicKeyB64, 1);
      await insertManagerRow(db, x, y.publicKeyB64, 1);
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  it('rejects a mutual pair using generations BELOW the founder\'s 0 (no ducking underneath)', async () => {
    const { db } = await openStrand('c');
    const x = freshKeyPair();
    const y = freshKeyPair();

    // Negative generations do sort below the founder, but the pair still needs
    // each generation strictly below the other's — the minimum (-2) has no
    // authorizer beneath it, so going negative buys the attacker nothing.
    await expect(inTransaction(db, async () => {
      await insertManagerRow(db, y, x.publicKeyB64, -1); // Y (-2) < X (-1): satisfiable
      await insertManagerRow(db, x, y.publicKeyB64, -2); // X (-1) < Y (-2): impossible
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
  }, 30_000);

  it('rejects a stranger claiming generation 0 once the strand is bootstrapped', async () => {
    const { db, founder } = await openStrand('c');
    const attacker = freshKeyPair();

    // Generation 0 only helps in the FOUNDING state — the bootstrap branch also
    // demands count(Manager) <= 1, and the post-image count here is 2.
    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = null, Signature = null
           values (?, 0, ?)`,
        [attacker.publicKeyB64, generateStrandStampId()],
      ),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);

  it('enforces the ORDERING, not an exact successor value (+5 accepted, <= rejected)', async () => {
    const { db, founder } = await openStrand('c');
    const skipAhead = freshKeyPair();
    const tooLow = freshKeyPair();

    // The founder (gen 0) seats a manager at gen 5 — a gap, not 0+1 — accepted:
    // only strict "authorizer below new" is enforced, never adjacency.
    await insertManagerRow(db, founder, skipAhead.publicKeyB64, 5);
    expect(await managerGeneration(db, skipAhead.publicKeyB64)).toBe(5);

    // The same founder signing a generation EQUAL to its own (0 < 0 fails; the
    // bootstrap branch is also off — the manager count is already 2).
    await expect(insertManagerRow(db, founder, tooLow.publicKeyB64, 0)).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(2);
  }, 30_000);

  it('binds the generation into the signed payload (a promotion cannot be replayed at another generation)', async () => {
    const { db, founder } = await openStrand('c');
    const target = freshKeyPair();

    // A genuine founder signature over the add-tagged digest for generation 1
    // (a NUMBER — the digest is type-tagged) and ONE minted stamp, replayed for an
    // insert at generation 2 carrying the same stamp — the digest mismatch fails
    // verify(), so a captured promotion is pinned to the generation it was issued for.
    const stampId = generateStrandStampId();
    const signatureForGen1 = signStrandApproval(
      ['Strand.Manager', 'add', target.publicKeyB64, 1, stampId],
      founder.privateKeyB64,
    );
    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = ?, Signature = ?
           values (?, ?, ?)`,
        [founder.publicKeyB64, signatureForGen1, target.publicKeyB64, 2, stampId],
      ),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(1);

    // The same signature used at ITS OWN generation is accepted — proving the
    // rejection above was the digest binding, not anything else. The stamp is still
    // free (the rejected insert rolled back, retiring nothing), so reusing it here
    // is legitimate first use.
    await db.exec(
      `insert into Strand.Manager (MemberKey, Generation, StampId)
         with context ManagerKey = ?, Signature = ?
         values (?, ?, ?)`,
      [founder.publicKeyB64, signatureForGen1, target.publicKeyB64, 1, stampId],
    );
    expect(await managerGeneration(db, target.publicKeyB64)).toBe(1);
  }, 30_000);

  it('a promoted manager can itself promote: founder→A→B chains generations 0→1→2', async () => {
    const { db, founder } = await openStrand('c');
    const a = freshKeyPair();
    const b = freshKeyPair();

    // Exercises addManager's generation LOOKUP with a non-founder authorizer:
    // A's own row (gen 1) is read back and B is seated at 2.
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: a.publicKeyB64 });
    await addManager(db, { byManagerKeyPair: a, newManagerKey: b.publicKeyB64 });

    expect(await tableCount(db, 'Manager')).toBe(3);
    expect(await managerGeneration(db, founder.publicKeyB64)).toBe(0);
    expect(await managerGeneration(db, a.publicKeyB64)).toBe(1);
    expect(await managerGeneration(db, b.publicKeyB64)).toBe(2);
  }, 30_000);

  it('accepts a same-transaction chain rooted at a pre-existing manager (no over-rejection)', async () => {
    const { db, founder } = await openStrand('c');
    const a = freshKeyPair();
    const b = freshKeyPair();

    // The mirror image of the rejected shapes: batching promotions in ONE
    // transaction is legitimate as long as the batch has a root outside it. The
    // founder (gen 0) seats A at 1 and A seats B at 2, both rows landing at the
    // same commit — the deferred check resolves A as B's authorizer from the
    // post-insert row set, which is exactly what makes the attack shapes
    // tempting and must NOT be broken by the ordering guard.
    await inTransaction(db, async () => {
      await insertManagerRow(db, founder, a.publicKeyB64, 1);
      await insertManagerRow(db, a, b.publicKeyB64, 2);
    });

    expect(await tableCount(db, 'Manager')).toBe(3);
    expect(await managerGeneration(db, a.publicKeyB64)).toBe(1);
    expect(await managerGeneration(db, b.publicKeyB64)).toBe(2);
  }, 30_000);

  it('an "add X" signature cannot be replayed as "remove X" (the payloads differ)', async () => {
    const { db, founder } = await openStrand('c');
    const target = freshKeyPair();
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: target.publicKeyB64 }); // gen 1

    // The promotion approval is 'add'-tagged and carries the generation; the removal
    // approval is 'remove'-tagged over just (key, stamp). So a captured approval to
    // ADD a manager — even one re-minted over the row's LIVE stamp — does not double
    // as an approval to REMOVE it: the action tags differ. A founder tombstone rides
    // the transaction so Authorized is the one rejector.
    const targetStamp = await managerStamp(db, target.publicKeyB64);
    const addSignature = signStrandApproval(
      ['Strand.Manager', 'add', target.publicKeyB64, 1, targetStamp],
      founder.privateKeyB64,
    );
    await expect(inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.Manager
           with context ManagerKey = ?, Signature = ?
           where MemberKey = ?`,
        [founder.publicKeyB64, addSignature, target.publicKeyB64],
      );
      await fileTombstone(db, 'Manager', targetStamp, founder);
    })).rejects.toThrow(/Authorized/);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [target.publicKeyB64])).toBeTruthy();

    // And the converse: a removal-shaped ('remove'-tagged, generation-less) signature
    // over a fresh stamp cannot promote the key that insert carries the same stamp.
    const other = freshKeyPair();
    const freshStamp = generateStrandStampId();
    const removeShapedSignature = signStrandApproval(
      ['Strand.Manager', 'remove', other.publicKeyB64, freshStamp],
      founder.privateKeyB64,
    );
    await expect(
      db.exec(
        `insert into Strand.Manager (MemberKey, Generation, StampId)
           with context ManagerKey = ?, Signature = ?
           values (?, ?, ?)`,
        [founder.publicKeyB64, removeShapedSignature, other.publicKeyB64, 1, freshStamp],
      ),
    ).rejects.toThrow(/Authorized/);
    expect(await tableCount(db, 'Manager')).toBe(2);
  }, 30_000);

  it('a later-generation manager may remove an earlier-generation one (generation is not privilege)', async () => {
    const { db, founder } = await openStrand('c');
    const a = freshKeyPair();
    const b = freshKeyPair();
    // Members first: B's removal of A files a tombstone signed by B, and
    // Revocation.Authorized verifies that signer against committed.Member.
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: a.publicKeyB64 });
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: b.publicKeyB64 });
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: a.publicKeyB64 }); // gen 1
    await addManager(db, { byManagerKeyPair: a, newManagerKey: b.publicKeyB64 });       // gen 2
    expect(await tableCount(db, 'Manager')).toBe(3);

    // B (gen 2) removes A (gen 1): the removal branch carries no generation
    // condition, so seniority grants no protection — only the floor does.
    await removeManager(db, { byManagerKeyPair: b, targetManagerKey: a.publicKeyB64 });

    expect(await tableCount(db, 'Manager')).toBe(2);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [a.publicKeyB64])).toBeUndefined();
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [founder.publicKeyB64])).toBeTruthy();
  }, 30_000);
});
