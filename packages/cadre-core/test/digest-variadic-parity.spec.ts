import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database, registerPlugin } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { generatePrivateKey, getPublicKey, sign } from '@optimystic/quereus-plugin-crypto';
import { buildAuthorizationMessage } from '../src/control-database.js';
import { peerRecordSignedPayload } from '../src/peer-record.js';
import { signStrandPayload } from '../src/strand-membership-writer.js';

/**
 * The single dominant failure mode of the variadic-digest migration is TS↔SQL
 * byte-parity: a TS signer and its matching SQL `verify(digest(...))` constraint
 * must hash IDENTICAL bytes, or verification fails closed (rejects every signed
 * row) without throwing — invisible to a type-check.
 *
 * This guard pins parity directly, with no control/strand DB or libp2p stack: it
 * registers ONLY the crypto plugin into a bare Quereus `Database` (same default
 * config — sha256 / base64url — that `ControlDatabase` and `connectToStrand` use),
 * signs in TS, and asserts the SQL `verify(digest(...))` the schema constraints run
 * accepts the signature and rejects a one-field tamper. One representative of each
 * call shape the migration touches:
 *   (a) a control MULTI-field message (`buildAuthorizationMessage`) ⇔ `digest(tags…,f1,…,fN)`
 *   (b) a peer-record tagged multi-field payload                    ⇔ `digest(tags…,f1,…,fN)`
 *   (c) a strand SINGLE-string payload (`signStrandPayload`)         ⇔ `digest(payload)`
 *   (d) the leading LITERAL domain/action tags: TS passes them as the first two
 *       array elements, the schema writes them as literal SQL arguments — this is
 *       the parity the whole domain-separation scheme rests on
 *
 * In all four the SQL side is `verify(digest(<fields>), <sig>, <pubkey>, 'ed25519')`:
 * SQL `digest(...)` returns a base64url string that `verify`'s default base64url input
 * encoding decodes back to the raw digest bytes the TS side signed (over `'bytes'` for
 * (a)/(c)/(d), or the base64url digest string for (b) — same raw bytes either way).
 */
describe('digest-variadic TS↔SQL byte parity', () => {
  let db: Database;
  let priv: string;
  let pub: string;

  beforeEach(async () => {
    db = new Database();
    // Default config (sha256 / base64url), matching ControlDatabase + connectToStrand.
    await registerPlugin(db, cryptoPlugin);
    priv = generatePrivateKey('ed25519', 'base64url') as string;
    pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
  });

  afterEach(() => {
    db.close();
  });

  /** SQL `verify(digest(f1, …, fN), sig, key, 'ed25519')` over N variadic TEXT fields. */
  async function sqlVerify(fields: string[], sig: string, key: string): Promise<boolean> {
    const placeholders = fields.map(() => '?').join(', ');
    const row = await db.get(
      `select verify(digest(${placeholders}), ?, ?, 'ed25519') as ok`,
      [...fields, sig, key],
    );
    return Boolean(row?.ok);
  }

  it('(a) control multi-field: buildAuthorizationMessage ⇔ verify(digest(tags…,f1,…,fN))', async () => {
    // Field order/shape mirrors a closed Strand: Id, Type, MemberPrivateKey (''), StampId.
    const rowFields = ['strand-id-xyz', 'c', '', 'stamp-abc'];
    const message = buildAuthorizationMessage('CadreControl.Strand', 'add', rowFields);
    // ed25519 signs the raw digest bytes directly (no second hash), exactly as the writers do.
    const sig = sign(message, priv, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

    expect(await sqlVerify(['CadreControl.Strand', 'add', ...rowFields], sig, pub)).toBe(true);
    // Tamper one field (Type 'c' -> 'o'): the rebound digest differs, verify rejects.
    expect(await sqlVerify(['CadreControl.Strand', 'add', 'strand-id-xyz', 'o', '', 'stamp-abc'], sig, pub)).toBe(false);
    // Swap the action tag: same row fields, different rule — verify rejects.
    expect(await sqlVerify(['CadreControl.Strand', 'remove', ...rowFields], sig, pub)).toBe(false);
  });

  it('(b) peer-record tagged multi-field: peerRecordSignedPayload ⇔ verify(digest(tags…,fields))', async () => {
    const peerId = '12D3KooWExamplePeer';
    const multiaddr = '/ip4/1.2.3.4/tcp/4001';
    const updatedAt = 1700000000000;
    const fields = ['CadreControl.CadrePeer', 'publish', peerId, multiaddr, String(updatedAt)];

    // The helper digests the tagged vector to a base64url string; sign over that (input
    // base64url -> raw digest bytes), matching what CadrePeer.AuthorizedUpdate's
    // self-branch checks.
    const payloadDigest = peerRecordSignedPayload(peerId, multiaddr, updatedAt);
    const sig = sign(payloadDigest, priv, 'ed25519', 'base64url', 'base64url', 'base64url') as string;

    expect(await sqlVerify(fields, sig, pub)).toBe(true);
    // Tamper the multiaddr field.
    expect(await sqlVerify(['CadreControl.CadrePeer', 'publish', peerId, '/ip4/9.9.9.9/tcp/4001', String(updatedAt)], sig, pub)).toBe(false);
  });

  it('(c) strand single-string: signStrandPayload ⇔ verify(digest(payload))', async () => {
    const payload = 'invite-key-xyz|member-key-abc';
    const sig = signStrandPayload(payload, priv);

    expect(await sqlVerify([payload], sig, pub)).toBe(true);
    // Tamper the member-key half of the joined payload.
    expect(await sqlVerify(['invite-key-xyz|member-key-different'], sig, pub)).toBe(false);
  });

  it('(d) leading literal tags: TS array elements ⇔ SQL literal arguments', async () => {
    // The schema writes the domain/action tags as SQL string LITERALS
    // (digest('CadreControl.OwnerKey', 'add', new.Key, new.StampId)), while every TS
    // signer passes them as the first two ARRAY ELEMENTS. This case pins that the two
    // spellings hash identical bytes — the parity the domain-separation scheme rests on.
    const key = 'owner-key-b64url';
    const stampId = 'stamp-xyz';
    const message = buildAuthorizationMessage('CadreControl.OwnerKey', 'add', [key, stampId]);
    const sig = sign(message, priv, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

    const row = await db.get(
      `select verify(digest('CadreControl.OwnerKey', 'add', ?, ?), ?, ?, 'ed25519') as ok`,
      [key, stampId, sig, pub],
    );
    expect(Boolean(row?.ok)).toBe(true);

    // The identical row fields under a DIFFERENT literal domain tag must not verify.
    const other = await db.get(
      `select verify(digest('CadreControl.ValidationKey', 'add', ?, ?), ?, ?, 'ed25519') as ok`,
      [key, stampId, sig, pub],
    );
    expect(Boolean(other?.ok)).toBe(false);
  });
});
