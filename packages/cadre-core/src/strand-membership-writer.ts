import debug from 'debug';
import type { Database } from '@quereus/quereus';
import { digest, sign, verify, generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { SAppConfig } from './types.js';
import type { AuthorityKeyPair } from './authority-key.js';
import { canonicalDatetime } from './canonical-datetime.js';

const log = debug('sereus:cadre:strand-membership');

/**
 * The engine (rules-logic system) assumed to manage every strand. Persisted in
 * `Strand.Header.Engine`.
 *
 * PLACEHOLDER SEAM: there is no engine-selection mechanism yet — Quereus is the
 * only engine. When a real engine-config seam lands, the founder bootstrap should
 * read the strand's chosen engine from there instead of this constant. Documented
 * deliberately so the column is non-null and self-describing in the meantime.
 */
export const STRAND_ENGINE = 'quereus';

/**
 * The pinned engine version recorded in `Strand.Header.EngineVersion`. A pinned
 * string for the same reason as {@link STRAND_ENGINE}: it is a documented
 * placeholder until an engine-selection seam supplies the real running version.
 */
export const STRAND_ENGINE_VERSION = '0.1.0';

/**
 * The single-digest ed25519 signer the `Strand.*` membership/RBAC constraints
 * verify against.
 *
 * `schemas/strand.qsql` signs a single SHA-256 digest over a `'|'`-joined payload
 * (e.g. `Member.Authorized` verifies
 * `verify(digest(new.Key, 'sha256', 'utf8'), context.AuthoritySignature, A.MemberKey, 'ed25519')`).
 * So the signer hashes the payload to raw bytes and ed25519-signs *those bytes*:
 * `digest(...)`'s default output is base64url and `verify(...)`'s default
 * `inputEncoding` is base64url, so signer and verifier operate on identical bytes.
 * This differs from the control-layer's multi-field `buildAuthorizationMessage`
 * concatenation — the strand layer is a single digest over one joined payload.
 *
 * All strand keys are ed25519, so the explicit `'ed25519'` curve arg is mandatory
 * (the crypto plugin otherwise defaults to secp256k1). Mirrors the proven
 * `signItem` helper in the `rbac-signed-write` integration scenario.
 *
 * @param payload - The `'|'`-joined payload the matching constraint hashes.
 * @param privateKeyB64 - The signer's base64url ed25519 private seed.
 * @returns The base64url ed25519 signature over the payload's SHA-256 digest.
 */
export function signStrandPayload(payload: string, privateKeyB64: string): string {
  const hashBytes = digest(payload, 'sha256', 'utf8', 'bytes') as Uint8Array;
  return sign(hashBytes, privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}

/**
 * The verifier counterpart to {@link signStrandPayload}.
 *
 * Mirrors what every `Strand.*` constraint computes:
 * `verify(digest(payload, 'sha256', 'utf8'), signature, publicKey, 'ed25519')`.
 * `digest`'s default output and `verify`'s default `inputEncoding`/`sigEncoding`/
 * `keyEncoding` are all base64url, so the off-engine check operates on the exact
 * same bytes the in-engine CHECK does. Used by the off-engine `MemberVerifier`
 * (pre-flight registration checks) so the on-engine constraint is not the only
 * place a member self-proof is validated.
 *
 * @param payload - The `'|'`-joined payload the matching constraint hashes.
 * @param signatureB64 - The base64url ed25519 signature to check.
 * @param publicKeyB64 - The base64url ed25519 public key to verify against.
 * @returns `true` iff the signature is valid for the payload under that key.
 */
export function verifyStrandPayload(payload: string, signatureB64: string, publicKeyB64: string): boolean {
  const payloadDigest = digest(payload, 'sha256', 'utf8', 'base64url') as string;
  return verify(payloadDigest, signatureB64, publicKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url');
}

/** Parameters for {@link bootstrapFounderMembership}. */
export interface FounderBootstrapParams {
  /** The strand id — written to `Header.Id`. */
  strandId: string;
  /** Strand type: `'o'` (open, Header only) or `'c'` (closed, Header+Member+Authority). */
  type: 'o' | 'c';
  /** The sApp config whose id/version/schema/signature populate the Header. */
  sApp: SAppConfig;
  /**
   * The founder's derived strand keypair (from {@link strandMemberKeyPair}). Its
   * `publicKeyB64` becomes the founding `Member.Key` and `Authority.MemberKey`.
   * Required for a closed strand; ignored for an open strand.
   */
  founderKeyPair?: AuthorityKeyPair;
}

/**
 * Count rows in a `Strand.*` table as seen by this database instance.
 *
 * The table name is a fixed literal supplied by this module (never user input),
 * so the interpolation is not an injection surface — it just keeps the singleton
 * insert-if-absent guards terse.
 */
async function strandTableCount(db: Database, table: 'Header' | 'Member' | 'Authority'): Promise<number> {
  for await (const row of db.eval(`select count(1) as Count from Strand.${table}`)) {
    return (row.Count as number) ?? 0;
  }
  return 0;
}

/**
 * Insert the singleton `Strand.Header` if absent.
 *
 * Every `Header` column is NOT NULL (Quereus defaults unqualified columns to NOT
 * NULL; the table declares no `null` columns), so all eight are supplied non-null.
 * A missing `sApp.signature` (dev `requireSignedSchemas:false`) coalesces to `''`
 * rather than inserting null. `Header` carries only `InsertOnly` + a singleton PK,
 * so the insert needs no `with context`.
 */
async function insertHeaderIfAbsent(db: Database, params: FounderBootstrapParams): Promise<void> {
  if (await strandTableCount(db, 'Header') > 0) {
    log('Header already present for strand %s; skipping', params.strandId);
    return;
  }
  await db.exec(
    `insert into Strand.Header
       (Id, Type, sAppId, sAppVersion, sAppSchema, sAppSignature, Engine, EngineVersion)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.strandId,
      params.type,
      params.sApp.id,
      params.sApp.version,
      params.sApp.schema,
      params.sApp.signature ?? '',
      STRAND_ENGINE,
      STRAND_ENGINE_VERSION,
    ],
  );
  log('Inserted Header for strand %s (type %s)', params.strandId, params.type);
}

/**
 * Insert the founding `Strand.Member` if no member exists yet.
 *
 * The empty-table state satisfies the `count(1) from Member <= 1` bootstrap branch
 * of `Member.Authorized`, so no authority signature is needed — the context fields
 * are explicit nulls. Guarding on the count makes this idempotent: a re-run (the
 * founder re-`addStrand`/`resumeStrand`) finds the member present and skips.
 */
async function insertFounderMemberIfAbsent(db: Database, memberKey: string, strandId: string): Promise<void> {
  if (await strandTableCount(db, 'Member') > 0) {
    log('Member already present for strand %s; skipping founder Member', strandId);
    return;
  }
  await db.exec(
    `insert into Strand.Member (Key)
       with context AuthorityKey = null, AuthoritySignature = null
       values (?)`,
    [memberKey],
  );
  log('Inserted founding Member for strand %s', strandId);
}

/**
 * Insert the founding `Strand.Authority` if no authority exists yet.
 *
 * The empty-table state satisfies the `count(1) from Authority <= 1` bootstrap
 * branch of `Authority.Authorized`, so no signature is needed. Idempotent via the
 * same count guard. Must run AFTER the Header insert: `Authority.OnlyClosed` is a
 * deferred (subquery) check evaluated at commit, and the sequential auto-commit
 * Header→Member→Authority order ensures the closed `Header` is committed first.
 */
async function insertFounderAuthorityIfAbsent(db: Database, memberKey: string, strandId: string): Promise<void> {
  if (await strandTableCount(db, 'Authority') > 0) {
    log('Authority already present for strand %s; skipping founder Authority', strandId);
    return;
  }
  await db.exec(
    `insert into Strand.Authority (MemberKey)
       with context AuthorityKey = null, Signature = null
       values (?)`,
    [memberKey],
  );
  log('Inserted founding Authority for strand %s', strandId);
}

/**
 * Founder-only one-time bootstrap of a strand's `Strand.*` membership/RBAC rows.
 *
 * Runs once at bring-up on the strand's FOUNDER (the party that provisioned and
 * published the strand). A joiner never calls this — it receives these rows via
 * Optimystic sync. Every write is insert-if-absent (guarded by a row count) so a
 * restart / founder re-`addStrand` is a no-op and never double-inserts.
 *
 * Behavior by strand type:
 * - **Open (`'o'`)**: insert `Header` only. `Member`/`Authority`/`Invite` are
 *   `OnlyClosed` and would trip that constraint — they are skipped entirely.
 * - **Closed (`'c'`)**: insert `Header(Type='c')`, then the founding `Member`
 *   (`Key = founderKeyPair.publicKeyB64`), then the founding `Authority`
 *   (`MemberKey = founderKeyPair.publicKeyB64`). Insert order matters: the
 *   Header must commit before the deferred `OnlyClosed` checks on Member/Authority
 *   evaluate at commit.
 *
 * A closed strand with no `founderKeyPair` throws: a closed strand with no founding
 * Authority could never admit anyone, so failing loudly here (which propagates out
 * of `StrandDatabase.initialize()` and triggers the runtime's rollback) is correct.
 *
 * @param db - The strand's Quereus database (schema already applied).
 * @param params - Strand id/type, the sApp config for the Header, and (closed only)
 *   the derived founder keypair.
 * @throws If `type === 'c'` and no `founderKeyPair` is supplied.
 */
export async function bootstrapFounderMembership(db: Database, params: FounderBootstrapParams): Promise<void> {
  const { strandId, type, founderKeyPair } = params;
  log('Founder bootstrap for strand %s (type %s)', strandId, type);

  // Validate BEFORE writing anything: a closed strand with no founder key must
  // fail without leaving a closed `Header` that has no founding Member/Authority
  // (such a strand could never admit anyone).
  if (type === 'c' && !founderKeyPair) {
    throw new Error(
      `Cannot bootstrap closed strand ${strandId}: no founder key pair derived from MemberPrivateKey. ` +
      'A closed strand needs a founding Member + Authority or it can never admit members.',
    );
  }

  // Header is written for every strand; Member/Authority are closed-only.
  await insertHeaderIfAbsent(db, params);

  if (type === 'o') {
    // Open strand: Member/Authority/Invite are OnlyClosed — nothing else to write.
    return;
  }

  const memberKey = founderKeyPair!.publicKeyB64;
  await insertFounderMemberIfAbsent(db, memberKey, strandId);
  await insertFounderAuthorityIfAbsent(db, memberKey, strandId);
  log('Founder bootstrap complete for closed strand %s', strandId);
}

// ── Invite issuance + consumption (the per-strand join handshake) ─────────────

/** Parameters for {@link issueInvite}. */
export interface IssueInviteParams {
  /**
   * The issuing authority's strand keypair. Its `publicKeyB64` must already be a
   * `Strand.Authority` row (the `InviteValid` constraint rejects a non-authority).
   */
  authorityKeyPair: AuthorityKeyPair;
  /**
   * Optional invite expiry as epoch milliseconds. When set, it is canonicalised
   * via {@link canonicalDatetime} so the signed payload segment byte-matches the
   * `datetime`-coerced `Invite.Expiration` the deferred CHECK sees. When omitted,
   * the invite never expires and the signed segment is `''` (matching the schema's
   * `coalesce(new.Expiration, '')`).
   */
  expiration?: number;
}

/** The minted invite: a public key (the `Invite.Key`) plus its private seed. */
export interface IssuedInvite {
  /** The invite ed25519 PUBLIC key (base64url) — the `Invite.Key` primary key. */
  inviteKey: string;
  /**
   * The invite ed25519 PRIVATE seed (base64url). Handed out-of-band to the
   * invitee; whoever holds it can {@link consumeInvite} exactly once. NEVER
   * persisted in the strand — only the public key is.
   */
  invitePrivateKey: string;
}

/**
 * Issue a single-use invitation to join a closed strand.
 *
 * Generates a fresh invite ed25519 keypair (the public key becomes `Invite.Key`),
 * builds the constraint's payload (`Key || '|' || coalesce(Expiration, '')`), and
 * signs it TWICE: with the authority private key (→ `AuthoritySignature`, proving
 * an authority issued it) and with the invite private key (→ `InviteSignature`,
 * proving the issuer actually holds the invite secret). Both signatures plus the
 * authority public key are bound as constraint context for the `Invite` insert.
 *
 * The returned `invitePrivateKey` is the only secret the invitee needs to redeem
 * the invite — it is NOT stored in the strand (only `Invite.Key`, the public half,
 * is). Single-use is enforced at consumption time: `ConsumedInvite`'s primary key
 * is `InviteKey`, so a given invite can be consumed at most once.
 *
 * @param db - The closed strand's database (founder already bootstrapped).
 * @param params - The issuing authority keypair and optional expiry.
 * @returns The invite public key and the out-of-band private seed.
 */
export async function issueInvite(db: Database, params: IssueInviteParams): Promise<IssuedInvite> {
  const { authorityKeyPair, expiration } = params;

  const invitePrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  const inviteKey = getPublicKey(invitePrivateKey, 'ed25519', 'base64url', 'base64url') as string;

  // Canonicalise the expiry to the engine's stored `datetime` form so the signed
  // segment matches `new.Expiration` post-coercion; null expiry signs as ''.
  const expirationSegment = expiration == null ? '' : await canonicalDatetime(db, expiration);
  const expirationColumn = expiration == null ? null : expirationSegment;

  const payload = `${inviteKey}|${expirationSegment}`;
  const authoritySignature = signStrandPayload(payload, authorityKeyPair.privateKeyB64);
  const inviteSignature = signStrandPayload(payload, invitePrivateKey);

  await db.exec(
    `insert into Strand.Invite (Key, Expiration)
       with context AuthorityKey = ?, AuthoritySignature = ?, InviteSignature = ?
       values (?, ?)`,
    [authorityKeyPair.publicKeyB64, authoritySignature, inviteSignature, inviteKey, expirationColumn],
  );
  log('Issued invite %s (expires=%s)', inviteKey, expirationColumn ?? 'never');

  return { inviteKey, invitePrivateKey };
}

/** Parameters for {@link consumeInvite}. */
export interface ConsumeInviteParams {
  /** The `Invite.Key` (invite PUBLIC key, base64url) being redeemed. */
  inviteKey: string;
  /** The matching invite PRIVATE seed (base64url) received out-of-band. */
  invitePrivateKey: string;
  /** The joining member's ed25519 PUBLIC key (base64url) — the new `Member.Key`. */
  memberKey: string;
}

/**
 * Redeem an invite to admit a new `Member`, atomically.
 *
 * `Member.Authorized`'s invite branch needs a `ConsumedInvite` row, while
 * `ConsumedInvite`'s `MemberExists`/`MemberValid` need the `Member` row — a
 * circular dependency. Both are deferred (subquery-bearing) checks that evaluate
 * at COMMIT, so inserting `Member` then `ConsumedInvite` inside one explicit
 * transaction lets both rows exist when the deferred checks fire. This mirrors
 * `ControlDatabase.redeemInvitation` (Strand + FormationUsage in one txn).
 *
 * The `ConsumedInvite` insert carries an `InviteSignature` over
 * `InviteKey || '|' || MemberKey`, proving the consumer holds the invite private
 * key (the on-engine `ValidUsage` gate). The `Member` insert needs no member
 * signature — its admission is the existence of the matching `ConsumedInvite`.
 *
 * Single-use: `ConsumedInvite`'s primary key is `InviteKey`, so a second consume
 * of the same invite is rejected by the PK (a distinct layer from the control
 * network's `FormationUsage` single-use, which gates strand FORMATION, not the
 * per-strand member join enforced here).
 *
 * @param db - The closed strand's database.
 * @param params - The invite key/secret and the joining member's public key.
 * @throws If any constraint rejects; the whole transaction rolls back (neither
 *   the `Member` nor the `ConsumedInvite` row survives).
 */
export async function consumeInvite(db: Database, params: ConsumeInviteParams): Promise<void> {
  const { inviteKey, invitePrivateKey, memberKey } = params;

  const usagePayload = `${inviteKey}|${memberKey}`;
  const inviteSignature = signStrandPayload(usagePayload, invitePrivateKey);

  await db.beginTransaction();
  try {
    // 1. Member — admitted by the deferred invite branch (the matching
    //    ConsumedInvite below), so no authority signature is supplied.
    await db.exec(
      `insert into Strand.Member (Key)
         with context AuthorityKey = null, AuthoritySignature = null
         values (?)`,
      [memberKey],
    );

    // 2. ConsumedInvite — proves possession of the invite private key.
    await db.exec(
      `insert into Strand.ConsumedInvite (InviteKey, MemberKey)
         with context InviteSignature = ?
         values (?, ?)`,
      [inviteSignature, inviteKey, memberKey],
    );

    await db.commit();
    log('Consumed invite %s -> member %s', inviteKey, memberKey);
  } catch (error) {
    // A failed commit() already tears down the transaction, so rollback() would
    // throw "No transaction active" and mask the real cause — swallow only that.
    try {
      await db.rollback();
    } catch (rollbackError) {
      log('Rollback after consumeInvite failure was a no-op: %s', rollbackError);
    }
    throw error;
  }
}

/** Parameters for {@link addMemberByAuthority}. */
export interface AddMemberByAuthorityParams {
  /**
   * The admitting authority's strand keypair. Its `publicKeyB64` must be a
   * `Strand.Authority` row; it signs the new member key directly.
   */
  authorityKeyPair: AuthorityKeyPair;
  /** The joining member's ed25519 PUBLIC key (base64url) — the new `Member.Key`. */
  memberKey: string;
}

/**
 * Admit a `Member` directly by authority signature — the sibling of the invite
 * path on `Member.Authorized`'s direct-authority branch.
 *
 * The constraint verifies `digest(new.Key)` against an `Authority` row matching
 * `context.AuthorityKey`, so the payload is just the member key (no `'|'` join).
 * No `ConsumedInvite` is involved: this is the path an authority uses to seat a
 * member it already trusts (e.g. an authority-side enrollment that admits a
 * party already authorised out-of-band).
 *
 * @param db - The closed strand's database.
 * @param params - The admitting authority keypair and the new member key.
 * @throws If `Member.Authorized` rejects (e.g. a non-authority key); the insert
 *   rolls back, leaving no `Member` row.
 */
export async function addMemberByAuthority(db: Database, params: AddMemberByAuthorityParams): Promise<void> {
  const { authorityKeyPair, memberKey } = params;
  const signature = signStrandPayload(memberKey, authorityKeyPair.privateKeyB64);
  await db.exec(
    `insert into Strand.Member (Key)
       with context AuthorityKey = ?, AuthoritySignature = ?
       values (?)`,
    [authorityKeyPair.publicKeyB64, signature, memberKey],
  );
  log('Admitted member %s by authority %s', memberKey, authorityKeyPair.publicKeyB64);
}
