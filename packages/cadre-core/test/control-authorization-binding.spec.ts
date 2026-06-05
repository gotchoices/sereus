import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
  randomBytes,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { buildAuthorizationMessage } from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';

/**
 * Verifies the row-bound, single-use authorization scheme for the privileged control
 * tables (AuthorityKey / ValidationKey / Strand). Each authority signature is bound to
 * the row's contents (not a bare stamp), and the StampId is a unique single-use column,
 * so a captured `(StampId, Signature)` pair cannot be transplanted onto an attacker-
 * chosen row (privilege escalation) or replayed.
 *
 * Boots a real CadreNode (empty bootstrap, transaction profile — no network peers), the
 * same harness the genesis spec uses, and drives both the real writers
 * (`insertStrand` / `insertValidationKey`) and raw SQL to exercise the attack paths.
 */
describe('control authorization binding (row-bound + single-use stamp)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let authorityPrivateKey: string;
  let authorityPublicKey: string;

  // ed25519-sign the raw canonical message bytes (no pre-hash), as the writers expect.
  const signMessage = (message: Uint8Array): string =>
    cryptoSign(message, authorityPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

  const freshStamp = (): string => randomBytes(256, 'base64url') as string;

  async function strandCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.Strand');
    return Number(row?.c ?? 0);
  }

  async function authorityKeyCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.AuthorityKey');
    return Number(row?.c ?? 0);
  }

  async function validationKeyCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.ValidationKey');
    return Number(row?.c ?? 0);
  }

  function rawInsertStrand(
    sig: string | null,
    id: string,
    type: string,
    memberPrivateKey: string | null,
    stampId: string,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
         with context AuthorityKey = ?, Signature = ?
         values (?, ?, ?, ?)`,
      [authorityPublicKey, sig, id, type, memberPrivateKey, stampId],
    );
  }

  function rawInsertAuthorityKey(sig: string | null, key: string, stampId: string): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.AuthorityKey (Key, StampId)
         with context AuthorityKey = ?, Signature = ?
         values (?, ?)`,
      [authorityPublicKey, sig, key, stampId],
    );
  }

  function rawInsertValidationKey(sig: string | null, key: string, stampId: string): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.ValidationKey (Key, StampId)
         with context AuthorityKey = ?, Signature = ?
         values (?, ?)`,
      [authorityPublicKey, sig, key, stampId],
    );
  }

  async function inviteCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.FormationInvite');
    return Number(row?.c ?? 0);
  }

  /**
   * Build the FormationInvite row-bound authorization message in the schema's field
   * order: Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId.
   * Null/absent ExpiresAt/TotalUses/ValidationUrl/StrandId sign as '' (matching the
   * schema's coalesce(...,'')), and TotalUses is the decimal string (matching
   * cast(new.TotalUses as text)). Tests pass an already-canonical datetime literal for
   * ExpiresAt (DATETIME parse is idempotent on it), so no per-test engine
   * canonicalisation is needed. The raw inserts below omit the StrandId column (defaults
   * null → signs as ''), so these tests exercise the unbound/legacy path.
   */
  function inviteMessage(fields: {
    token: string;
    sAppId: string;
    expiresAt?: string;
    totalUses?: number;
    validationUrl?: string;
    strandId?: string;
    stampId: string;
  }): Uint8Array {
    return buildAuthorizationMessage([
      fields.token,
      fields.sAppId,
      fields.expiresAt ?? '',
      fields.totalUses == null ? '' : String(fields.totalUses),
      fields.validationUrl ?? '',
      fields.strandId ?? '',
      fields.stampId,
    ]);
  }

  function rawInsertFormationInvite(
    sig: string | null,
    token: string,
    sAppId: string,
    expiresAt: string | null,
    totalUses: number | null,
    validationUrl: string | null,
    stampId: string,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.FormationInvite (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StampId)
         with context AuthorityKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?)`,
      [authorityPublicKey, sig, token, sAppId, expiresAt, totalUses, validationUrl, stampId],
    );
  }

  function rawDeleteFormationInvite(sig: string | null, token: string): Promise<void> {
    return rawDb.exec(
      `delete from CadreControl.FormationInvite
         with context AuthorityKey = ?, Signature = ?
         where Token = ?`,
      [authorityPublicKey, sig, token],
    );
  }

  function rawUpdateInviteTotalUses(token: string, totalUses: number): Promise<void> {
    return rawDb.exec(
      `update CadreControl.FormationInvite set TotalUses = ? where Token = ?`,
      [totalUses, token],
    );
  }

  beforeAll(async () => {
    authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    authorityPublicKey = getPublicKey(authorityPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: {
        partyId: 'authz-binding-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();

    // Bootstrap founding authority (unsigned branch). Idempotent + single row.
    expect(await db.ensureAuthorityKey(authorityPublicKey)).toBe(true);
    expect(await authorityKeyCount()).toBe(1);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  it('bootstrap persisted a unique StampId on the founding authority row', async () => {
    const row = await rawDb.get('select StampId from CadreControl.AuthorityKey where Key = ?', [authorityPublicKey]);
    expect(typeof row?.StampId).toBe('string');
    expect((row?.StampId as string).length).toBeGreaterThan(0);
  });

  it('happy path: insertStrand with a correctly-built signature succeeds and stamps the row', async () => {
    const before = await strandCount();
    const strandId = 'strand-happy-' + Math.random().toString(36).slice(2);

    await db.insertStrand(strandId, 'o', authorityPublicKey, signMessage);

    expect(await strandCount()).toBe(before + 1);
    const row = await rawDb.get('select Type, StampId from CadreControl.Strand where Id = ?', [strandId]);
    expect(row?.Type).toBe('o');
    expect(typeof row?.StampId).toBe('string');
    expect((row?.StampId as string).length).toBeGreaterThan(0);
  });

  it('happy path: a closed strand carrying a real MemberPrivateKey round-trips (non-null coalesce path)', async () => {
    // The negative tamper test only proves verify *fails* for a mutated member key; it
    // cannot prove the legitimate non-empty `coalesce(new.MemberPrivateKey, '')` path —
    // where buildAuthorizationMessage and the SQL coalesce must agree on the actual key
    // bytes — actually round-trips. This is the only positive exercise of that path.
    const before = await strandCount();
    const strandId = 'strand-closed-' + Math.random().toString(36).slice(2);
    const memberPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;

    await db.insertStrand(strandId, 'c', authorityPublicKey, signMessage, memberPrivateKey);

    expect(await strandCount()).toBe(before + 1);
    const row = await rawDb.get(
      'select Type, MemberPrivateKey, StampId from CadreControl.Strand where Id = ?',
      [strandId],
    );
    expect(row?.Type).toBe('c');
    expect(row?.MemberPrivateKey).toBe(memberPrivateKey);
    expect((row?.StampId as string).length).toBeGreaterThan(0);
  });

  it('transplant rejected: a valid Strand signature cannot be moved onto a different row (privilege escalation)', async () => {
    const stamp = freshStamp();
    const s1 = 'strand-src-' + Math.random().toString(36).slice(2);
    const s2 = 'strand-attacker-' + Math.random().toString(36).slice(2);

    // Authority signs a valid authorization for s1 (Id, Type, '', stamp).
    const sig = signMessage(buildAuthorizationMessage([s1, 'o', '', stamp]));

    const before = await strandCount();
    // Attacker transplants the (stamp, sig) pair onto a DIFFERENT strand id.
    await expect(rawInsertStrand(sig, s2, 'o', null, stamp)).rejects.toThrow();
    expect(await strandCount()).toBe(before);
    expect(await rawDb.get('select Id from CadreControl.Strand where Id = ?', [s2])).toBeUndefined();
  });

  it('cross-table transplant rejected: a Strand signature cannot authorize an AuthorityKey insert', async () => {
    const stamp = freshStamp();
    const sId = 'strand-xtab-' + Math.random().toString(36).slice(2);
    // A valid Strand authorization (4-field message).
    const strandSig = signMessage(buildAuthorizationMessage([sId, 'o', '', stamp]));

    const attackerKey = generatePrivateKey('ed25519', 'base64url') as string;
    const attackerPub = getPublicKey(attackerKey, 'ed25519', 'base64url', 'base64url') as string;

    const before = await authorityKeyCount();
    // Self-grant authority by reusing the Strand pair on the AuthorityKey table.
    await expect(rawInsertAuthorityKey(strandSig, attackerPub, stamp)).rejects.toThrow();
    expect(await authorityKeyCount()).toBe(before);
    expect(await rawDb.get('select Key from CadreControl.AuthorityKey where Key = ?', [attackerPub])).toBeUndefined();
  });

  it('replay rejected: re-using the exact (Id, StampId, Signature) is blocked by the unique StampId', async () => {
    const stamp = freshStamp();
    const id = 'strand-replay-' + Math.random().toString(36).slice(2);
    const sig = signMessage(buildAuthorizationMessage([id, 'o', '', stamp]));

    // First insert is valid and succeeds.
    await rawInsertStrand(sig, id, 'o', null, stamp);
    const after = await strandCount();

    // Exact replay of the same row is rejected (PK + unique StampId).
    await expect(rawInsertStrand(sig, id, 'o', null, stamp)).rejects.toThrow();
    expect(await strandCount()).toBe(after);
  });

  it('tamper rejected: mutating a signed field (Type) after signing fails verification', async () => {
    const stamp = freshStamp();
    const id = 'strand-tamper-' + Math.random().toString(36).slice(2);
    // Sign for Type 'o' ...
    const sig = signMessage(buildAuthorizationMessage([id, 'o', '', stamp]));

    const before = await strandCount();
    // ... but insert the row with Type 'c'. The verify rebinds to 'c' and fails.
    await expect(rawInsertStrand(sig, id, 'c', null, stamp)).rejects.toThrow();
    expect(await strandCount()).toBe(before);
    expect(await rawDb.get('select Id from CadreControl.Strand where Id = ?', [id])).toBeUndefined();
  });

  it('tamper rejected: mutating the signed MemberPrivateKey after signing fails verification', async () => {
    const stamp = freshStamp();
    const id = 'strand-tamper-mpk-' + Math.random().toString(36).slice(2);
    // Sign for an empty (null) MemberPrivateKey ...
    const sig = signMessage(buildAuthorizationMessage([id, 'c', '', stamp]));

    const before = await strandCount();
    // ... but insert a row carrying an actual MemberPrivateKey.
    await expect(rawInsertStrand(sig, id, 'c', 'smuggled-member-key', stamp)).rejects.toThrow();
    expect(await strandCount()).toBe(before);
  });

  it('ValidationKey happy path: insertValidationKey with a correct signature succeeds and stamps the row', async () => {
    const before = await validationKeyCount();
    const valKey = 'val-' + (generatePrivateKey('ed25519', 'base64url') as string);

    await db.insertValidationKey(valKey, authorityPublicKey, signMessage);

    expect(await validationKeyCount()).toBe(before + 1);
    const row = await rawDb.get('select StampId from CadreControl.ValidationKey where Key = ?', [valKey]);
    expect(typeof row?.StampId).toBe('string');
    expect((row?.StampId as string).length).toBeGreaterThan(0);
  });

  it('ValidationKey transplant rejected: a valid signature cannot be moved onto a different key', async () => {
    const stamp = freshStamp();
    const k1 = 'val-src-' + Math.random().toString(36).slice(2);
    const k2 = 'val-attacker-' + Math.random().toString(36).slice(2);
    const sig = signMessage(buildAuthorizationMessage([k1, stamp]));

    const before = await validationKeyCount();
    await expect(rawInsertValidationKey(sig, k2, stamp)).rejects.toThrow();
    expect(await validationKeyCount()).toBe(before);
    expect(await rawDb.get('select Key from CadreControl.ValidationKey where Key = ?', [k2])).toBeUndefined();
  });

  it('ValidationKey replay rejected: re-using the exact (Key, StampId, Signature) is blocked', async () => {
    const stamp = freshStamp();
    const key = 'val-replay-' + Math.random().toString(36).slice(2);
    const sig = signMessage(buildAuthorizationMessage([key, stamp]));

    await rawInsertValidationKey(sig, key, stamp);
    const after = await validationKeyCount();

    await expect(rawInsertValidationKey(sig, key, stamp)).rejects.toThrow();
    expect(await validationKeyCount()).toBe(after);
  });

  it('AuthorityKey happy path: an existing authority can enroll a new authority by row-bound signature', async () => {
    const stamp = freshStamp();
    const newAuthKey = generatePrivateKey('ed25519', 'base64url') as string;
    const newAuthPub = getPublicKey(newAuthKey, 'ed25519', 'base64url', 'base64url') as string;
    const sig = signMessage(buildAuthorizationMessage([newAuthPub, stamp]));

    const before = await authorityKeyCount();
    await rawInsertAuthorityKey(sig, newAuthPub, stamp);
    expect(await authorityKeyCount()).toBe(before + 1);
  });

  it('AuthorityKey transplant rejected: a captured pair cannot self-grant a different authority', async () => {
    const stamp = freshStamp();
    const k1 = generatePrivateKey('ed25519', 'base64url') as string;
    const k1Pub = getPublicKey(k1, 'ed25519', 'base64url', 'base64url') as string;
    const attackerPub = getPublicKey(
      generatePrivateKey('ed25519', 'base64url') as string,
      'ed25519',
      'base64url',
      'base64url',
    ) as string;

    // Valid authorization built for k1Pub ...
    const sig = signMessage(buildAuthorizationMessage([k1Pub, stamp]));

    const before = await authorityKeyCount();
    // ... transplanted onto an attacker-chosen key. Rebound verify fails.
    await expect(rawInsertAuthorityKey(sig, attackerPub, stamp)).rejects.toThrow();
    expect(await authorityKeyCount()).toBe(before);
    expect(await rawDb.get('select Key from CadreControl.AuthorityKey where Key = ?', [attackerPub])).toBeUndefined();
  });

  // --- FormationInvite: row-bound + single-use stamp (this ticket) ----------------------
  // Before this fix FormationInvite.AuthorizedAddOrRemove verified a BARE stamp
  // (digest(context.StampId)), so a captured (StampId, Signature) authorized the insert of
  // any attacker-chosen invite (Token / sAppId / ExpiresAt / TotalUses / ValidationUrl) and
  // could be replayed. The signature is now bound to the whole row and the StampId is a
  // unique single-use column.

  it('FormationInvite happy path: insertFormationInvite with all options round-trips and stamps the row', async () => {
    // The ONLY integration test that proves the writer's engine-canonicalised ExpiresAt and
    // String(TotalUses) byte-match the deferred-CHECK coerced values: if they did not, the
    // verify would reject and this insert would throw.
    const before = await inviteCount();
    const token = 'fi-happy-' + Math.random().toString(36).slice(2);
    const expiresAtMs = Date.parse('2031-03-04T12:34:56Z');

    await db.insertFormationInvite(token, 'sapp-fi', authorityPublicKey, signMessage, {
      expiresAtMs,
      totalUses: 5,
      validationUrl: 'https://hook.example/validate',
    });

    expect(await inviteCount()).toBe(before + 1);
    const row = await rawDb.get(
      'select sAppId, TotalUses, ValidationUrl, ExpiresAt, StampId from CadreControl.FormationInvite where Token = ?',
      [token],
    );
    expect(row?.sAppId).toBe('sapp-fi');
    expect(Number(row?.TotalUses)).toBe(5);
    expect(row?.ValidationUrl).toBe('https://hook.example/validate');
    expect(typeof row?.ExpiresAt).toBe('string');
    expect((row?.ExpiresAt as string).length).toBeGreaterThan(0);
    expect(typeof row?.StampId).toBe('string');
    expect((row?.StampId as string).length).toBeGreaterThan(0);
  });

  it('FormationInvite transplant rejected: a valid signature cannot be moved onto a different row (privilege escalation)', async () => {
    const stamp = freshStamp();
    const t1 = 'fi-src-' + Math.random().toString(36).slice(2);
    const t2 = 'fi-attacker-' + Math.random().toString(36).slice(2);

    // Authority signs a valid authorization for invite t1 (single-use, no expiry/url).
    const sig = signMessage(inviteMessage({ token: t1, sAppId: 'sapp-a', totalUses: 1, stampId: stamp }));

    const before = await inviteCount();
    // Attacker transplants the captured (stamp, sig) onto a DIFFERENT token with escalated uses.
    await expect(
      rawInsertFormationInvite(sig, t2, 'sapp-a', null, 999999, null, stamp),
    ).rejects.toThrow();
    expect(await inviteCount()).toBe(before);
    expect(await rawDb.get('select Token from CadreControl.FormationInvite where Token = ?', [t2])).toBeUndefined();
  });

  it('FormationInvite per-field tamper rejected: mutating any bound field after signing fails verification', async () => {
    const EXP_A = '2030-01-01T00:00:00';
    const EXP_B = '2040-01-01T00:00:00';
    const base = { sAppId: 'sapp-base', expiresAt: EXP_A, totalUses: 3, validationUrl: 'https://a.example' };
    type InviteRow = { sAppId: string; expiresAt: string; totalUses: number; validationUrl: string };
    // Token tamper is the transplant case above; here cover the other four bound fields.
    const cases: Array<{ field: string; mutate: (r: InviteRow) => InviteRow }> = [
      { field: 'sAppId', mutate: r => ({ ...r, sAppId: 'sapp-tampered' }) },
      { field: 'ExpiresAt', mutate: r => ({ ...r, expiresAt: EXP_B }) },
      { field: 'TotalUses', mutate: r => ({ ...r, totalUses: 999 }) },
      { field: 'ValidationUrl', mutate: r => ({ ...r, validationUrl: 'https://evil.example' }) },
    ];

    for (const c of cases) {
      const stamp = freshStamp();
      const token = `fi-tamper-${c.field}-` + Math.random().toString(36).slice(2);
      const signed: InviteRow = { ...base };
      const tampered = c.mutate(signed);

      // Sign over `signed`, then insert the `tampered` row reusing the same (stamp, sig).
      const sig = signMessage(inviteMessage({
        token, sAppId: signed.sAppId, expiresAt: signed.expiresAt,
        totalUses: signed.totalUses, validationUrl: signed.validationUrl, stampId: stamp,
      }));

      const before = await inviteCount();
      await expect(
        rawInsertFormationInvite(
          sig, token, tampered.sAppId, tampered.expiresAt, tampered.totalUses, tampered.validationUrl, stamp,
        ),
        `tampering ${c.field} should be rejected`,
      ).rejects.toThrow();
      expect(await inviteCount(), `no row should land when ${c.field} is tampered`).toBe(before);
    }
  });

  it('FormationInvite replay rejected: re-inserting the exact (row, StampId, Signature) is blocked', async () => {
    const stamp = freshStamp();
    const token = 'fi-replay-' + Math.random().toString(36).slice(2);
    const sig = signMessage(inviteMessage({ token, sAppId: 'sapp-replay', totalUses: 1, stampId: stamp }));

    await rawInsertFormationInvite(sig, token, 'sapp-replay', null, 1, null, stamp);
    const after = await inviteCount();

    await expect(
      rawInsertFormationInvite(sig, token, 'sapp-replay', null, 1, null, stamp),
    ).rejects.toThrow();
    expect(await inviteCount()).toBe(after);
  });

  it('FormationInvite single-use: a second validly-signed invite reusing a live StampId is rejected by the unique column', async () => {
    // Isolates the single-use property from the PK: the second invite is a DIFFERENT token
    // with its OWN correct signature, so the row-bound verify passes — only the unique
    // StampId column rejects the stamp reuse.
    const stamp = freshStamp();
    const tokenA = 'fi-su-a-' + Math.random().toString(36).slice(2);
    const tokenB = 'fi-su-b-' + Math.random().toString(36).slice(2);

    const sigA = signMessage(inviteMessage({ token: tokenA, sAppId: 'sapp-su', totalUses: 1, stampId: stamp }));
    await rawInsertFormationInvite(sigA, tokenA, 'sapp-su', null, 1, null, stamp);
    const after = await inviteCount();

    const sigB = signMessage(inviteMessage({ token: tokenB, sAppId: 'sapp-su', totalUses: 1, stampId: stamp }));
    await expect(
      rawInsertFormationInvite(sigB, tokenB, 'sapp-su', null, 1, null, stamp),
    ).rejects.toThrow();
    expect(await inviteCount()).toBe(after);
    expect(await rawDb.get('select Token from CadreControl.FormationInvite where Token = ?', [tokenB])).toBeUndefined();
  });

  it('FormationInvite delete branch: a row-bound delete signature over the OLD row succeeds; a forged one is rejected', async () => {
    const stamp = freshStamp();
    const token = 'fi-del-' + Math.random().toString(36).slice(2);
    const sAppId = 'sapp-del';
    const expiresAt = '2030-01-01T00:00:00';
    const totalUses = 2;
    const validationUrl = 'https://del.example';

    // Insert a valid invite carrying the full field set.
    const insertSig = signMessage(inviteMessage({ token, sAppId, expiresAt, totalUses, validationUrl, stampId: stamp }));
    await rawInsertFormationInvite(insertSig, token, sAppId, expiresAt, totalUses, validationUrl, stamp);
    const present = await inviteCount();

    // A forged delete signature (over a different stamp) is rejected; the row remains.
    const forgedSig = signMessage(inviteMessage({ token, sAppId, expiresAt, totalUses, validationUrl, stampId: freshStamp() }));
    await expect(rawDeleteFormationInvite(forgedSig, token)).rejects.toThrow();
    expect(await inviteCount()).toBe(present);

    // A delete signature bound to the OLD row (stored columns incl. StampId) succeeds. The
    // delete branch's coalesce(new, old) reads the OLD row, whose bound message equals the
    // insert message (same field values).
    const deleteSig = signMessage(inviteMessage({ token, sAppId, expiresAt, totalUses, validationUrl, stampId: stamp }));
    await rawDeleteFormationInvite(deleteSig, token);
    expect(await inviteCount()).toBe(present - 1);
    expect(await rawDb.get('select Token from CadreControl.FormationInvite where Token = ?', [token])).toBeUndefined();
  });

  it('FormationInvite cross-table transplant rejected: an invite signature cannot authorize a Strand insert', async () => {
    const stamp = freshStamp();
    const token = 'fi-xtab-' + Math.random().toString(36).slice(2);
    // A valid FormationInvite authorization (6-field message).
    const inviteSig = signMessage(inviteMessage({ token, sAppId: 'sapp-xtab', totalUses: 1, stampId: stamp }));

    const attackerStrand = 'strand-from-invite-' + Math.random().toString(36).slice(2);
    const before = await strandCount();
    // Reuse the invite pair on the Strand table — the Strand verify rebinds and fails.
    await expect(rawInsertStrand(inviteSig, attackerStrand, 'o', null, stamp)).rejects.toThrow();
    expect(await strandCount()).toBe(before);
    expect(await rawDb.get('select Id from CadreControl.Strand where Id = ?', [attackerStrand])).toBeUndefined();
  });

  it('FormationInvite tamper-via-update rejected: a row cannot be mutated after insertion (no unauthorized update)', async () => {
    // Row-binding only guards inserts/deletes; without an update guard an attacker could
    // insert a legit invite then UPDATE the consent parameters (TotalUses / ExpiresAt) with
    // NO signature, defeating the whole point. FormationInvite rows are insert/delete only.
    const token = 'fi-noupd-' + Math.random().toString(36).slice(2);
    await db.insertFormationInvite(token, 'sapp-noupd', authorityPublicKey, signMessage, { totalUses: 1 });

    await expect(rawUpdateInviteTotalUses(token, 999999)).rejects.toThrow();
    const row = await rawDb.get('select TotalUses from CadreControl.FormationInvite where Token = ?', [token]);
    expect(Number(row?.TotalUses)).toBe(1);
  });
});
