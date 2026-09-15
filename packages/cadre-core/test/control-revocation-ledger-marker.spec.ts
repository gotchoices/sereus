import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { buildAuthorizationMessage, REVOCATION_LEDGER_MARKER } from '../src/control-database.js';
import type { ControlDatabase, RevocableTable } from '../src/control-database.js';
import { cadrePeerVoucherDigest } from '../src/peer-authorization.js';
import {
  expectConstraintFailure,
  expectUniqueViolation,
  freshKeyPair,
  freshStamp,
  signAs,
  signB64,
  revocationMessage,
  type KeyPair,
} from './control-constraint-helpers.js';

/**
 * The `Revocation` ledger marker: the one row in `CadreControl.Revocation` that retires
 * nothing, `('Revocation', 'ledger', 'opened')`. An owner files it once
 * (`ControlDatabase.openRevocationLedger`, driven from the reconcile pass's connected-only
 * step) so the table is never a never-written block. Optimystic consults a block's cohort
 * on every read of a block the node does not hold, and every membership lookup and guarded
 * insert reads this table.
 *
 * This spec pins both halves of "a marker, not a retirement":
 *  - the schema admits exactly that row, owner-signed, nothing else under
 *    `TableName = 'Revocation'`, and never lets it go (`Authorized`, `RowIsGone`, `NoDelete`);
 *  - no reader treats it as a retired stamp: `NotRevoked`, `queryRevokedStamps`,
 *    `queryRevocations`, the reap sweep and the growth re-issue sweep all ignore it.
 *
 * Companions: `control-founding-consult-budget.spec.ts` pins the cost effect (what the marker
 * is for), and `cadre-node-control-cohort.spec.ts` pins when the reconcile pass files it.
 *
 * Every test boots its OWN `CadreNode` (empty bootstrap, transaction profile) seeded with one
 * founding owner, matching `control-revocation-reissue.spec.ts`.
 */

/** Every table whose stamps `Revocation` retires — the `TableName` values a reader may ask about. */
const REVOCABLE_TABLES: readonly RevocableTable[] = ['OwnerKey', 'CadrePeer', 'ValidationKey', 'Strand', 'StrandPartyKey', 'DeviceToken'];

const { tableName: MARKER_TABLE, rowKey: MARKER_ROW_KEY, stampId: MARKER_STAMP } = REVOCATION_LEDGER_MARKER;

