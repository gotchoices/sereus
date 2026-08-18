import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import {
  expectConstraintFailure,
  freshKeyPair,
  freshStamp,
  signAs,
  revocationMessage,
  reissueMessage,
  type KeyPair,
} from './control-constraint-helpers.js';

/**
 * Re-issue coverage for `CadreControl.Revocation` — split out of
 * `control-revocation-replay.spec.ts` (which pins the append/replay side: `NotRevoked`,
 * `RevocationRecorded`, `RowIsGone`, `Authorized`) when the tombstone's one mutable
 * column landed.
 *
 * Why `ReissuedAt` exists: a tombstone committed while the node was ALONE is local-only —
 * it was never broadcast, and unlike an insert a delete cannot be replayed later (the
 * guarded row is already gone locally). Re-WRITING the tombstone row is what makes the
 * storage layer re-broadcast it once peers are reachable, so the row carries a counter an
 * owner can bump for exactly that purpose. The counter has NO read-side semantics:
 * retirement is decided by the row's existence, nothing reads the value.
 *
 * Four constraints keep the tombstone honest around that one seam, each pinned here or in
 * the replay spec BY NAME:
 *   - `NoDelete` — retirement is permanent; not even an owner may withdraw a tombstone;
 *   - `FreshTombstone` — every tombstone seats at counter 0, so an owner cannot pre-seat
 *     a saturated counter and freeze its own later re-issues;
 *   - `ReissueOnly` — an update may move NOTHING but the counter, and only upward;
 *   - `AuthorizedReissue` — the bump is an owner action under its own 'reissue' action
 *     tag, digest covering (TableName, RowKey, StampId, ReissuedAt).
 *
 * Tombstones here target ORPHAN stamps (no live row) unless stated: that is the normal
 * converged-tombstone-only shape a re-issue runs against — a re-issue files no delete, so
 * `RowIsGone` / `RevocationRecorded` are never involved.
 *
 * Every test boots its OWN `CadreNode` (empty bootstrap, transaction profile) seeded with
 * one founding owner, matching the replay spec's fixture.
 */

