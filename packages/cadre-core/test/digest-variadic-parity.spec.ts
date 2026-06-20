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
 *   (a) a control MULTI-field message (`buildAuthorizationMessage`) ⇔ `digest(f1,…,fN)`
 *   (b) a peer-record SINGLE-string payload                          ⇔ `digest(joined)`
 *   (c) a strand SINGLE-string payload (`signStrandPayload`)          ⇔ `digest(payload)`
 *
 * In all three the SQL side is `verify(digest(<fields>), <sig>, <pubkey>, 'ed25519')`:
 * SQL `digest(...)` returns a base64url string that `verify`'s default base64url input
 * encoding decodes back to the raw digest bytes the TS side signed (over `'bytes'` for
 * (a)/(c), or the base64url digest string for (b) — same raw bytes either way).
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

  it('(a) control multi-field: buildAuthorizationMessage ⇔ verify(digest(f1,…,fN))', async () => {
    // Field order/shape mirrors a closed Strand: Id, Type, MemberPrivateKey (''), StampId.
    const fields = ['strand-id-xyz', 'c', '', 'stamp-abc'];
    const message = buildAuthorizationMessage(fields);
    // ed25519 signs the raw digest bytes directly (no second hash), exactly as the writers do.
    const sig = sign(message, priv, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

    expect(await sqlVerify(fields, sig, pub)).toBe(true);
    // Tamper one field (Type 'c' -> 'o'): the rebound digest differs, verify rejects.
    expect(await sqlVerify(['strand-id-xyz', 'o', '', 'stamp-abc'], sig, pub)).toBe(false);
  });

  it('(b) peer-record single-string: peerRecordSignedPayload ⇔ verify(digest(joined))', async () => {
    const peerId = '12D3KooWExamplePeer';
    const multiaddr = '/ip4/1.2.3.4/tcp/4001';
    const updatedAt = 1700000000000;
    const joined = `${peerId}|${multiaddr}|${updatedAt}`;

    // The helper digests `joined` to a base64url string; sign over that (input base64url
    // -> raw digest bytes), matching what the CadrePeer.AuthorizedUpdate self-branch checks.
    const payloadDigest = peerRecordSignedPayload(peerId, multiaddr, updatedAt);
    const sig = sign(payloadDigest, priv, 'ed25519', 'base64url', 'base64url', 'base64url') as string;

    expect(await sqlVerify([joined], sig, pub)).toBe(true);
    // Tamper the multiaddr inside the joined payload.
    expect(await sqlVerify([`${peerId}|/ip4/9.9.9.9/tcp/4001|${updatedAt}`], sig, pub)).toBe(false);
  });

  it('(c) strand single-string: signStrandPayload ⇔ verify(digest(payload))', async () => {
    const payload = 'invite-key-xyz|member-key-abc';
    const sig = signStrandPayload(payload, priv);

    expect(await sqlVerify([payload], sig, pub)).toBe(true);
    // Tamper the member-key half of the joined payload.
    expect(await sqlVerify(['invite-key-xyz|member-key-different'], sig, pub)).toBe(false);
  });
});