describe('Revocation ledger marker', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

  const signAsFounder = (message: Uint8Array): string => signAs(founder, message);

  beforeEach(async () => {
    founder = freshKeyPair();
    node = new CadreNode({
      controlNetwork: {
        partyId: 'revocation-ledger-' + Math.random().toString(36).slice(2),
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

  /** A `Revocation` append under CALLER-CHOSEN context and row — the marker's shape by default. */
  function rawAppend(
    contextOwner: string | null,
    signature: string | null,
    tableName: string = MARKER_TABLE,
    rowKey: string = MARKER_ROW_KEY,
    stampId: string = MARKER_STAMP,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.Revocation (TableName, RowKey, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?)`,
      [contextOwner, signature, tableName, rowKey, stampId],
    );
  }

  /** The founder's `Revocation.Authorized` signature over one row. */
  const appendSig = (tableName: string, rowKey: string, stampId: string): string =>
    signAsFounder(revocationMessage(tableName, rowKey, stampId));

  /** Every `Revocation` row filed under `TableName = 'Revocation'`, read raw. */
  async function markerRows(): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for await (const row of rawDb.eval(
      'select RowKey, StampId, ReissuedAt from CadreControl.Revocation where TableName = ?',
      [MARKER_TABLE],
    )) {
      rows.push(row);
    }
    return rows;
  }

  // ── Filing ─────────────────────────────────────────────────────────────────

  it('files the marker once: opened, then already-open, leaving exactly one row at counter 0', async () => {
    expect(await db.openRevocationLedger(founder.publicKey, signAsFounder)).toBe('opened');
    expect(await db.openRevocationLedger(founder.publicKey, signAsFounder)).toBe('already-open');

    const rows = await markerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].RowKey).toBe(MARKER_ROW_KEY);
    expect(rows[0].StampId).toBe(MARKER_STAMP);
    expect(Number(rows[0].ReissuedAt)).toBe(0);
  }, 60_000);

  it('the engine refuses a second marker row on the primary key — the wording the conflict mapping matches', async () => {
    // Pins the live error text openRevocationLedger's classifier depends on: if the
    // storage layer rewords it, this reddens here rather than turning the concurrent-owner
    // path below into a thrown write.
    await db.openRevocationLedger(founder.publicKey, signAsFounder);
    await expectUniqueViolation(
      rawAppend(founder.publicKey, appendSig(MARKER_TABLE, MARKER_ROW_KEY, MARKER_STAMP)),
      'Revocation.TableName', 'Revocation.StampId',
    );
  }, 60_000);

  it('a primary-key refusal of the marker insert answers already-open — the concurrent-owner path', async () => {
    // The real shape is a second owner filing between this node's guard and its insert.
    // Modelled by filing the marker, then blinding the guard, so the insert reaches the
    // engine and is refused on the primary key.
    expect(await db.openRevocationLedger(founder.publicKey, signAsFounder)).toBe('opened');
    const internals = db as unknown as { revocationLedgerFiled(retry: boolean): Promise<boolean> };
    const guard = vi.spyOn(internals, 'revocationLedgerFiled').mockResolvedValue(false);
    try {
      expect(await db.openRevocationLedger(founder.publicKey, signAsFounder)).toBe('already-open');
      expect(guard).toHaveBeenCalledWith(false);
    } finally {
      guard.mockRestore();
    }
    expect(await markerRows()).toHaveLength(1);
  }, 60_000);

  it('a refusal other than the primary-key collision still propagates', async () => {
    // Only the collision means "already filed". A stranger's signature is a real refusal
    // and must surface, or a misconfigured owner would silently never file the marker.
    const stranger = freshKeyPair();
    await expectConstraintFailure(
      db.openRevocationLedger(stranger.publicKey, message => signAs(stranger, message)),
      'Authorized',
    );
    expect(await markerRows()).toEqual([]);
  }, 60_000);

  it('SeedBootstrapService.openRevocationLedger files it under the configured owner key', async () => {
    node.initializeSeedBootstrap(founder.privateKey);
    const service = node.getSeedBootstrapService();
    expect(service).not.toBeNull();

    expect(await service!.openRevocationLedger()).toBe('opened');
    expect(await service!.openRevocationLedger()).toBe('already-open');
    expect(await markerRows()).toHaveLength(1);
  }, 60_000);

  // ── Schema refusals ────────────────────────────────────────────────────────

  it('an unsigned marker is refused (Authorized)', async () => {
    // RowIsGone and FreshTombstone both pass for the exact marker row, so Authorized is
    // the single rejector.
    await expectConstraintFailure(rawAppend(null, null), 'Authorized');
    expect(await markerRows()).toEqual([]);
  }, 60_000);

  it('a marker signed by a key that is not an owner is refused (Authorized)', async () => {
    const stranger = freshKeyPair();
    await expectConstraintFailure(
      rawAppend(stranger.publicKey, signAs(stranger, revocationMessage(MARKER_TABLE, MARKER_ROW_KEY, MARKER_STAMP))),
      'Authorized',
    );
    expect(await markerRows()).toEqual([]);
  }, 60_000);

  it('nothing but the exact marker may be filed under TableName Revocation, even owner-signed (RowIsGone)', async () => {
    // Each probe carries a valid founder signature over its own row, so Authorized passes
    // and RowIsGone is the single rejector. Without the pinned triple, 'Revocation' would be
    // an unbounded append surface that no reader filters.
    const probes: Array<[rowKey: string, stampId: string]> = [
      [MARKER_ROW_KEY, freshStamp()],
      ['not-the-ledger', MARKER_STAMP],
      ['not-the-ledger', freshStamp()],
    ];
    for (const [rowKey, stampId] of probes) {
      await expectConstraintFailure(
        rawAppend(founder.publicKey, appendSig(MARKER_TABLE, rowKey, stampId), MARKER_TABLE, rowKey, stampId),
        'RowIsGone',
      );
    }
    expect(await markerRows()).toEqual([]);
  }, 60_000);

  it('the marker can never be withdrawn, even owner-signed (NoDelete)', async () => {
    await db.openRevocationLedger(founder.publicKey, signAsFounder);
    await expectConstraintFailure(
      rawDb.exec(
        `delete from CadreControl.Revocation
           with context OwnerKey = ?, Signature = ?
           where StampId = ?`,
        [founder.publicKey, appendSig(MARKER_TABLE, MARKER_ROW_KEY, MARKER_STAMP), MARKER_STAMP],
      ),
      'NoDelete',
    );
    expect(await markerRows()).toHaveLength(1);
  }, 60_000);

  // ── A marker, not a retirement ─────────────────────────────────────────────

  it('a guarded row whose stamp is literally the marker stamp still passes NotRevoked', async () => {
    // Every NotRevoked filters on its own TableName, so the marker's StampId retires
    // nothing. Real stamps are 43 base64url characters and cannot be 'opened'; this is the
    // worst case on purpose.
    await db.openRevocationLedger(founder.publicKey, signAsFounder);

    const peerId = '12D3KooWLedgerStampTwin';
    const vouchSig = signB64(founder, cadrePeerVoucherDigest(peerId, MARKER_STAMP));
    await rawDb.exec(
      `insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [founder.publicKey, vouchSig, peerId, null, '', null, null, MARKER_STAMP, founder.publicKey, vouchSig],
    );
    expect(await db.queryCadrePeerStampId(peerId)).toBe(MARKER_STAMP);
    expect((await db.queryCadrePeers()).map(row => row.peerId)).toContain(peerId);

    const key = 'val-ledger-twin-' + Math.random().toString(36).slice(2);
    await rawDb.exec(
      `insert into CadreControl.ValidationKey (Key, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?)`,
      [founder.publicKey, signAsFounder(buildAuthorizationMessage('CadreControl.ValidationKey', 'add', [key, MARKER_STAMP])), key, MARKER_STAMP],
    );
    expect(await db.queryValidationKeyStampId(key)).toBe(MARKER_STAMP);
  }, 60_000);

  it('queryRevokedStamps never reports the marker stamp, for any revocable table', async () => {
    await db.openRevocationLedger(founder.publicKey, signAsFounder);
    for (const table of REVOCABLE_TABLES) {
      expect((await db.queryRevokedStamps(table)).has(MARKER_STAMP), `queryRevokedStamps('${table}')`).toBe(false);
    }
  }, 60_000);

  it('queryRevocations skips the marker and still returns real tombstones', async () => {
    await db.openRevocationLedger(founder.publicKey, signAsFounder);
    expect(await db.queryRevocations()).toEqual([]);

    const rowKey = '12D3KooWLedgerNeighbour';
    const stamp = freshStamp();
    await rawAppend(founder.publicKey, appendSig('CadrePeer', rowKey, stamp), 'CadrePeer', rowKey, stamp);
    const rows = await db.queryRevocations();
    expect(rows.map(row => [row.tableName, row.rowKey, row.stampId])).toEqual([['CadrePeer', rowKey, stamp]]);
  }, 60_000);

  it('the reap sweep ignores a marker-only table: 0 reaped, no per-row reap attempted', async () => {
    await db.openRevocationLedger(founder.publicKey, signAsFounder);
    const perRow = vi.spyOn(db, 'reapRevokedRow');
    try {
      expect(await db.reapRevokedRows('12D3KooWLedgerSweepSelf')).toBe(0);
      expect(perRow).not.toHaveBeenCalled();
    } finally {
      perRow.mockRestore();
    }
  }, 60_000);

  it('the first-growth re-issue sweep re-signs nothing when only the marker is held', async () => {
    node.initializeSeedBootstrap(founder.privateKey);
    const service = node.getSeedBootstrapService()!;
    expect(await service.openRevocationLedger()).toBe('opened');

    // drainPendingRevocations is private; it runs on the control connection's 0→≥1 edge.
    const internals = node as unknown as { drainPendingRevocations(): Promise<void>; reissuedHeldRevocations: boolean };
    const reissue = vi.spyOn(service, 'reissueRevocations');
    try {
      expect(internals.reissuedHeldRevocations).toBe(false);
      await internals.drainPendingRevocations();
      expect(reissue).not.toHaveBeenCalled();
      // The sweep still counts as done: the marker is not a tombstone waiting to be re-broadcast.
      expect(internals.reissuedHeldRevocations).toBe(true);
    } finally {
      reissue.mockRestore();
    }
    const rows = await markerRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].ReissuedAt)).toBe(0);
  }, 60_000);
});