describe('Revocation: owner-signed tombstone re-issue', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

  /** A tombstone append under CALLER-CHOSEN authorization context. */
  function rawTombstone(
    contextOwner: string | null,
    signature: string | null,
    tableName: string,
    rowKey: string,
    stampId: string,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.Revocation (TableName, RowKey, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?)`,
      [contextOwner, signature, tableName, rowKey, stampId],
    );
  }

  /** Retire a stamp the legitimate way: founder-signed over the 'remove' insert digest. */
  function tombstoneStamp(tableName: string, rowKey: string, stampId: string): Promise<void> {
    return rawTombstone(
      founder.publicKey,
      signAs(founder, revocationMessage(tableName, rowKey, stampId)),
      tableName,
      rowKey,
      stampId,
    );
  }

  /**
   * A counter-only re-issue under CALLER-CHOSEN authorization context, keyed on StampId
   * ALONE like production (`reissueRevocations`): equality over the full composite primary
   * key (TableName, StampId) hits the point-lookup descent that has been observed missing
   * an existing row — see the statement comment in `reissueRevocations`.
   */
  function rawReissue(
    contextOwner: string | null,
    signature: string | null,
    stampId: string,
    reissuedAt: number,
  ): Promise<void> {
    return rawDb.exec(
      `update CadreControl.Revocation
         with context OwnerKey = ?, Signature = ?
         set ReissuedAt = ?
         where StampId = ?`,
      [contextOwner, signature, reissuedAt, stampId],
    );
  }

  /** The founder's signature over the 'reissue' digest — what AuthorizedReissue verifies. */
  function reissueSig(tableName: string, rowKey: string, stampId: string, reissuedAt: number): string {
    return signAs(founder, reissueMessage(tableName, rowKey, stampId, reissuedAt));
  }

  function readTombstone(stampId: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get(
      'select TableName, RowKey, StampId, ReissuedAt from CadreControl.Revocation where StampId = ?',
      [stampId],
    );
  }

  beforeEach(async () => {
    founder = freshKeyPair();
    node = new CadreNode({
      controlNetwork: {
        partyId: 'revocation-reissue-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();
    expect(await db.ensureOwnerKey(founder.publicKey)).toBe(true);
  }, 60_000);

  afterEach(async () => {
    await node?.stop();
  });

  // ── The accept direction: an owner may bump the counter ────────────────────

  it('an owner-signed counter bump lands, leaving the identity triple untouched', async () => {
    const rowKey = '12D3KooWReissueHappyTarget';
    const stamp = freshStamp();
    await tombstoneStamp('CadrePeer', rowKey, stamp);

    // The raw-SQL accept also pins the digest pairing end to end: the TS side signs
    // String(reissuedAt) and the schema digests cast(new.ReissuedAt as text) — if those
    // encodings ever diverged, this legitimate bump would be refused.
    await rawReissue(founder.publicKey, reissueSig('CadrePeer', rowKey, stamp, 1234), stamp, 1234);

    const row = await readTombstone(stamp);
    expect(row?.TableName).toBe('CadrePeer');
    expect(row?.RowKey).toBe(rowKey);
    expect(row?.StampId).toBe(stamp);
    expect(Number(row?.ReissuedAt)).toBe(1234);
  }, 60_000);

  // ── ReissueOnly: nothing but the counter, and only upward ──────────────────

  it('an update touching the identity triple is refused even when fully owner-authorized (ReissueOnly)', async () => {
    // Each probe signs the reissue digest over the NEW values and moves the counter
    // upward, so AuthorizedReissue passes and the identity clause of ReissueOnly is the
    // single rejector. Without it an "update" would re-point a tombstone at a different
    // row — restoring exactly the replay the table exists to stop.
    const rowKey = '12D3KooWIdentityFrozenTarget';
    const stamp = freshStamp();
    await tombstoneStamp('CadrePeer', rowKey, stamp);

    const rotatedStamp = freshStamp();
    await expectConstraintFailure(
      rawDb.exec(
        `update CadreControl.Revocation
           with context OwnerKey = ?, Signature = ?
           set StampId = ?, ReissuedAt = 1
           where StampId = ?`,
        [founder.publicKey, reissueSig('CadrePeer', rowKey, rotatedStamp, 1), rotatedStamp, stamp],
      ),
      'ReissueOnly',
    );

    const otherKey = '12D3KooWSomeOtherRowKey';
    await expectConstraintFailure(
      rawDb.exec(
        `update CadreControl.Revocation
           with context OwnerKey = ?, Signature = ?
           set RowKey = ?, ReissuedAt = 1
           where StampId = ?`,
        [founder.publicKey, reissueSig('CadrePeer', otherKey, stamp, 1), otherKey, stamp],
      ),
      'ReissueOnly',
    );

    await expectConstraintFailure(
      rawDb.exec(
        `update CadreControl.Revocation
           with context OwnerKey = ?, Signature = ?
           set TableName = ?, ReissuedAt = 1
           where StampId = ?`,
        [founder.publicKey, reissueSig('OwnerKey', rowKey, stamp, 1), 'OwnerKey', stamp],
      ),
      'ReissueOnly',
    );

    const row = await readTombstone(stamp);
    expect(row?.TableName).toBe('CadrePeer');
    expect(row?.RowKey).toBe(rowKey);
    expect(Number(row?.ReissuedAt)).toBe(0);
  }, 60_000);

  it('the counter moves strictly upward: equal and lower are refused, higher lands (ReissueOnly)', async () => {
    const rowKey = '12D3KooWMonotonicTarget';
    const stamp = freshStamp();
    await tombstoneStamp('CadrePeer', rowKey, stamp);

    await rawReissue(founder.publicKey, reissueSig('CadrePeer', rowKey, stamp, 5), stamp, 5);
    expect(Number((await readTombstone(stamp))?.ReissuedAt)).toBe(5);

    // Equal is NOT a no-op re-affirmation: an accepted write re-broadcasts, and a
    // captured equal-value signature must not be a replayable broadcast trigger.
    await expectConstraintFailure(
      rawReissue(founder.publicKey, reissueSig('CadrePeer', rowKey, stamp, 5), stamp, 5),
      'ReissueOnly',
    );
    await expectConstraintFailure(
      rawReissue(founder.publicKey, reissueSig('CadrePeer', rowKey, stamp, 3), stamp, 3),
      'ReissueOnly',
    );
    expect(Number((await readTombstone(stamp))?.ReissuedAt)).toBe(5);

    await rawReissue(founder.publicKey, reissueSig('CadrePeer', rowKey, stamp, 6), stamp, 6);
    expect(Number((await readTombstone(stamp))?.ReissuedAt)).toBe(6);
  }, 60_000);

  // ── AuthorizedReissue: the bump is an owner action under its own tag ───────

  it('a bump signed over the WRONG digest or by a non-owner is refused (AuthorizedReissue)', async () => {
    const rowKey = '12D3KooWReissueAuthTarget';
    const stamp = freshStamp();
    await tombstoneStamp('CadrePeer', rowKey, stamp);

    // Action-tag separation: the append approval ('remove' digest) the founder REALLY
    // signed for this exact row does not double as a re-issue warrant.
    await expectConstraintFailure(
      rawReissue(
        founder.publicKey,
        signAs(founder, revocationMessage('CadrePeer', rowKey, stamp)),
        stamp,
        1,
      ),
      'AuthorizedReissue',
    );

    // A stranger signing the CORRECT reissue digest with its own key: valid ed25519,
    // but no OwnerKey row names it.
    const stranger = freshKeyPair();
    await expectConstraintFailure(
      rawReissue(
        stranger.publicKey,
        signAs(stranger, reissueMessage('CadrePeer', rowKey, stamp, 1)),
        stamp,
        1,
      ),
      'AuthorizedReissue',
    );

    expect(Number((await readTombstone(stamp))?.ReissuedAt)).toBe(0);
  }, 60_000);

  // ── NoDelete / FreshTombstone: the seams around the counter stay shut ──────

  it('not even an owner-signed delete can withdraw a tombstone (NoDelete)', async () => {
    // The replay spec pins the UNSIGNED delete; this pins the sharper claim — NoDelete is
    // unconditional, so a fully authorized owner (valid context + valid signature over
    // the row's own 'remove' digest) cannot un-retire a stamp either. NoDelete is the
    // only on-delete constraint, so both shapes are single-rejector.
    const rowKey = '12D3KooWOwnerDeleteTarget';
    const stamp = freshStamp();
    await tombstoneStamp('CadrePeer', rowKey, stamp);

    await expectConstraintFailure(
      rawDb.exec(
        `delete from CadreControl.Revocation
           with context OwnerKey = ?, Signature = ?
           where StampId = ?`,
        [founder.publicKey, signAs(founder, revocationMessage('CadrePeer', rowKey, stamp)), stamp],
      ),
      'NoDelete',
    );
    expect(await readTombstone(stamp)).toBeDefined();
  }, 60_000);

  it('a tombstone cannot seat at a non-zero counter, even owner-signed (FreshTombstone)', async () => {
    // The Authorized insert digest deliberately does NOT cover ReissuedAt, so the
    // founder's 'remove' signature below is fully valid for this row — and with an
    // orphan stamp keeping RowIsGone green, FreshTombstone is the single rejector.
    // Seating at a saturated counter would freeze the owner's own later re-issues.
    const rowKey = '12D3KooWSaturatedSeatTarget';
    const stamp = freshStamp();

    await expectConstraintFailure(
      rawDb.exec(
        `insert into CadreControl.Revocation (TableName, RowKey, StampId, ReissuedAt)
           with context OwnerKey = ?, Signature = ?
           values (?, ?, ?, 7)`,
        [founder.publicKey, signAs(founder, revocationMessage('CadrePeer', rowKey, stamp)), 'CadrePeer', rowKey, stamp],
      ),
      'FreshTombstone',
    );
    expect(await readTombstone(stamp)).toBeUndefined();
  }, 60_000);

  // ── The production batch writer ─────────────────────────────────────────────

  it('reissueRevocations bumps a whole batch in one transaction, and one stale counter rolls the batch back', async () => {
    const stamps = [freshStamp(), freshStamp(), freshStamp()];
    for (const [i, stamp] of stamps.entries()) {
      await tombstoneStamp('CadrePeer', `12D3KooWBatchTarget${i}`, stamp);
    }

    const sign = (message: Uint8Array) => signAs(founder, message);
    const at = async (stamp: string) => Number((await readTombstone(stamp))?.ReissuedAt);

    const rows = await db.queryRevocations();
    expect(rows).toHaveLength(3);

    expect(await db.reissueRevocations(rows, 1000, founder.publicKey, sign)).toBe(3);
    for (const stamp of stamps) {
      expect(await at(stamp)).toBe(1000);
    }

    // Move one row ahead on its own — the shape of a second owner device sweeping.
    const rowC = rows.find(row => row.stampId === stamps[2])!;
    expect(await db.reissueRevocations([rowC], 2000, founder.publicKey, sign)).toBe(1);
    expect(await at(stamps[2])).toBe(2000);

    // A batch at 1500 is fine for A and B but stale for C: CHECKs are deferred to
    // commit, so every per-row UPDATE executes first, then C's ReissueOnly refuses the
    // commit and the WHOLE batch rolls back — A and B do not keep a half-applied bump.
    // The refusal PROPAGATES: lockedWithRetry's classifier only re-presents transient
    // cluster failures, so the caller sees the constraint name and retries its next
    // sweep with a fresh counter.
    await expectConstraintFailure(
      db.reissueRevocations(rows, 1500, founder.publicKey, sign),
      'ReissueOnly',
    );
    expect(await at(stamps[0])).toBe(1000);
    expect(await at(stamps[1])).toBe(1000);
    expect(await at(stamps[2])).toBe(2000);
  }, 60_000);

  // ── The read paths a revoked stamp must fall out of ────────────────────────

  it('a production removal drops the peer from every membership read, and re-admission mints a FRESH stamp', async () => {
    node.initializeSeedBootstrap(founder.privateKey);
    const droneKey = await generateKeyPair('Ed25519');
    const peerId = peerIdFromPrivateKey(droneKey).toString();

    await node.authorizePeer(peerId, ['/ip4/192.168.1.100/tcp/4001']);
    const stamp = await db.queryCadrePeerStampId(peerId);
    expect(stamp).not.toBeNull();

    await node.removePeer(peerId);
    expect((await db.queryCadrePeers()).map(row => row.peerId)).not.toContain(peerId);
    expect(await db.queryPeerRecord(peerId)).toBeNull();
    expect((await db.queryRevokedStamps('CadrePeer')).has(stamp!)).toBe(true);
    // The seed bundle is an ADDRESS surface too — applySeed writes every seed peer's
    // addrs into the joiner's peerstore — so a removed peer must not ride out in one.
    expect((await node.createSeed()).peers.map(peer => peer.peerId)).not.toContain(peerId);

    // Removal is stamp-retirement, not an identity ban: the owner may re-admit the same
    // peer, and the fresh row carries a fresh nonce — the retired one stays dead.
    await node.authorizePeer(peerId, ['/ip4/192.168.1.100/tcp/4001']);
    expect((await db.queryCadrePeers()).map(row => row.peerId)).toContain(peerId);
    expect((await node.createSeed()).peers.map(peer => peer.peerId)).toContain(peerId);
    const freshStampId = await db.queryCadrePeerStampId(peerId);
    expect(freshStampId).not.toBeNull();
    expect(freshStampId).not.toBe(stamp);
  }, 60_000);

  it('a live row planted at a retired stamp reads as absent from the membership queries but stays physically present', async () => {
    // The live-row-plus-tombstone coexistence models the cross-node CONVERGENCE race and
    // is NOT constructible with real writes — tombstoning the live stamp trips RowIsGone,
    // and inserting over an existing tombstone trips NotRevoked, in either order. So the
    // retired-set reader is wrapped instead (the seam queryCadrePeers/queryPeerRecord
    // deliberately read through — same pattern as device-token-registry.spec.ts).
    node.initializeSeedBootstrap(founder.privateKey);
    const droneKey = await generateKeyPair('Ed25519');
    const peerId = peerIdFromPrivateKey(droneKey).toString();
    await node.authorizePeer(peerId, ['/ip4/192.168.1.100/tcp/4001']);
    const stamp = await db.queryCadrePeerStampId(peerId);
    expect(stamp).not.toBeNull();

    const original = db.queryRevokedStamps.bind(db);
    db.queryRevokedStamps = async (tableName) => {
      const retired = await original(tableName);
      if (tableName === 'CadrePeer') {
        retired.add(stamp!);
      }
      return retired;
    };
    try {
      expect((await db.queryCadrePeers()).map(row => row.peerId)).not.toContain(peerId);
      expect(await db.queryPeerRecord(peerId)).toBeNull();
      // queryCadrePeerStampId stays deliberately RAW: deleteGuardedRow and the CadrePeer
      // insert-if-absent guard need to see a physically present row, or an upsert would
      // read "absent" and collide on the primary key.
      expect(await db.queryCadrePeerStampId(peerId)).toBe(stamp);
    } finally {
      db.queryRevokedStamps = original;
    }

    // Only the read-side gate reacted — with the wrapper gone the row is fully visible.
    expect((await db.queryCadrePeers()).map(row => row.peerId)).toContain(peerId);
    expect(await db.queryPeerRecord(peerId)).not.toBeNull();
  }, 60_000);
});
