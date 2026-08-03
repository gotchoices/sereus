import { describe, it, expect } from 'vitest';
import type { Database } from '@quereus/quereus';
import {
  addMemberByManager,
  revokeMember,
  registerMemberPeer,
  listMemberPeers,
  removeMemberPeer,
  addManager,
  signStrandApproval,
  generateStrandStampId,
} from '../src/strand-membership-writer.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import {
  freshKeyPair,
  tableCount,
  openStrand,
  inTransaction,
} from './strand-spec-helpers.js';

/**
 * Component coverage for `MemberPeer` registration and removal — a member binding
 * (and unbinding) its own network nodes, self-signed, with a manager-cleanup escape
 * hatch for orphaned bindings. Every test runs against a REAL closed strand DB in
 * bootstrap mode (libp2p node + MemoryRawStorage + the optimystic local transactor)
 * via `connectToStrand` — the same path `StrandDatabase` uses — so the real
 * apply/DML/deferred-constraint path is exercised, not a fake.
 *
 * The founder is bootstrapped first (Member #1 + the sole founding Manager), so every
 * later registration/removal runs past `Manager.Authorized`'s bootstrap branch — which
 * is gated to INSERTs in the founding state — and genuinely exercises signature
 * verification.
 */

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

// ── MemberPeer removal (self-signed, or manager cleanup) ─────────────────────
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
