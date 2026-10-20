import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import debug from 'debug';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import {
  ownerGrantAddMessage,
  ownerGrantConsentMessage,
  ownerGrantRedeemMessage,
  OwnerGrantIssuerUnknownError,
  InvitationExhaustedError,
  isIssuedRowKeyConflict,
} from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';
import { canonicalDatetime } from '../src/canonical-datetime.js';
import type { OwnerGrantRow } from '../src/types.js';
import {
  expectConstraintFailure,
  freshKeyPair,
  freshStamp,
  revocationMessage,
  signAs,
} from './control-constraint-helpers.js';
import type { KeyPair } from './control-constraint-helpers.js';

/**
 * The owner-grant tables (`OwnerGrant`, `OwnerGrantUsage`) and the grant branch of
 * `OwnerKey.Authorized`, driven through `ControlDatabase` against a real control database,
 * so every constraint name below is the engine's own.
 *
 * A grant is an ed25519 keypair whose public half is the row key: the holder redeems by
 * signing with the private half, the key being seated signs that it is held, and a member
 * machine writes both into a usage row that seats the `OwnerKey` row with NO owner
 * signature and the grant's label. No machine is admitted. Withdrawal is a tombstone over a
 * row that stays, because the seated keys prove themselves through it.
 */

const log = debug('sereus:cadre:test:owner-grant');

describe('owner grants: schema and ControlDatabase', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

  const signFounder = (message: Uint8Array): string => signAs(founder, message);

  beforeAll(async () => {
    founder = freshKeyPair();
    node = new CadreNode({
      controlNetwork: {
        partyId: 'owner-grant-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      profile: 'transaction',
      // The anchor derives a grant-seated key from THIS pin, never from the OwnerKey table.
      trustedOwners: { pinnedKeys: [founder.publicKey] },
    });
    await node.start();
    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();
    expect(await db.ensureOwnerKey(founder.publicKey)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  /** The two signatures a redemption carries, over the exact fields the usage row will store, bound to the judging node's party. */
  function redemptionSignatures(grant: KeyPair, seated: KeyPair, usageStampId: string): { grantSig: string; ownerSig: string } {
    const fields = { grantKey: grant.publicKey, usageStampId, seatedKey: seated.publicKey };
    return {
      grantSig: signAs(grant, ownerGrantRedeemMessage(node.partyId, fields)),
      ownerSig: signAs(seated, ownerGrantConsentMessage(node.partyId, fields)),
    };
  }

  /** Issue a grant the production way: a fresh keypair, `issuer` (the founder unless given) signing the row. */
  async function issue(opts: { label?: string | null; expiresAtMs?: number | null; totalUses?: number | null; issuer?: KeyPair } = {}): Promise<{ grant: KeyPair; row: OwnerGrantRow }> {
    const grant = freshKeyPair();
    const issuer = opts.issuer ?? founder;
    const row = await db.insertOwnerGrant({
      key: grant.publicKey,
      label: opts.label ?? 'Backup',
      expiresAtMs: opts.expiresAtMs,
      totalUses: opts.totalUses,
    }, issuer.publicKey, message => signAs(issuer, message));
    return { grant, row };
  }

  /** Redeem `grant` for `seated` through the production writer, with a fresh nonce unless given. */
  function redeem(grant: KeyPair, seated: KeyPair, opts: { nowMs?: number; usageStampId?: string; grantSig?: string; ownerSig?: string } = {}) {
    const usageStampId = opts.usageStampId ?? freshStamp();
    const signatures = redemptionSignatures(grant, seated, usageStampId);
    return db.redeemOwnerGrant({
      grantKey: grant.publicKey,
      seatedKey: seated.publicKey,
      usageStampId,
      grantSig: opts.grantSig ?? signatures.grantSig,
      ownerSig: opts.ownerSig ?? signatures.ownerSig,
      nowMs: opts.nowMs,
    });
  }

  function ownerRow(key: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get('select Label, StampId, VouchOwner, VouchSig, VouchUsage from CadreControl.OwnerKey where Key = ?', [key]);
  }

  /** An owner-signed `OwnerGrant` row built by hand, as `insertOwnerGrant` would store it, so a case can present the holder's signed copy to a node that never seated it. */
  function mintGrantRow(issuer: KeyPair, grant: KeyPair, overrides: Partial<OwnerGrantRow> = {}): OwnerGrantRow {
    const signed = { key: grant.publicKey, label: 'Backup', expiresAt: null, totalUses: null, stampId: freshStamp(), ...overrides };
    return { ...signed, issuerKey: issuer.publicKey, issuerSig: signAs(issuer, ownerGrantAddMessage(node.partyId, signed)) };
  }

  /** The bare `OwnerGrantUsage` insert `redeemOwnerGrant` issues, with the writer-minted stamp under the case's control and valid signatures over whatever it carries. */
  async function rawInsertUsage(grant: KeyPair, seated: KeyPair, seatedStampId: string, usageStampId = freshStamp()): Promise<string> {
    const { grantSig, ownerSig } = redemptionSignatures(grant, seated, usageStampId);
    await rawDb.exec(
      `insert into CadreControl.OwnerGrantUsage (UsageStampId, GrantKey, SeatedKey, SeatedStampId, GrantSig, OwnerSig)
         with context Now = ?
         values (?, ?, ?, ?, ?, ?)`,
      [await canonicalDatetime(rawDb, Date.now()), usageStampId, grant.publicKey, seated.publicKey, seatedStampId, grantSig, ownerSig],
    );
    return usageStampId;
  }

  /** The bare grant-branch `OwnerKey` insert `redeemOwnerGrant` issues. */
  function rawInsertOwnerByConsent(seated: KeyPair, seatedStampId: string, usageStampId: string, issuerKey: string, label: string | null): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.OwnerKey (Key, Label, StampId, VouchOwner, VouchSig, VouchUsage)
         with context OwnerKey = null, Signature = null
         values (?, ?, ?, ?, null, ?)`,
      [seated.publicKey, label, seatedStampId, issuerKey, usageStampId],
    );
  }

  /** The bare `OwnerGrant` insert, so a case can seat a row inside a larger transaction. */
  function rawInsertGrant(row: OwnerGrantRow): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.OwnerGrant (Key, Label, ExpiresAt, TotalUses, IssuerKey, IssuerSig, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?, ?)`,
      [row.issuerKey, row.issuerSig, row.key, row.label, row.expiresAt, row.totalUses, row.issuerKey, row.issuerSig, row.stampId],
    );
  }

  /** A founder-signed `'OwnerGrant'` tombstone filed directly, as a node that never held the row would receive it. */
  function tombstoneGrant(key: string, stampId: string): Promise<void> {
    const signature = signFounder(revocationMessage(node.partyId, 'OwnerGrant', key, stampId));
    return rawDb.exec(
      `insert into CadreControl.Revocation (TableName, RowKey, StampId, SignerKey, SignerSig)
         with context OwnerKey = ?, Signature = ?
         values ('OwnerGrant', ?, ?, ?, ?)`,
      [founder.publicKey, signature, key, stampId, founder.publicKey, signature],
    );
  }

  /** Run `statements` in one explicit transaction: commit on success, rollback on failure. */
  async function inTransaction(statements: () => Promise<void>): Promise<void> {
    await rawDb.beginTransaction();
    try {
      await statements();
      await rawDb.commit();
    } catch (error) {
      try {
        await rawDb.rollback();
      } catch (rollbackError) {
        log('Rollback after a rejected transaction was a no-op: %s', rollbackError);
      }
      throw error;
    }
  }

  // ── Redemption ────────────────────────────────────────────────────────────

  it('redeems: seats the OwnerKey row by consent with the grant\'s label and its usage row; the anchor derives it; a retry is alreadyOwner and spends no use', async () => {
    const { grant, row } = await issue({ label: 'YubiKey', totalUses: 1 });
    expect(row.issuerKey).toBe(founder.publicKey);
    expect(row.label).toBe('YubiKey');
    expect(await db.queryOwnerGrant(grant.publicKey)).toEqual(row);
    const seated = freshKeyPair();

    const first = await redeem(grant, seated);
    expect(first.alreadyOwner).toBe(false);

    const owner = await ownerRow(seated.publicKey);
    expect(owner?.Label).toBe('YubiKey');
    expect(owner?.StampId).toBe(first.seatedStampId);
    expect(owner?.VouchOwner).toBe(founder.publicKey);
    expect(owner?.VouchSig).toBeNull();
    const usages = (await db.queryOwnerGrantUsages()).filter(usage => usage.grantKey === grant.publicKey);
    expect(usages).toHaveLength(1);
    expect(usages[0].usageStampId).toBe(owner?.VouchUsage);
    expect(usages[0].seatedKey).toBe(seated.publicKey);
    expect(usages[0].seatedStampId).toBe(first.seatedStampId);
    expect(await db.getOwnerKeys()).toContain(seated.publicKey);

    // The node's anchor walked the chain row -> usage -> grant -> pinned issuer on the write's refresh.
    const listed = (await node.listOwnerKeys()).find(key => key.key === seated.publicKey);
    expect(listed).toMatchObject({ label: 'YubiKey', vouchedBy: founder.publicKey, trusted: true });

    // The same nonce again, and a fresh nonce for a key that is already an owner: nothing written.
    expect(await redeem(grant, seated, { usageStampId: usages[0].usageStampId })).toEqual({ alreadyOwner: true, seatedStampId: first.seatedStampId });
    expect(await redeem(grant, seated)).toEqual({ alreadyOwner: true, seatedStampId: first.seatedStampId });
    expect(await db.countOwnerGrantUsage(grant.publicKey)).toBe(1);
  });

  it('redeems: a key removed earlier is seated again under a fresh stamp', async () => {
    const { grant } = await issue({ totalUses: 2 });
    const seated = freshKeyPair();
    const first = await redeem(grant, seated);
    expect(await db.deleteOwnerKey(seated.publicKey, founder.publicKey, signFounder)).toBe(true);
    expect(await db.getOwnerKeys()).not.toContain(seated.publicKey);

    const again = await redeem(grant, seated);
    expect(again.alreadyOwner).toBe(false);
    expect(again.seatedStampId).not.toBe(first.seatedStampId);
    expect(await db.getOwnerKeys()).toContain(seated.publicKey);
    expect(await db.countOwnerGrantUsage(grant.publicKey)).toBe(2);
  });

  // ── Refusals ──────────────────────────────────────────────────────────────

  interface Refusal {
    name: string;
    /** Arrange the state and return the write to attempt, which must be refused. */
    arrange: () => Promise<() => Promise<unknown>>;
    /** The constraint named by the engine, or the error class the writer refuses with by name. */
    refusedAs: string | (new (...args: never[]) => Error);
  }

  const refusals: Refusal[] = [
    {
      name: 'a withdrawn grant (Authorized); the tombstone is accepted with the row present, the row stays, and withdrawing twice is a no-op',
      arrange: async () => {
        const { grant, row } = await issue();
        expect(await db.withdrawOwnerGrant(grant.publicKey, founder.publicKey, signFounder)).toBe(true);
        expect(await db.queryOwnerGrant(grant.publicKey)).toEqual(row);
        expect(await db.queryRevokedStamps('OwnerGrant')).toContain(row.stampId);
        expect(await db.withdrawOwnerGrant(grant.publicKey, founder.publicKey, signFounder)).toBe(false);
        return () => redeem(grant, freshKeyPair());
      },
      refusedAs: 'Authorized',
    },
    {
      name: 'an expired grant (Authorized)',
      arrange: async () => {
        const now = Date.now();
        const { grant } = await issue({ expiresAtMs: now - 60_000 });
        return () => redeem(grant, freshKeyPair(), { nowMs: now });
      },
      refusedAs: 'Authorized',
    },
    {
      name: 'an exhausted grant, by name before any write (InvitationExhaustedError); the seated key\'s retry stays alreadyOwner',
      arrange: async () => {
        const { grant } = await issue({ totalUses: 1 });
        const first = freshKeyPair();
        expect((await redeem(grant, first)).alreadyOwner).toBe(false);
        expect((await redeem(grant, first)).alreadyOwner).toBe(true);
        return () => redeem(grant, freshKeyPair());
      },
      refusedAs: InvitationExhaustedError,
    },
    {
      name: 'a grant whose issuer was removed since issuing (Authorized)',
      arrange: async () => {
        const second = freshKeyPair();
        expect(await db.insertOwnerKeyVouched(second.publicKey, founder.publicKey, signFounder)).toBe(true);
        const { grant } = await issue({ issuer: second });
        expect(await db.deleteOwnerKey(second.publicKey, founder.publicKey, signFounder)).toBe(true);
        return () => redeem(grant, freshKeyPair());
      },
      refusedAs: 'Authorized',
    },
    {
      name: 'a GrantSig by a key other than the grant key (GrantPossessed)',
      arrange: async () => {
        const { grant } = await issue();
        const seated = freshKeyPair();
        const usageStampId = freshStamp();
        const forged = redemptionSignatures(freshKeyPair(), seated, usageStampId).grantSig;
        return () => redeem(grant, seated, { usageStampId, grantSig: forged });
      },
      refusedAs: 'GrantPossessed',
    },
    {
      name: 'an OwnerSig by a key other than the seated key (OwnerConsented)',
      arrange: async () => {
        const { grant } = await issue();
        const seated = freshKeyPair();
        const usageStampId = freshStamp();
        const forged = redemptionSignatures(grant, freshKeyPair(), usageStampId).ownerSig;
        return () => redeem(grant, seated, { usageStampId, ownerSig: forged });
      },
      refusedAs: 'OwnerConsented',
    },
    {
      name: 'an OwnerKey row seated by consent under a label other than the grant\'s (OwnerKey.Authorized)',
      arrange: async () => {
        const { grant, row } = await issue({ label: 'Backup' });
        const seated = freshKeyPair();
        const seatedStampId = freshStamp();
        return () => inTransaction(async () => {
          const usageStampId = await rawInsertUsage(grant, seated, seatedStampId);
          await rawInsertOwnerByConsent(seated, seatedStampId, usageStampId, row.issuerKey, 'Phone');
        });
      },
      refusedAs: 'Authorized',
    },
    {
      name: 'an OwnerKey row seated by consent whose usage names another key (OwnerKey.Authorized)',
      arrange: async () => {
        const { grant, row } = await issue();
        const seated = freshKeyPair();
        const other = freshKeyPair();
        const seatedStampId = freshStamp();
        // The usage row and the key it names are valid, so only the second row's branch refuses.
        return () => inTransaction(async () => {
          const usageStampId = await rawInsertUsage(grant, seated, seatedStampId);
          await rawInsertOwnerByConsent(seated, seatedStampId, usageStampId, row.issuerKey, row.label);
          await rawInsertOwnerByConsent(other, freshStamp(), usageStampId, row.issuerKey, row.label);
        });
      },
      refusedAs: 'Authorized',
    },
    {
      name: 'a grant seated and redeemed in one transaction (Authorized, from the committed reads)',
      arrange: async () => {
        const holder = freshKeyPair();
        const signedRow = mintGrantRow(founder, holder);
        const seated = freshKeyPair();
        const seatedStampId = freshStamp();
        return () => inTransaction(async () => {
          await rawInsertGrant(signedRow);
          const usageStampId = await rawInsertUsage(holder, seated, seatedStampId);
          await rawInsertOwnerByConsent(seated, seatedStampId, usageStampId, signedRow.issuerKey, signedRow.label);
        });
      },
      refusedAs: 'Authorized',
    },
  ];

  it.each(refusals)('refuses: $name', async ({ arrange, refusedAs }) => {
    const attempt = await arrange();
    const ownersBefore = await db.getOwnerKeys();
    const refused = attempt();
    if (typeof refusedAs === 'string') {
      await expectConstraintFailure(refused, refusedAs);
    } else {
      await expect(refused).rejects.toThrow(refusedAs);
    }
    // Nothing a refused write would have seated is an owner.
    expect(await db.getOwnerKeys()).toEqual(ownersBefore);
  });

  // ── Seating a row from its bundle, and standing ───────────────────────────

  it('seatOwnerGrant: refuses a row whose issuer is not an owner here by name; seating twice is a no-op; refuses the holder\'s copy of a withdrawn grant (NotRevoked)', async () => {
    const foreign = mintGrantRow(freshKeyPair(), freshKeyPair());
    await expect(db.seatOwnerGrant(foreign)).rejects.toThrow(OwnerGrantIssuerUnknownError);
    expect(await db.queryOwnerGrant(foreign.key)).toBeNull();

    const carried = mintGrantRow(founder, freshKeyPair(), { totalUses: 2 });
    expect(await db.seatOwnerGrant(carried)).toBe(true);
    expect(await db.seatOwnerGrant(carried)).toBe(false);
    expect(await db.queryOwnerGrant(carried.key)).toEqual(carried);

    // A node that received the withdrawal but never the row: the tombstone names the stamp the holder's copy carries.
    const withdrawn = mintGrantRow(founder, freshKeyPair());
    await tombstoneGrant(withdrawn.key, withdrawn.stampId);
    await expectConstraintFailure(db.seatOwnerGrant(withdrawn), 'NotRevoked');
    expect(await db.queryOwnerGrant(withdrawn.key)).toBeNull();
  });

  it('a repeat insert of a held grant is classified as an OwnerGrant key conflict, the refusal a lagging member\'s seat counts as seated', async () => {
    // A member whose store lags the cohort misses the row on its guard read, and a member holding
    // it refuses the commit; the seat adopts the row on exactly this classification, so pin it
    // against the live engine error.
    const held = mintGrantRow(founder, freshKeyPair());
    expect(await db.seatOwnerGrant(held)).toBe(true);

    const error = await rawInsertGrant(held).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isIssuedRowKeyConflict(error, 'OwnerGrant')).toBe(true);
    expect(isIssuedRowKeyConflict(error, 'CadreInvite')).toBe(false);
  });

  it('standing: listOwnerGrantStatuses and isOwnerGrantLive read live, withdrawn, expired and exhausted the way the redemption does', async () => {
    const now = Date.now();
    const live = await issue({ totalUses: 2, expiresAtMs: now + 60 * 60_000 });
    const withdrawn = await issue();
    expect(await db.withdrawOwnerGrant(withdrawn.grant.publicKey, founder.publicKey, signFounder)).toBe(true);
    const expired = await issue({ expiresAtMs: now - 1 });
    const exhausted = await issue({ totalUses: 1 });
    expect((await redeem(exhausted.grant, freshKeyPair(), { nowMs: now })).alreadyOwner).toBe(false);

    const statuses = new Map((await db.listOwnerGrantStatuses(now)).map(status => [status.grant.key, status]));
    expect(statuses.get(live.grant.publicKey)).toEqual({ grant: live.row, live: true, withdrawn: false, usesRecorded: 0 });
    expect(statuses.get(withdrawn.grant.publicKey)).toEqual({ grant: withdrawn.row, live: false, withdrawn: true, usesRecorded: 0 });
    expect(statuses.get(expired.grant.publicKey)).toEqual({ grant: expired.row, live: false, withdrawn: false, usesRecorded: 0 });
    expect(statuses.get(exhausted.grant.publicKey)).toEqual({ grant: exhausted.row, live: false, withdrawn: false, usesRecorded: 1 });

    // Judged as a redemption judges it: on the row held here, read first.
    const liveHere = async (grant: OwnerGrantRow): Promise<boolean> => db.isOwnerGrantLive(grant, await db.queryOwnerGrant(grant.key), now);
    expect(await liveHere(live.row)).toBe(true);
    expect(await liveHere(exhausted.row)).toBe(false);
    // A bundle's copy not seated here is judged by its own signature: a valid one is live, a forged one is not.
    const carried = mintGrantRow(founder, freshKeyPair());
    expect(await liveHere(carried)).toBe(true);
    expect(await liveHere({ ...carried, issuerSig: mintGrantRow(freshKeyPair(), freshKeyPair()).issuerSig })).toBe(false);
  });
});
