import debug from 'debug';
import { toString as uint8ArrayToString } from 'uint8arrays';
import type { Database } from '@quereus/quereus';
import { digest, sign, verify, generatePrivateKey, getPublicKey, randomBytes } from '@optimystic/quereus-plugin-crypto';
import type { SAppConfig } from './types.js';
import type { Ed25519KeyPair } from './ed25519-key.js';
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
 * The single-payload ed25519 signer the `Strand.Invite`/`Strand.ConsumedInvite`
 * handshake constraints verify against.
 *
 * Those constraints sign a single SHA-256 digest over a `'|'`-joined payload
 * (e.g. `InviteValid` verifies
 * `verify(digest(new.Key || '|' || coalesce(new.Expiration, '')), ...)`).
 * So the signer hashes the payload to raw bytes and ed25519-signs *those bytes*:
 * SQL `digest(...)`'s default output is base64url and `verify(...)`'s default
 * `inputEncoding` is base64url, so signer and verifier operate on identical bytes.
 * The membership/RBAC tables (Member/Manager/MemberPeer/Revocation) instead use
 * domain/action-tagged VARIADIC digests — see {@link signStrandApproval}.
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
  const hashBytes = digest([payload], 'sha256', 'bytes') as Uint8Array;
  return sign(hashBytes, privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}

/**
 * The verifier counterpart to {@link signStrandPayload}.
 *
 * Mirrors what the single-payload `Strand.*` constraints compute:
 * `verify(digest(payload), signature, publicKey, 'ed25519')`.
 * SQL `digest`'s default output and `verify`'s default `inputEncoding`/`sigEncoding`/
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
  const payloadDigest = digest([payload], 'sha256', 'base64url') as string;
  return verify(payloadDigest, signatureB64, publicKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url');
}

/**
 * Sign a domain/action-tagged `Strand.*` membership/RBAC approval.
 *
 * Every `Authorized` branch on `Member`/`Manager`/`MemberPeer`/`Revocation`
 * verifies a VARIADIC digest — `digest('<domain>', '<action>', <field>, ...,
 * <StampId>)` — whose leading two elements are fixed literals (the domain tag,
 * e.g. `'Strand.Member'`, and an action tag, e.g. `'add'`) and whose trailing
 * element is the row's per-incarnation StampId. The tags keep an approval from
 * verifying against any rule but the one it was minted for (the idiom of the
 * control layer's `buildAuthorizationMessage`); the StampId binding makes it
 * single-use — it authorizes exactly one incarnation of one row, and dies when
 * that row's stamp is retired into `Strand.Revocation`.
 *
 * The caller passes the digest elements exactly as the matching SQL constraint
 * lists them (each SQL argument = one array element), PRESERVING TYPE: the
 * crypto plugin's digest framing is type-tagged (INTEGER 1 and TEXT '1' encode
 * differently, deliberately), so `Manager.Authorized`'s promotion branch —
 * whose digest includes the INTEGER `new.Generation` — must be signed over the
 * NUMBER, not its string form. Integer `number` and `bigint` encode
 * identically in that framing, so JS-side numbers match however the engine
 * represents the SQL integer.
 *
 * Like {@link signStrandPayload}, the raw digest BYTES are ed25519-signed
 * directly, matching SQL `verify(...)`'s default base64url input decoding.
 *
 * @param fields - The digest elements, in constraint order (tags first, StampId last).
 * @param privateKeyB64 - The signer's base64url ed25519 private seed.
 * @returns The base64url ed25519 signature over the tagged digest.
 */
export function signStrandApproval(fields: ReadonlyArray<string | number>, privateKeyB64: string): string {
  const hashBytes = digest(fields, 'sha256', 'bytes') as Uint8Array;
  return sign(hashBytes, privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}

/**
 * Mint a fresh per-row authorization nonce (StampId) for a `Strand.Member`,
 * `Strand.Manager`, or `Strand.MemberPeer` row.
 *
 * 256 bits of CSPRNG output, base64url-encoded — enough entropy that a future
 * legitimate stamp cannot be guessed and pre-planted into `Strand.Revocation`
 * (the `RowIsGone` comment in `schemas/strand.qsql` leans on exactly this).
 * Plain randomness, deliberately NOT the control layer's peer-derived
 * `generateStampId`: strand rows are not per-peer, so entropy alone carries
 * the uniqueness.
 *
 * @returns A fresh base64url stamp (43 chars for 32 bytes).
 */
export function generateStrandStampId(): string {
  // randomBytes' first arg is BITS, not bytes — 256 bits = 32 bytes.
  const bytes = randomBytes(256, 'bytes') as Uint8Array;
  return uint8ArrayToString(bytes, 'base64url');
}

/**
 * Run `fn` inside one explicit strand transaction: begin, fn, commit — with the
 * standard rollback-on-failure shape.
 *
 * Used wherever two `Strand.*` writes must land atomically: the invite-consume
 * pair (Member + ConsumedInvite) and every delete-plus-tombstone pair (the
 * `RevocationRecorded` constraints require the `Revocation` row in the SAME
 * transaction as the delete it retires).
 *
 * JOINS a caller-owned transaction instead of opening its own: Quereus's
 * `Database.beginTransaction()` hard-throws "Transaction already active" on any
 * nesting, and a caller composing several writers in one transaction (e.g. a
 * resign + revoke pair that must land atomically) is exactly the case where the
 * deferred constraints should fire once, at the CALLER's commit. In joined mode
 * commit/rollback belong to the caller, so failures simply propagate.
 */
async function inStrandTransaction(db: Database, fn: () => Promise<void>): Promise<void> {
  if (!db.getAutocommit()) {
    await fn();
    return;
  }
  await db.beginTransaction();
  try {
    await fn();
    await db.commit();
  } catch (error) {
    // A failed commit() already tears down the transaction, so rollback() would
    // throw "No transaction active" and mask the real cause — swallow only that.
    try {
      await db.rollback();
    } catch (rollbackError) {
      log('Rollback after strand transaction failure was a no-op: %s', rollbackError);
    }
    throw error;
  }
}

/**
 * File the `Strand.Revocation` tombstone that retires a deleted row's StampId.
 *
 * Runs inside the SAME transaction as the delete it accompanies — the guarded
 * tables' `RevocationRecorded` (deferred) requires the tombstone at commit, and
 * `Revocation.RowIsGone` (also deferred) requires the row to already be gone, so
 * the pair only ever lands together.
 *
 * `Revocation.Authorized` verifies the retire-tagged digest against a
 * PRE-transaction (`committed.Member`) row, so the retiree must have been a
 * member BEFORE this transaction. Every writer flow satisfies this: managers are
 * members, and a self-departing member is committed until this very transaction
 * removes it. Unlike the sibling tables' nullable contexts, `Revocation`'s
 * context is non-null — both fields are always supplied.
 *
 * @param db - The strand database, INSIDE an open transaction.
 * @param tableName - Which guarded table the stamp belonged to.
 * @param stampId - The retired stamp.
 * @param retiree - The committed member filing the tombstone (the delete's own signer).
 */
async function insertRevocation(
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

/** Parameters for {@link bootstrapFounderMembership}. */
export interface FounderBootstrapParams {
  /** The strand id — written to `Header.Id`. */
  strandId: string;
  /** Strand type: `'o'` (open, Header only) or `'c'` (closed, Header+Member+Manager). */
  type: 'o' | 'c';
  /** The sApp config whose id/version/schema/signature populate the Header. */
  sApp: SAppConfig;
  /**
   * The founder's derived strand keypair (from {@link strandMemberKeyPair}). Its
   * `publicKeyB64` becomes the founding `Member.Key` and `Manager.MemberKey`.
   * Required for a closed strand; ignored for an open strand.
   */
  founderKeyPair?: Ed25519KeyPair;
}

/**
 * Count rows in a `Strand.*` table as seen by this database instance.
 *
 * The table name is a fixed literal supplied by this module (never user input),
 * so the interpolation is not an injection surface — it just keeps the singleton
 * insert-if-absent guards terse.
 */
async function strandTableCount(db: Database, table: 'Header' | 'Member' | 'Manager'): Promise<number> {
  for await (const row of db.eval(`select count(1) as Count from Strand.${table}`)) {
    return (row.Count as number) ?? 0;
  }
  return 0;
}

/**
 * Whether any `Strand.Revocation` row has ever retired a `Manager` seat — the
 * exact condition that permanently closes the founding branch of
 * `Manager.Authorized` (see the schema's bootstrap-branch comment). Unfiltered
 * scan + JavaScript comparison, the module's scan-not-seek idiom (rationale on
 * {@link scanMemberPeers}).
 *
 * NOTE: walks the whole append-only `Strand.Revocation` table when no `Manager`
 * tombstone is present (it returns on the first one it finds). Cheap at strand
 * scale; if membership churn ever makes that table large — the growth the
 * `Revocation` schema comment already flags, tracked by `debt-strand-tombstone-reap`
 * — this wants a stored "founding closed" marker rather than a scan per call.
 */
async function strandHasManagerRevocation(db: Database): Promise<boolean> {
  for await (const row of db.eval('select TableName from Strand.Revocation')) {
    if (row.TableName === 'Manager') {
      return true;
    }
  }
  return false;
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
 * The empty PRE-transaction member set (`count(1) from committed.Member = 0`)
 * satisfies the bootstrap branch of `Member.Authorized`, so no signature is
 * needed — the context fields are explicit nulls. The branch also caps the
 * POST-image at one member, so it waives authorization for exactly this single
 * seat, never for a batch. The row still mints a fresh StampId — the column is
 * NOT NULL on every path; bootstrap only waives the SIGNATURE. Guarding on the
 * count makes this idempotent: a re-run (the founder re-`addStrand`/
 * `resumeStrand`) finds the member present and skips.
 */
async function insertFounderMemberIfAbsent(db: Database, memberKey: string, strandId: string): Promise<void> {
  if (await strandTableCount(db, 'Member') > 0) {
    log('Member already present for strand %s; skipping founder Member', strandId);
    return;
  }
  await db.exec(
    `insert into Strand.Member (Key, StampId)
       with context ManagerKey = null, ManagerSignature = null, MemberSignature = null
       values (?, ?)`,
    [memberKey, generateStrandStampId()],
  );
  log('Inserted founding Member for strand %s', strandId);
}

/**
 * Insert the founding `Strand.Manager` if no manager exists yet.
 *
 * The empty-table state satisfies the bootstrap branch of `Manager.Authorized`, so
 * no signature is needed (a fresh StampId is still minted — the column is NOT
 * NULL). The founder is seated at `Generation = 0` — the root of
 * the manager lineage; the bootstrap branch requires exactly that value, and every
 * later manager is seated at a strictly greater generation (see {@link addManager}).
 * Idempotent via the same count guard.
 *
 * ORDERING IS LOAD-BEARING, not merely convenient. The bootstrap branch is gated to
 * the founding state and now reads `exists (select 1 from Member M where M.Key =
 * new.MemberKey)` alongside `count(Manager) <= 1` and `count(Member) <= 1`, so the
 * founding `Member` row MUST already exist when this commits — a Manager-first
 * seeding path is rejected. It must also run AFTER the Header insert:
 * `Manager.OnlyClosed` is a deferred (subquery) check evaluated at commit. The
 * sequential auto-commit Header→Member→Manager order in
 * {@link bootstrapFounderMembership} satisfies both.
 *
 * SEALED strands are skipped, not re-founded: a strand whose sole manager has
 * {@link sealStrand}ed also has zero `Manager` rows, but its founding branch is
 * closed for good (the schema's bootstrap branch requires no `Manager`-table
 * `Revocation` row to exist). Attempting the founding insert here would be
 * schema-rejected and turn every founder restart of a sealed strand into a
 * loud failure — so this mirrors the schema's own gate and returns quietly.
 * A crash BETWEEN the founding Member and Manager inserts leaves no Revocation
 * rows at all, so that restart still completes the founding.
 */
async function insertFounderManagerIfAbsent(db: Database, memberKey: string, strandId: string): Promise<void> {
  if (await strandTableCount(db, 'Manager') > 0) {
    log('Manager already present for strand %s; skipping founder Manager', strandId);
    return;
  }
  if (await strandHasManagerRevocation(db)) {
    log('Strand %s has retired a manager seat (sealed); skipping founder Manager', strandId);
    return;
  }
  await db.exec(
    `insert into Strand.Manager (MemberKey, Generation, StampId)
       with context ManagerKey = null, Signature = null
       values (?, 0, ?)`,
    [memberKey, generateStrandStampId()],
  );
  log('Inserted founding Manager for strand %s', strandId);
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
 * - **Open (`'o'`)**: insert `Header` only. `Member`/`Manager`/`Invite` are
 *   `OnlyClosed` and would trip that constraint — they are skipped entirely.
 * - **Closed (`'c'`)**: insert `Header(Type='c')`, then the founding `Member`
 *   (`Key = founderKeyPair.publicKeyB64`), then the founding `Manager`
 *   (`MemberKey = founderKeyPair.publicKeyB64`). Insert order matters: the
 *   Header must commit before the deferred `OnlyClosed` checks on Member/Manager
 *   evaluate at commit.
 *
 * A closed strand with no `founderKeyPair` throws: a closed strand with no founding
 * Manager could never admit anyone, so failing loudly here (which propagates out
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
  // fail without leaving a closed `Header` that has no founding Member/Manager
  // (such a strand could never admit anyone).
  if (type === 'c' && !founderKeyPair) {
    throw new Error(
      `Cannot bootstrap closed strand ${strandId}: no founder key pair derived from MemberPrivateKey. ` +
      'A closed strand needs a founding Member + Manager or it can never admit members.',
    );
  }

  // Header is written for every strand; Member/Manager are closed-only.
  await insertHeaderIfAbsent(db, params);

  if (type === 'o') {
    // Open strand: Member/Manager/Invite are OnlyClosed — nothing else to write.
    return;
  }

  const memberKey = founderKeyPair!.publicKeyB64;
  await insertFounderMemberIfAbsent(db, memberKey, strandId);
  await insertFounderManagerIfAbsent(db, memberKey, strandId);
  log('Founder bootstrap complete for closed strand %s', strandId);
}

// ── Invite issuance + consumption (the per-strand join handshake) ─────────────

/** Parameters for {@link issueInvite}. */
export interface IssueInviteParams {
  /**
   * The issuing manager's strand keypair. Its `publicKeyB64` must already be a
   * `Strand.Manager` row (the `InviteValid` constraint rejects a non-manager).
   */
  managerKeyPair: Ed25519KeyPair;
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
 * signs it TWICE: with the manager private key (→ `ManagerSignature`, proving
 * a manager issued it) and with the invite private key (→ `InviteSignature`,
 * proving the issuer actually holds the invite secret). Both signatures plus the
 * manager public key are bound as constraint context for the `Invite` insert.
 *
 * The returned `invitePrivateKey` is the only secret the invitee needs to redeem
 * the invite — it is NOT stored in the strand (only `Invite.Key`, the public half,
 * is). Single-use is enforced at consumption time: `ConsumedInvite`'s primary key
 * is `InviteKey`, so a given invite can be consumed at most once.
 *
 * @param db - The closed strand's database (founder already bootstrapped).
 * @param params - The issuing manager keypair and optional expiry.
 * @returns The invite public key and the out-of-band private seed.
 */
export async function issueInvite(db: Database, params: IssueInviteParams): Promise<IssuedInvite> {
  const { managerKeyPair, expiration } = params;

  const invitePrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  const inviteKey = getPublicKey(invitePrivateKey, 'ed25519', 'base64url', 'base64url') as string;

  // Canonicalise the expiry to the engine's stored `datetime` form so the signed
  // segment matches `new.Expiration` post-coercion; null expiry signs as ''.
  const expirationSegment = expiration == null ? '' : await canonicalDatetime(db, expiration);
  const expirationColumn = expiration == null ? null : expirationSegment;

  const payload = `${inviteKey}|${expirationSegment}`;
  const managerSignature = signStrandPayload(payload, managerKeyPair.privateKeyB64);
  const inviteSignature = signStrandPayload(payload, invitePrivateKey);

  await db.exec(
    `insert into Strand.Invite (Key, Expiration)
       with context ManagerKey = ?, ManagerSignature = ?, InviteSignature = ?
       values (?, ?)`,
    [managerKeyPair.publicKeyB64, managerSignature, inviteSignature, inviteKey, expirationColumn],
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
  /**
   * The instant (epoch ms) to compare against the invite's `Expiration` for the
   * `NotExpired` gate. Defaults to `Date.now()`; tests pin it so the comparison is
   * deterministic. Mirrors the control-layer `redeemInvitation`'s `nowMs` convention.
   */
  nowMs?: number;
}

/**
 * Redeem an invite to admit a new `Member`, atomically.
 *
 * `Member.Authorized`'s invite branch needs a `ConsumedInvite` row, while
 * `ConsumedInvite`'s `MemberExists` needs the `Member` row — a circular
 * dependency. Both are deferred (subquery-bearing) checks that evaluate
 * at COMMIT, so inserting `Member` then `ConsumedInvite` inside one explicit
 * transaction lets both rows exist when the deferred checks fire. This mirrors
 * `ControlDatabase.redeemInvitation` (Strand + FormationUsage in one txn).
 *
 * The `ConsumedInvite` insert carries an `InviteSignature` over
 * `InviteKey || '|' || MemberKey`, proving the consumer holds the invite private
 * key (the on-engine `ValidUsage` gate). The `Member` insert needs no member
 * signature — its admission is the existence of the matching `ConsumedInvite` —
 * but still mints a fresh StampId (NOT NULL on every path; a revoked-then-
 * re-invited member is a fresh incarnation under a fresh stamp).
 *
 * Single-use: `ConsumedInvite`'s primary key is `InviteKey`, so a second consume
 * of the same invite is rejected by the PK (a distinct layer from the control
 * network's `FormationUsage` single-use, which gates strand FORMATION, not the
 * per-strand member join enforced here).
 *
 * Expiry: the `ConsumedInvite.NotExpired` deferred check rejects redeeming an invite
 * whose `Expiration` is at or before `context.Now`. `Now` is supplied here as a
 * canonical-datetime string from `canonicalDatetime(db, nowMs)` — the SAME transform
 * `issueInvite` uses to store `Invite.Expiration` — so both sides of the schema's
 * `I.Expiration > context.Now` comparison are byte-identical canonical strings and
 * the lexical `>` orders chronologically at any granularity. (This intentionally
 * diverges from the control layer, which passes `Now` as a JS ISO string; Quereus
 * does not coerce context params, so an ISO `Now` would be compared lexically against
 * the canonical, T-separated `Expiration` and could mis-order near-same-instant
 * timestamps (due to a trailing `.000Z` suffix). The control tests only use far-future/far-past expiries, so that latent
 * skew never bites there — the strand layer avoids it outright.) A null `Expiration`
 * never expires. Like `ValidUsage`, `NotExpired` defers to commit, so an expired
 * invite rolls back the whole txn — neither the `Member` nor the `ConsumedInvite`
 * row survives.
 *
 * @param db - The closed strand's database.
 * @param params - The invite key/secret, the joining member's public key, and an
 *   optional `nowMs` instant for the expiry comparison (default `Date.now()`).
 * @throws If any constraint rejects (bad signature, missing invite, or an expired
 *   invite); the whole transaction rolls back (neither the `Member` nor the
 *   `ConsumedInvite` row survives).
 */
export async function consumeInvite(db: Database, params: ConsumeInviteParams): Promise<void> {
  const { inviteKey, invitePrivateKey, memberKey, nowMs } = params;

  const usagePayload = `${inviteKey}|${memberKey}`;
  const inviteSignature = signStrandPayload(usagePayload, invitePrivateKey);

  // Canonicalise "now" the same way issueInvite canonicalises Expiration, so the
  // schema's `I.Expiration > context.Now` compares like-for-like canonical strings.
  // Plain runtime Date.now() — the tess Workflow restriction is on scripts, not libs.
  const nowCanonical = await canonicalDatetime(db, nowMs ?? Date.now());

  await inStrandTransaction(db, async () => {
    // 1. Member — admitted by the deferred invite branch (the matching
    //    ConsumedInvite below), so no manager signature is supplied.
    await db.exec(
      `insert into Strand.Member (Key, StampId)
         with context ManagerKey = null, ManagerSignature = null, MemberSignature = null
         values (?, ?)`,
      [memberKey, generateStrandStampId()],
    );

    // 2. ConsumedInvite — proves possession of the invite private key and that the
    //    invite has not expired (NotExpired gate against the canonical Now).
    await db.exec(
      `insert into Strand.ConsumedInvite (InviteKey, MemberKey)
         with context InviteSignature = ?, Now = ?
         values (?, ?)`,
      [inviteSignature, nowCanonical, inviteKey, memberKey],
    );
  });
  log('Consumed invite %s -> member %s', inviteKey, memberKey);
}

/**
 * Every value of `InviteKey` in one of the two invite-marker tables, as a `Set`.
 *
 * Unfiltered scan + JavaScript comparison, deliberately: `ConsumedInvite` and
 * `CancelledInvite` each have the single column `InviteKey` as their primary key, so
 * ANY where-equality on it is a FULL-PK predicate — which the optimystic virtual-table
 * module serves via a single-key point lookup that can MISS on a networked strand (the
 * argument {@link scanMemberPeers} makes in full). Reading the whole column and
 * comparing in JS depends only on the scan returning a SUPERSET of the live rows.
 *
 * The table name is a fixed literal supplied by this module (never user input), so the
 * interpolation is not an injection surface — same as {@link strandTableCount}.
 *
 * NOTE: every caller pays a WHOLE-column read — {@link cancelInvite}'s idempotence guard
 * reads all cancelled keys to answer one membership question, and
 * {@link listOutstandingInvites} reads both marker tables per call. Fine at strand scale
 * (a handful of invitations); if invite churn ever gets large this wants a real filtered
 * read, which in turn needs the networked point-lookup gap closed
 * (`debt-composite-pk-point-lookup-unreliable-untracked`).
 */
async function scanInviteKeys(db: Database, table: 'ConsumedInvite' | 'CancelledInvite'): Promise<Set<string>> {
  const keys = new Set<string>();
  for await (const row of db.eval(`select InviteKey from Strand.${table}`)) {
    keys.add(row.InviteKey as string);
  }
  return keys;
}

/** Parameters for {@link cancelInvite}. */
export interface CancelInviteParams {
  /**
   * The cancelling manager's strand keypair. Its `publicKeyB64` must be a
   * PRE-EXISTING `Strand.Manager` row — `CancelledInvite.Authorized` reads
   * `committed.Manager`, so a manager seated in the SAME transaction cannot cancel.
   */
  managerKeyPair: Ed25519KeyPair;
  /** The `Invite.Key` to kill. */
  inviteKey: string;
}

/**
 * Cancel an outstanding invitation, permanently: it may never be consumed.
 *
 * Files a `Strand.CancelledInvite` tombstone carrying a manager signature over
 * `digest('Strand.CancelledInvite', 'cancel', InviteKey)`. The digest binds the exact
 * invite key, so an approval minted for one invitation cannot cancel another.
 *
 * One row, one statement — no transaction needed. `CancelledInvite.Authorized` is a
 * deferred (subquery-bearing) check, so it fires at this statement's own auto-commit.
 *
 * Insert-if-absent, matching {@link registerMemberPeer}'s and {@link revokeMember}'s
 * restart-safe shape: a repeat cancellation logs and returns rather than throwing on the
 * primary key. (Check-then-write is not atomic; the primary key is the real backstop —
 * the guard is for the sequential repeat/restart path.)
 *
 * Cancellation is what makes removal a re-entry gate: it is the `ConsumedInvite` insert
 * that `NotCancelled` blocks, and `Member.Authorized`'s invite branch needs a
 * same-transaction FRESH `ConsumedInvite` row, so a cancelled invitation rolls the whole
 * join back. Un-cancelling is impossible (`CancelledInvite.Immutable`) — to re-invite a
 * party, {@link issueInvite} a fresh invitation.
 *
 * Enumerate what there is to cancel with {@link listOutstandingInvites}: an invitation
 * names no invitee, so the strand cannot tell a manager WHICH invitations a departing
 * member holds. Invitee binding is tracked as `feat-strand-invitee-bound-invites`.
 *
 * @param db - The closed strand's database.
 * @param params - The cancelling manager's keypair and the invite key to kill.
 * @throws If `CancelledInvite.Authorized` rejects (a non-manager, a manager seated in
 *   this transaction, or an approval minted for a different invite key) or `OnlyClosed`
 *   rejects (an open strand); the insert rolls back, leaving no tombstone.
 */
export async function cancelInvite(db: Database, params: CancelInviteParams): Promise<void> {
  const { managerKeyPair, inviteKey } = params;

  if ((await scanInviteKeys(db, 'CancelledInvite')).has(inviteKey)) {
    log('Invite %s already cancelled; skipping', inviteKey);
    return;
  }

  const signature = signStrandApproval(
    ['Strand.CancelledInvite', 'cancel', inviteKey],
    managerKeyPair.privateKeyB64,
  );
  await db.exec(
    `insert into Strand.CancelledInvite (InviteKey)
       with context ManagerKey = ?, ManagerSignature = ?
       values (?)`,
    [managerKeyPair.publicKeyB64, signature, inviteKey],
  );
  log('Cancelled invite %s by manager %s', inviteKey, managerKeyPair.publicKeyB64);
}

/** One redeemable invitation, as reported by {@link listOutstandingInvites}. */
export interface OutstandingInvite {
  /** The `Invite.Key` (invite public key, base64url). */
  inviteKey: string;
  /**
   * The expiry as the engine's canonical `datetime` string
   * (`YYYY-MM-DDTHH:MM:SS[.frac]`, no zone suffix — see {@link canonicalDatetime}), or
   * `null` for never-expires.
   *
   * Deliberately the STORED form, not the epoch-ms {@link IssueInviteParams.expiration}
   * takes: it is what compares like-for-like against another canonicalised instant, and
   * what the on-engine `NotExpired` gate sees. It is NOT a JS-parseable ISO instant —
   * pass it through the engine (or `canonicalDatetime`) rather than `Date.parse`.
   */
  expiration: string | null;
}

/**
 * The invitations that are still redeemable: neither consumed, nor cancelled, nor
 * expired at `nowMs`.
 *
 * `Strand.Invite` is insert-only and carries no state column, so "outstanding" is not a
 * property of the row — it is the `Invite` set minus the `ConsumedInvite` keys, minus
 * the `CancelledInvite` keys, minus anything whose `Expiration` has passed. All three
 * exclusions mirror gates a consume would hit anyway (`ConsumedInvite`'s primary key,
 * `NotCancelled`, `NotExpired`).
 *
 * Reads via unfiltered scans and compares in JavaScript — see {@link scanInviteKeys} for
 * why a full-PK where-equality is not reliable on a networked strand.
 *
 * Expiry is compared as `expiration > canonicalDatetime(nowMs)`: the same transform
 * {@link issueInvite} uses to STORE `Invite.Expiration`, so the string comparison orders
 * chronologically, and the same strict `>` the on-engine `NotExpired` gate uses (expiry
 * is exclusive — an invitation is dead at its expiry instant, not after it).
 *
 * This is the manager's enumeration side of {@link cancelInvite}, and the "door is open"
 * pre-flight behind `StrandMemberVerifier.isAuthorizedToJoin`.
 *
 * @param db - The closed strand's database.
 * @param nowMs - The instant (epoch ms) to compare expiries against; defaults to
 *   `Date.now()`. Tests pin it so the comparison is deterministic, mirroring
 *   {@link consumeInvite}'s `nowMs` convention.
 * @returns The redeemable invitations, in NO guaranteed order (the scans promise only a
 *   superset of the live rows, not a stable sequence — sort by `expiration` if order
 *   matters); empty if none.
 */
export async function listOutstandingInvites(db: Database, nowMs?: number): Promise<OutstandingInvite[]> {
  // Plain runtime Date.now() — the tess Workflow restriction is on scripts, not libs.
  const nowCanonical = await canonicalDatetime(db, nowMs ?? Date.now());
  const consumed = await scanInviteKeys(db, 'ConsumedInvite');
  const cancelled = await scanInviteKeys(db, 'CancelledInvite');

  const outstanding: OutstandingInvite[] = [];
  for await (const row of db.eval('select Key, Expiration from Strand.Invite')) {
    const inviteKey = row.Key as string;
    const expiration = (row.Expiration as string | null) ?? null;
    if (consumed.has(inviteKey) || cancelled.has(inviteKey)) {
      continue;
    }
    if (expiration != null && expiration <= nowCanonical) {
      continue;
    }
    outstanding.push({ inviteKey, expiration });
  }
  return outstanding;
}

// ── Member admission + removal (manager-admit, revoke, leave) ─────────────────

/**
 * The live StampId of the `Strand.Member` row keyed by `memberKey`, or
 * `undefined` if no such row is visible.
 *
 * `Member`'s primary key is the single `Key` column, so ANY where-equality on it
 * is a full-PK predicate — which the optimystic virtual-table module serves via a
 * single-key point lookup that can MISS on a networked strand (the same failure
 * mode {@link scanMemberPeers} documents). So this reads via an UNFILTERED scan
 * and compares the key in JavaScript: correctness depends only on the scan
 * returning a superset of the live rows — the weakest possible assumption about
 * the storage layer.
 */
async function memberStampId(db: Database, memberKey: string): Promise<string | undefined> {
  for await (const row of db.eval('select Key, StampId from Strand.Member')) {
    if (row.Key === memberKey) {
      return row.StampId as string;
    }
  }
  return undefined;
}

/** Parameters for {@link addMemberByManager}. */
export interface AddMemberByManagerParams {
  /**
   * The admitting manager's strand keypair. Its `publicKeyB64` must be a
   * `Strand.Manager` row; it signs the add-tagged digest over the new member key
   * and its fresh stamp.
   */
  managerKeyPair: Ed25519KeyPair;
  /** The joining member's ed25519 PUBLIC key (base64url) — the new `Member.Key`. */
  memberKey: string;
}

/**
 * Admit a `Member` directly by manager signature — the sibling of the invite
 * path on `Member.Authorized`'s direct-manager branch.
 *
 * The constraint verifies the add-tagged digest
 * `digest('Strand.Member', 'add', new.Key, new.StampId)` against a pre-existing
 * (`committed.Manager`) row matching `context.ManagerKey`. The stamp is minted
 * fresh here and bound inside the signed digest, so the approval seats exactly
 * this incarnation: once the member is removed (retiring the stamp), the captured
 * approval can never re-seat it. No `ConsumedInvite` is involved: this is the
 * path a manager uses to seat a member it already trusts (e.g. a manager-side
 * enrollment that admits a party already authorised out-of-band).
 *
 * @param db - The closed strand's database.
 * @param params - The admitting manager keypair and the new member key.
 * @throws If `Member.Authorized` rejects (e.g. a non-manager key); the insert
 *   rolls back, leaving no `Member` row.
 */
export async function addMemberByManager(db: Database, params: AddMemberByManagerParams): Promise<void> {
  const { managerKeyPair, memberKey } = params;
  const stampId = generateStrandStampId();
  const signature = signStrandApproval(['Strand.Member', 'add', memberKey, stampId], managerKeyPair.privateKeyB64);
  await db.exec(
    `insert into Strand.Member (Key, StampId)
       with context ManagerKey = ?, ManagerSignature = ?, MemberSignature = null
       values (?, ?)`,
    [managerKeyPair.publicKeyB64, signature, memberKey, stampId],
  );
  log('Admitted member %s by manager %s', memberKey, managerKeyPair.publicKeyB64);
}

/** Parameters for {@link revokeMember}. */
export interface RevokeMemberParams {
  /**
   * The revoking manager's strand keypair. Its `publicKeyB64` must be a
   * PRE-EXISTING `Strand.Manager` row (the manager-removal branch of
   * `Member.Authorized` reads `committed.Manager` — a manager seated in the same
   * transaction cannot authorize); it signs the remove-tagged digest over the
   * target row's key and live stamp, and files the accompanying tombstone.
   */
  managerKeyPair: Ed25519KeyPair;
  /** The `Member.Key` row to delete. */
  memberKey: string;
}

/**
 * Revoke a `Member` on the signature of an existing manager.
 *
 * Reads the target row's live StampId first (a quiet no-op if the row is already
 * absent — a repeated or restarted revocation should not throw), then runs ONE
 * transaction pairing the delete with its `Strand.Revocation` tombstone: the
 * schema's `Member.RevocationRecorded` requires the tombstone in the same
 * transaction, and the tombstone is what permanently retires the stamp so the
 * captured admission approval can never re-seat this incarnation.
 *
 * The manager-removal branch of `Member.Authorized` verifies the remove-tagged
 * digest `digest('Strand.Member', 'remove', old.Key, old.StampId)` against a
 * `committed.Manager` row matching `context.ManagerKey` — distinct from the
 * add-tagged admission payload, and bound to the live stamp, so neither a
 * captured admission nor a captured PRIOR removal (whose stamp differs) replays.
 *
 * A revoked member cannot re-admit itself off the invite it ALREADY SPENT: that
 * `ConsumedInvite` row is stale, and the invite branch requires a
 * same-transaction FRESH consumption. Re-admission normally takes a fresh
 * manager action ({@link addMemberByManager} or a new invite).
 *
 * An UNSPENT invite the revoked party holds is killed EXPLICITLY, by the manager
 * calling {@link cancelInvite} on it (enumerate the candidates with
 * {@link listOutstandingInvites}); a cancelled invitation can never be consumed,
 * and cancellation is permanent. This removal does NOT cascade into cancellation:
 * an invitation names no invitee, so there is nothing to match the removed member
 * against — the strand cannot tell which invitations were meant for it, or whether
 * it holds any. Binding an invitation to its invitee is tracked as
 * `feat-strand-invitee-bound-invites`.
 *
 * A manager must resign its `Manager` row before (or in the same transaction
 * as) losing membership — `Member.NotAManager` rejects un-membering a key that
 * still holds a Manager row. And the strand never drops to zero members
 * (`Member.MinOneMember`, a local-count floor with the cross-node caveat its
 * schema NOTE states).
 *
 * @param db - The closed strand's database.
 * @param params - The revoking manager keypair and the target member key.
 * @throws If `Member.Authorized` rejects (a non-manager or same-transaction
 *   signer), `Member.NotAManager` rejects (the target still holds a Manager
 *   row), or `Member.MinOneMember` rejects (the removal would empty the member
 *   set); the whole delete+tombstone transaction rolls back.
 */
export async function revokeMember(db: Database, params: RevokeMemberParams): Promise<void> {
  const { managerKeyPair, memberKey } = params;
  const stampId = await memberStampId(db, memberKey);
  if (stampId == null) {
    log('Member %s already absent; skipping revoke', memberKey);
    return;
  }
  const signature = signStrandApproval(['Strand.Member', 'remove', memberKey, stampId], managerKeyPair.privateKeyB64);
  await inStrandTransaction(db, async () => {
    await db.exec(
      `delete from Strand.Member
         with context ManagerKey = ?, ManagerSignature = ?, MemberSignature = null
         where Key = ?`,
      [managerKeyPair.publicKeyB64, signature, memberKey],
    );
    await insertRevocation(db, 'Member', stampId, managerKeyPair);
  });
  log('Revoked member %s by manager %s', memberKey, managerKeyPair.publicKeyB64);
}

/** Parameters for {@link leaveStrand}. */
export interface LeaveStrandParams {
  /**
   * The departing member's OWN strand keypair. Its `publicKeyB64` is the
   * `Member.Key` row being deleted; it self-signs the leave-tagged digest —
   * the self-departure branch verifies the signature against `old.Key` itself,
   * so only the departing key's holder can produce it — and files the
   * accompanying tombstone (it is still a committed member until this very
   * transaction removes it, which is what `Revocation.Authorized` checks). No
   * manager is involved.
   */
  memberKeyPair: Ed25519KeyPair;
}

/**
 * A member leaves the strand by deleting its own `Member` row.
 *
 * The self-departure branch of `Member.Authorized` verifies
 * `digest('Strand.Member', 'leave', old.Key, old.StampId)` against `old.Key`
 * itself via `context.MemberSignature`. The `'leave'` tag (vs the manager
 * branch's `'remove'`) is belt-and-braces only — the two branches verify against
 * different keys; the anti-replay fix is the stamp binding. Like
 * {@link revokeMember}, the live stamp is read first (absent row → quiet no-op)
 * and the delete pairs with its `Strand.Revocation` tombstone in one transaction.
 *
 * The same floors as {@link revokeMember} apply: a manager must resign first
 * (`NotAManager`) and the last member cannot leave (`MinOneMember`).
 *
 * @param db - The closed strand's database.
 * @param params - The departing member's own keypair.
 * @throws If `Member.Authorized`, `Member.NotAManager`, or `Member.MinOneMember`
 *   rejects; the whole delete+tombstone transaction rolls back.
 */
export async function leaveStrand(db: Database, params: LeaveStrandParams): Promise<void> {
  const { memberKeyPair } = params;
  const memberKey = memberKeyPair.publicKeyB64;
  const stampId = await memberStampId(db, memberKey);
  if (stampId == null) {
    log('Member %s already absent; skipping leave', memberKey);
    return;
  }
  const signature = signStrandApproval(['Strand.Member', 'leave', memberKey, stampId], memberKeyPair.privateKeyB64);
  await inStrandTransaction(db, async () => {
    await db.exec(
      `delete from Strand.Member
         with context ManagerKey = null, ManagerSignature = null, MemberSignature = ?
         where Key = ?`,
      [signature, memberKey],
    );
    await insertRevocation(db, 'Member', stampId, memberKeyPair);
  });
  log('Member %s left the strand', memberKey);
}

// ── MemberPeer registration (a member binds its own network nodes) ─────────────

/** Parameters for {@link registerMemberPeer}. */
export interface RegisterMemberPeerParams {
  /**
   * The member's OWN strand keypair (`{ privateKeyB64, publicKeyB64 }`). Its
   * `publicKeyB64` becomes `MemberPeer.MemberKey` and it self-signs the binding —
   * `MemberPeer.Authorized` verifies the signature against `MemberKey` itself, so a
   * peer can only be registered by the very member it belongs to (no manager
   * involved). The founder passes its `strandMemberKeyPair`; an invited member
   * passes its own keypair. Typed as {@link Ed25519KeyPair} only for the shared
   * base64url keypair shape — no manager privilege is implied.
   */
  memberKeyPair: Ed25519KeyPair;
  /** The peer/node id (libp2p peer id string) to associate with the member. */
  peerId: string;
}

/**
 * Register a network node (`PeerId`) as acting on behalf of a member.
 *
 * The member self-signs the add-tagged digest
 * `digest('Strand.MemberPeer', 'add', new.MemberKey, new.PeerId, new.StampId)`
 * with its OWN key; the schema's `MemberPeer.Authorized` verifies that signature
 * against `new.MemberKey` — i.e. the member key itself — so only the member that
 * owns the key can register peers for it. The stamp is minted fresh here and
 * bound inside the digest, so a captured registration approval neither
 * re-registers a cleared binding (its stamp is retired) nor authorizes a removal
 * (wrong tag). A deferred `MemberExists` additionally requires the `Member` row
 * to already exist, so a peer for a non-member is rejected at commit.
 *
 * Insert-if-absent: a re-register on restart (or a redundant call) is a no-op. The
 * platform DOES reject a duplicate-PK insert, but a restart-safe re-register should
 * succeed quietly rather than throw, so the writer guards on existence instead of
 * catching. The guard ({@link memberPeerStampId}) scans the member's peers and compares
 * both key columns in JavaScript rather than seeking the composite primary key — see
 * {@link scanMemberPeers} for why a full-PK point lookup is not reliable on a networked
 * strand. A member may register multiple DISTINCT `PeerId`s (multi-device); each is its
 * own row (and its own stamp) under the same `MemberKey`.
 *
 * Peer DELETION is signature-checked too, not rejected outright: `Authorized` carries
 * distinct delete branches (self + manager), each over its own action-tagged digest
 * bound to the row's stamp. Both removal paths live in {@link removeMemberPeer}.
 * UPDATE is refused outright by `NoUpdate`: a re-binding is a remove plus a fresh
 * register (under a fresh stamp).
 *
 * @param db - The closed strand's database (the member already exists).
 * @param params - The member's own keypair and the peer id to bind.
 * @throws If `MemberPeer.Authorized`/`MemberExists` rejects (wrong signer, or no
 *   matching `Member` row); the insert rolls back, leaving no `MemberPeer` row.
 */
export async function registerMemberPeer(db: Database, params: RegisterMemberPeerParams): Promise<void> {
  const { memberKeyPair, peerId } = params;
  const memberKey = memberKeyPair.publicKeyB64;

  if (await memberPeerStampId(db, memberKey, peerId) != null) {
    log('MemberPeer (%s, %s) already present; skipping', memberKey, peerId);
    return;
  }

  const stampId = generateStrandStampId();
  const signature = signStrandApproval(
    ['Strand.MemberPeer', 'add', memberKey, peerId, stampId],
    memberKeyPair.privateKeyB64,
  );
  await db.exec(
    `insert into Strand.MemberPeer (MemberKey, PeerId, StampId)
       with context Signature = ?, ManagerKey = null, ManagerSignature = null
       values (?, ?, ?)`,
    [signature, memberKey, peerId, stampId],
  );
  log('Registered MemberPeer (%s, %s)', memberKey, peerId);
}

/**
 * Yield every `(PeerId, StampId)` bound to `memberKey`, re-comparing the member key
 * in JavaScript.
 *
 * Deliberately does NOT filter on the full composite primary key. `MemberPeer`'s PK
 * is `(MemberKey, PeerId)`, so a `where MemberKey = ? and PeerId = ?` predicate puts
 * an equality on BOTH key columns — which the optimystic virtual-table module reports
 * as fully handled and serves via a single-key point lookup (one `find` descent), with
 * the SQL engine adding no filter of its own. On a networked strand that descent is not
 * reliable: a miss returns zero rows for a row that provably exists.
 *
 * Filtering on only the LEADING key column is a partial PK match, which the same module
 * explicitly declines to handle — it falls through to a table scan and the SQL engine
 * applies `MemberKey = ?` itself. No seek is involved, so no seek can miss. The member key
 * is then re-compared here in JavaScript, so correctness depends only on the scan returning
 * a SUPERSET of the matching rows — the weakest possible assumption about the storage layer.
 * The `where` clause only trims what crosses into JS — it is NOT pushed down (see the cost
 * note below) — so it is not a correctness dependency: a dropped or mis-applied predicate
 * cannot produce a row attributed to the wrong member.
 */
async function* scanMemberPeers(db: Database, memberKey: string): AsyncGenerator<{ peerId: string; stampId: string }> {
  // NOTE: because the predicate is not pushed down, the storage layer walks the WHOLE
  // MemberPeer table (every member's rows) per call and the SQL engine filters. Fine at
  // strand scale; if MemberPeer ever grows large, the fix is a reliable composite-key
  // seek, not a bigger scan.
  // NOTE: if a secondary index on MemberPeer.MemberKey is ever added, this query stops
  // being a scan and becomes an index seek — re-introducing the seek dependency this
  // shape exists to remove.
  for await (const row of db.eval(
    'select MemberKey, PeerId, StampId from Strand.MemberPeer where MemberKey = ?',
    [memberKey],
  )) {
    if (row.MemberKey === memberKey) {
      yield { peerId: row.PeerId as string, stampId: row.StampId as string };
    }
  }
}

/**
 * Every `PeerId` currently bound to `memberKey`, in storage order.
 *
 * The enumeration side of {@link removeMemberPeer}: a manager cleaning up after a
 * revocation knows only the departed member's key, never which devices it registered, so
 * cleanup is `listMemberPeers` then one `removeMemberPeer` per id. Reads only — the rows
 * it returns may name a `MemberKey` with no `Member` row (see the `MemberPeer` table NOTE
 * in the schema), so this is NOT a membership test.
 *
 * @param db - The closed strand's database.
 * @param memberKey - The `MemberPeer.MemberKey` to enumerate.
 * @returns The bound peer ids, empty if the member has none.
 */
export async function listMemberPeers(db: Database, memberKey: string): Promise<string[]> {
  const peerIds: string[] = [];
  for await (const peer of scanMemberPeers(db, memberKey)) {
    peerIds.push(peer.peerId);
  }
  return peerIds;
}

/**
 * The live StampId of the `MemberPeer` row for this `(MemberKey, PeerId)`, or
 * `undefined` if no such row is visible — doubling as the existence probe.
 *
 * NOTE: check-then-write is not atomic. Two nodes registering the same
 * (MemberKey, PeerId) concurrently can both observe "absent"; the primary key is the
 * real backstop. The existence half of this guard is for the sequential restart /
 * re-register path.
 */
async function memberPeerStampId(db: Database, memberKey: string, peerId: string): Promise<string | undefined> {
  for await (const peer of scanMemberPeers(db, memberKey)) {
    if (peer.peerId === peerId) {
      return peer.stampId;
    }
  }
  return undefined;
}

/** Parameters for the SELF branch of {@link removeMemberPeer}. */
export interface RemoveOwnPeerParams {
  /**
   * The member's OWN strand keypair. Its `publicKeyB64` is the `MemberPeer.MemberKey`
   * of the row being deleted, and it signs the remove-tagged digest
   * `digest('Strand.MemberPeer', 'remove', MemberKey, PeerId, StampId)` — the self
   * branch of `MemberPeer.Authorized` verifies against the row's own member key, so
   * no OTHER member's row is reachable this way, and the tag + stamp binding keep a
   * captured registration approval from doubling as a removal (and vice versa).
   */
  memberKeyPair: Ed25519KeyPair;
  /** The `PeerId` of the binding to delete. */
  peerId: string;
}

/** Parameters for the MANAGER branch of {@link removeMemberPeer}. */
export interface RemoveMemberPeerByManagerParams {
  /**
   * The clearing manager's strand keypair. Its `publicKeyB64` must be a PRE-EXISTING
   * `Strand.Manager` row (the manager branch reads `committed.Manager`, so a manager
   * seated in the same transaction cannot authorize); it signs the
   * manager-remove-tagged digest over the exact row and its live stamp, and files
   * the accompanying tombstone.
   */
  managerKeyPair: Ed25519KeyPair;
  /** The `MemberPeer.MemberKey` whose binding is being cleared. */
  memberKey: string;
  /** The `PeerId` of the binding to delete. */
  peerId: string;
}

/**
 * Either shape accepted by {@link removeMemberPeer}. A discriminated union rather than
 * one opaque keypair: the two branches sign DIFFERENT action tags (`'remove'` self vs
 * `'manager-remove'`), so each case carries exactly the fields its payload needs.
 */
export type RemoveMemberPeerParams = RemoveOwnPeerParams | RemoveMemberPeerByManagerParams;

/**
 * Delete a `MemberPeer` binding — either the member clearing its own, or a manager
 * clearing another member's.
 *
 * Reads the row's live StampId first (absent → quiet no-op, mirroring
 * {@link registerMemberPeer}'s insert-if-absent, so a repeated or restarted cleanup
 * is not a silent zero-row "success" the caller cannot distinguish from a real one),
 * then runs ONE transaction pairing the delete with its `Strand.Revocation`
 * tombstone — `MemberPeer.RevocationRecorded` requires it, and the retirement is
 * what keeps the captured registration approval from re-binding the cleared row.
 *
 * `MemberPeer` rows do NOT cascade when the member is revoked (`MemberExists` runs on
 * insert only, and nothing deletes them), so a removed member's peer bindings survive
 * as orphans — enumerate them with {@link listMemberPeers}, which is how a manager
 * discovers what to clear. Only that member can sign the self branch, and a member being
 * removed against its will has no reason to cooperate — hence the manager branch, which
 * is the cleanup path after a revocation.
 *
 * The manager branch is deliberately NOT gated on the member already being gone: a
 * manager may clear a still-present member's binding too, matching "any manager can
 * remove any member". It verifies the manager-remove-tagged
 * `digest('Strand.MemberPeer', 'manager-remove', old.MemberKey, old.PeerId, old.StampId)`
 * against a `committed.Manager` row; the self branch verifies the remove-tagged
 * sibling against the row's own member key.
 *
 * Cleanup is an explicit follow-up call by the revoking manager, never a cascade inside
 * {@link revokeMember}: a revocation that also had to clear an unbounded number of peer
 * rows in the same transaction would couple two concerns and make its failure modes
 * harder to reason about.
 *
 * @param db - The closed strand's database.
 * @param params - Either the owning member's keypair, or a manager's keypair plus the
 *   target member key.
 * @throws If `MemberPeer.Authorized` rejects (neither branch satisfied), or if the row
 *   is still present after the delete (see the point-lookup note below).
 */
export async function removeMemberPeer(db: Database, params: RemoveMemberPeerParams): Promise<void> {
  const memberKey = 'memberKeyPair' in params ? params.memberKeyPair.publicKeyB64 : params.memberKey;
  const { peerId } = params;

  const stampId = await memberPeerStampId(db, memberKey, peerId);
  if (stampId == null) {
    log('MemberPeer (%s, %s) already absent; skipping', memberKey, peerId);
    return;
  }

  await inStrandTransaction(db, async () => {
    if ('memberKeyPair' in params) {
      await deleteOwnMemberPeer(db, params, stampId);
    } else {
      await deleteMemberPeerByManager(db, params, stampId);
    }
  });

  // NOTE: the delete's `where` puts an equality on BOTH composite-PK columns, which the
  // optimystic vtab module serves via a single-key seek that can MISS on a networked
  // strand (see scanMemberPeers' doc). A missed seek deletes zero rows and still
  // reports success. `Revocation.RowIsGone` now catches that first — the tombstone filed
  // in the same transaction refuses to retire a stamp whose row is still visible, so the
  // commit above fails loudly and this re-check is belt-and-braces behind it. Tracked as
  // `debt-composite-pk-point-lookup-unreliable-untracked`; this is an availability
  // failure mode, never a security one (a miss removes nothing, it never over-removes).
  if (await memberPeerStampId(db, memberKey, peerId) != null) {
    throw new Error(`MemberPeer (${memberKey}, ${peerId}) still present after delete`);
  }
  log('Removed MemberPeer (%s, %s)', memberKey, peerId);
}

/** The self branch: the owning member signs the remove-tagged digest + tombstone. */
async function deleteOwnMemberPeer(db: Database, params: RemoveOwnPeerParams, stampId: string): Promise<void> {
  const { memberKeyPair, peerId } = params;
  const memberKey = memberKeyPair.publicKeyB64;
  const signature = signStrandApproval(
    ['Strand.MemberPeer', 'remove', memberKey, peerId, stampId],
    memberKeyPair.privateKeyB64,
  );
  await db.exec(
    `delete from Strand.MemberPeer
       with context Signature = ?, ManagerKey = null, ManagerSignature = null
       where MemberKey = ? and PeerId = ?`,
    [signature, memberKey, peerId],
  );
  await insertRevocation(db, 'MemberPeer', stampId, memberKeyPair);
}

/** The manager branch: a manager signs the manager-remove-tagged digest + tombstone. */
async function deleteMemberPeerByManager(
  db: Database,
  params: RemoveMemberPeerByManagerParams,
  stampId: string,
): Promise<void> {
  const { managerKeyPair, memberKey, peerId } = params;
  const signature = signStrandApproval(
    ['Strand.MemberPeer', 'manager-remove', memberKey, peerId, stampId],
    managerKeyPair.privateKeyB64,
  );
  await db.exec(
    `delete from Strand.MemberPeer
       with context Signature = null, ManagerKey = ?, ManagerSignature = ?
       where MemberKey = ? and PeerId = ?`,
    [managerKeyPair.publicKeyB64, signature, memberKey, peerId],
  );
  await insertRevocation(db, 'MemberPeer', stampId, managerKeyPair);
}

// ── Manager rotation (add / remove RBAC admins) ───────────────────────────────

/**
 * The live `(Generation, StampId)` of the `Strand.Manager` row keyed by
 * `memberKey`, or `undefined` if no such row is visible.
 *
 * `Manager`'s primary key is the single `MemberKey` column, so any where-equality
 * on it is a full-PK point lookup — unreliable on a networked strand (see
 * {@link scanMemberPeers}). An unfiltered scan + JavaScript filter instead, same
 * as {@link memberStampId}. Serves both {@link addManager} (the authorizer's
 * generation) and {@link removeManager} (the target's stamp).
 */
async function managerRow(db: Database, memberKey: string): Promise<{ generation: number; stampId: string } | undefined> {
  for await (const row of db.eval('select MemberKey, Generation, StampId from Strand.Manager')) {
    if (row.MemberKey === memberKey) {
      return { generation: Number(row.Generation), stampId: row.StampId as string };
    }
  }
  return undefined;
}

/** Parameters for {@link addManager}. */
export interface AddManagerParams {
  /**
   * An EXISTING manager's strand keypair. Its `publicKeyB64` must already be a
   * `Strand.Manager` row (the existing-manager branch of `Manager.Authorized`
   * rejects a non-manager once the founder manager exists); it signs the
   * add-tagged digest over the new manager key, generation, and fresh stamp,
   * and is bound as `context.ManagerKey`.
   */
  byManagerKeyPair: Ed25519KeyPair;
  /** The member key to promote — the new `Manager.MemberKey` row. */
  newManagerKey: string;
}

/**
 * Promote a key that is ALREADY a `Strand.Member` to `Manager` on the signature of
 * an existing manager — use {@link admitManager} to admit and promote atomically.
 *
 * The promotion branch of `Manager.Authorized` requires the authorizer to be a
 * `Manager` row of STRICTLY SMALLER `Generation` than the new row, verifying
 * `digest('Strand.Manager', 'add', new.MemberKey, new.Generation, new.StampId)`
 * against `context.ManagerKey`. So this writer reads the authorizer's generation,
 * seats the new manager at that value + 1 (the natural successor; the schema
 * enforces only the strict ordering), mints a fresh stamp, and signs the
 * add-tagged digest over all three: the generation inside the signed digest keeps
 * a captured promotion from replaying at a different generation, and the stamp
 * keeps it from re-seating a second incarnation once this one is removed.
 * `new.Generation` is an SQL INTEGER digest arg — the digest framing is
 * type-tagged, so the TS side signs over the NUMBER itself
 * (see {@link signStrandApproval}).
 *
 * The strict ordering — not this writer — is what makes a same-transaction takeover
 * impossible; the `Manager.Generation` column comment in `schemas/strand.qsql` carries
 * that argument. All this writer owes it is a generation strictly above the
 * authorizer's, inside the signed payload.
 *
 * When the authorizer has NO `Manager` row (a non-manager signer, or an open
 * strand with no managers at all), the scan finds nothing and the writer falls
 * back to generation 1 and issues the insert anyway — deliberately letting the
 * SCHEMA be the rejector (`Manager.Authorized` / `OnlyClosed`), not a
 * writer-thrown error, so enforcement is pinned where it actually lives.
 *
 * @param db - The closed strand's database (founder manager already seated).
 * @param params - The authorizing manager's keypair and the new manager key.
 * @throws If `Manager.Authorized` rejects, or if `Manager.MemberExists` rejects because
 *   `newManagerKey` holds no `Member` row (admit it first, or use
 *   {@link admitManager}); the insert rolls back.
 */
export async function addManager(db: Database, params: AddManagerParams): Promise<void> {
  const { byManagerKeyPair, newManagerKey } = params;
  const authorizer = await managerRow(db, byManagerKeyPair.publicKeyB64);
  // NOTE: +1 saturates at Number.MAX_SAFE_INTEGER, where the successor compares equal
  // to its authorizer and the schema rejects. Unreachable while generations only ever
  // grow by 1 from 0, but the schema enforces ordering, not adjacency, so a manager may
  // seat a successor at any larger value; if arbitrary generations ever become writable
  // from outside this function, clamp or reject here rather than emitting a dead row.
  const generation = authorizer == null ? 1 : authorizer.generation + 1;
  const stampId = generateStrandStampId();
  const signature = signStrandApproval(
    ['Strand.Manager', 'add', newManagerKey, generation, stampId],
    byManagerKeyPair.privateKeyB64,
  );
  await db.exec(
    `insert into Strand.Manager (MemberKey, Generation, StampId)
       with context ManagerKey = ?, Signature = ?
       values (?, ?, ?)`,
    [byManagerKeyPair.publicKeyB64, signature, newManagerKey, generation, stampId],
  );
  log('Added manager %s (generation %d) by %s', newManagerKey, generation, byManagerKeyPair.publicKeyB64);
}

/** Parameters for {@link admitManager} — the same shape as {@link AddManagerParams}. */
export type AdmitManagerParams = AddManagerParams;

/**
 * Admit a key as a `Member` AND promote it to `Manager`, atomically — the one-step
 * pair for a key that is not in the strand yet. {@link addManager} alone promotes a
 * key that is already a member.
 *
 * ONE transaction, because `Manager.MemberExists` is a deferred check reading the LIVE
 * `Member` table: the sibling `Member` insert satisfies it at the shared commit, and a
 * rejection of either half rolls BOTH rows back — never a `Member` row seated by a
 * failed promotion, nor a `Manager` row with no member behind it.
 *
 * NO new authority: both halves are signed by the SAME manager, over two distinct
 * action-tagged digests — `digest('Strand.Member', 'add', …)` for the admission and
 * `digest('Strand.Manager', 'add', …)` for the promotion — each bound to its own row's
 * fresh stamp. This composes exactly the two approvals that manager could already
 * issue separately.
 *
 * The promoting manager must be a PRE-transaction manager: the direct-admit branch of
 * `Member.Authorized` reads `committed.Manager`, so `admitManager` cannot be chained —
 * a manager seated by an `admitManager` earlier in the SAME transaction cannot admit
 * the next one. (A same-transaction promotion CHAIN rooted at a pre-existing manager
 * is fine; only the `Member` half needs the committed authorizer.)
 *
 * NOT insert-if-absent: a repeat call for a key that is already a member fails on the
 * `Member` primary key, matching {@link addMemberByManager}'s unguarded shape.
 *
 * @param db - The closed strand's database (founder manager already seated).
 * @param params - The authorizing manager's keypair and the key to admit + promote.
 * @throws If either half is rejected (`Member.Authorized`, `Manager.Authorized`, a
 *   duplicate `Member` key, …); the whole transaction rolls back, leaving neither row.
 */
export async function admitManager(db: Database, params: AdmitManagerParams): Promise<void> {
  const { byManagerKeyPair, newManagerKey } = params;
  await inStrandTransaction(db, async () => {
    await addMemberByManager(db, { managerKeyPair: byManagerKeyPair, memberKey: newManagerKey });
    await addManager(db, { byManagerKeyPair, newManagerKey });
  });
  log('Admitted + promoted manager %s by %s', newManagerKey, byManagerKeyPair.publicKeyB64);
}

/** Parameters for {@link removeManager}. */
export interface RemoveManagerParams {
  /**
   * The keypair authorizing the removal, bound as `context.ManagerKey`. For an
   * ADMIN removal this is a DIFFERENT existing manager, signing the
   * remove-tagged digest (satisfying the existing-manager branch); for a
   * SELF-resignation it is the target's OWN keypair (`publicKeyB64 ===
   * targetManagerKey`), signing the resign-tagged digest (satisfying the
   * former-manager self branch). The writer picks the tag by comparing the keys —
   * see {@link removeManager}. Either way this keypair also files the
   * accompanying tombstone, which requires it to be a PRE-transaction MEMBER
   * (`Revocation.Authorized` reads `committed.Member`) — true for every manager,
   * since managers are members.
   */
  byManagerKeyPair: Ed25519KeyPair;
  /** The `Manager.MemberKey` row to delete. */
  targetManagerKey: string;
}

/**
 * Remove a `Manager` row — either an admin removing a different manager or a
 * manager resigning itself.
 *
 * Reads the target row's live `(Generation, StampId)` first (absent → quiet
 * no-op, same restart-safe shape as {@link revokeMember}), then runs ONE
 * transaction pairing the delete with its `Strand.Revocation` tombstone
 * (`Manager.RevocationRecorded`). The two delete-side branches of
 * `Manager.Authorized` verify DIFFERENT action-tagged digests, each bound to
 * `(old.MemberKey, old.StampId)`:
 * - **Admin removal** (`byManagerKeyPair` is a different existing manager): the
 *   removal branch verifies `digest('Strand.Manager', 'remove', old.MemberKey,
 *   old.StampId)` against `A.MemberKey = context.ManagerKey`. Deliberately NO
 *   generation condition: a later-generation manager may remove an
 *   earlier-generation one (generation is lineage, not privilege), and deletes
 *   are safe once inserts are — every accepting branch requires a `Manager` row
 *   in the post-image, and the promotion branch's generation ordering keeps
 *   attacker rows out of it. The stamp binding is what makes a captured removal
 *   single-use: a re-promoted manager carries a fresh stamp the old approval
 *   does not match — closing the removal half of
 *   `bug-strand-manager-authority-antireplay` (the insert half was already
 *   closed by the generation-bearing promotion payload).
 * - **Self-resignation** (`byManagerKeyPair` IS the target): the former-manager
 *   self branch verifies `digest('Strand.Manager', 'resign', old.MemberKey,
 *   old.StampId)` against `old.MemberKey` itself. The distinct `'resign'` tag is
 *   belt-and-braces (different verifying keys); the anti-replay fix is the stamp.
 *
 * The caller selects the case purely by which keypair it passes; the only
 * branching here is the action tag, chosen by comparing the signer to the target.
 *
 * Deferred (subquery-bearing) CHECK constraints are evaluated on DELETE as well
 * as INSERT by Quereus plus the Optimystic vtab session — enforcement lives above
 * the transactor (proven on the network transactor by
 * `strand-membership-network-transactor-parity.spec.ts`), so `Manager.Authorized`
 * — deferred — IS enforced here: a signer that is neither an existing manager nor
 * the target itself is rejected at commit.
 *
 * THE SOLE MANAGER CANNOT ORDINARILY RESIGN — it SEALS instead. The `'resign'`
 * branch of `Manager.Authorized` requires at least one manager in the POST-delete
 * image, so a resignation that would empty the `Manager` table is schema-rejected;
 * emptying it deliberately is a distinct, self-signed act — {@link sealStrand} —
 * that permanently freezes admission. This writer refuses the sole-manager
 * self-resignation up front with an error naming `sealStrand`; that TS guard is UX,
 * not the trust boundary — the schema rejects a mis-counted `'resign'` approval
 * regardless. Reading the count inside a caller-joined transaction is correct: an
 * add-then-resign hand-off composed in one transaction sees 2 and passes, while
 * the already-rejected delete-then-add swap sees 1 and is refused here as well as
 * by the schema. The bootstrap branch of `Manager.Authorized` is gated to INSERTs
 * (`old.MemberKey is null`), so it does not waive the signature check on a delete
 * that drops the count toward zero: a second-to-last removal is authorized
 * exactly like any other.
 *
 * HAND-OFF ORDER: a sole manager transferring control must ADD the successor FIRST
 * and resign SECOND. A same-transaction delete-then-insert swap is rejected — the
 * bootstrap branch is gated to the founding state (at most one `Member`), and the
 * successor's insert has no other manager to authorize it once the sole manager's
 * row is gone.
 *
 * Cross-node caveat: the `'resign'`/`'seal'` branches count rows visible to THIS
 * transaction, so two nodes concurrently removing different managers can each see
 * a survivor and still converge to zero — an unintended seal. Noted in the schema
 * (the `Manager` table's seal-propagation NOTE); a cross-node floor is not
 * attempted here.
 *
 * @param db - The closed strand's database.
 * @param params - The authorizing keypair and the target manager key.
 * @throws If the signer IS the target and it is the sole manager (before writing —
 *   the operation the caller wants is {@link sealStrand}), or if `Manager.Authorized`
 *   rejects (a signer that is neither another existing manager nor the target
 *   itself, or a raw sole-manager `'resign'` whose post-image count is zero); the
 *   whole delete+tombstone transaction rolls back.
 */
export async function removeManager(db: Database, params: RemoveManagerParams): Promise<void> {
  const { byManagerKeyPair, targetManagerKey } = params;
  const target = await managerRow(db, targetManagerKey);
  if (target == null) {
    log('Manager %s already absent; skipping removal', targetManagerKey);
    return;
  }
  const tag = byManagerKeyPair.publicKeyB64 === targetManagerKey ? 'resign' : 'remove';
  if (tag === 'resign' && await strandTableCount(db, 'Manager') === 1) {
    throw new Error(
      'Cannot resign as the SOLE manager: an ordinary resignation never empties the '
      + 'Manager table. To permanently freeze admission instead, call sealStrand.',
    );
  }
  const signature = signStrandApproval(
    ['Strand.Manager', tag, targetManagerKey, target.stampId],
    byManagerKeyPair.privateKeyB64,
  );
  await inStrandTransaction(db, async () => {
    await db.exec(
      `delete from Strand.Manager
         with context ManagerKey = ?, Signature = ?
         where MemberKey = ?`,
      [byManagerKeyPair.publicKeyB64, signature, targetManagerKey],
    );
    await insertRevocation(db, 'Manager', target.stampId, byManagerKeyPair);
  });
  log('Removed manager %s by %s', targetManagerKey, byManagerKeyPair.publicKeyB64);
}

// ── Sealing (the sole manager permanently freezes admission) ──────────────────

/** Parameters for {@link sealStrand}. */
export interface SealStrandParams {
  /**
   * The SOLE manager's strand keypair. Its `publicKeyB64` must be the one live
   * `Strand.Manager` row; it signs the seal-tagged digest over its own key and
   * live stamp, and files the accompanying tombstone (it is still a committed
   * member, which is what `Revocation.Authorized` checks).
   */
  managerKeyPair: Ed25519KeyPair;
}

/**
 * Seal the strand: the SOLE manager deliberately steps down, permanently freezing
 * membership.
 *
 * A sealed strand has zero `Manager` rows, and every admission path — issuing or
 * cancelling an invitation, consuming one issued BEFORE the seal
 * (`ConsumedInvite.NotSealed`), admitting a member, promoting a manager — requires
 * one, so nobody can ever be let in again. That freeze is a privacy guarantee to
 * everyone who contributed: no key holds the power to admit a party who would then
 * read the strand's whole history. Sealing is irreversible — the founding branch
 * of `Manager.Authorized` closes for good once any manager stamp is retired into
 * `Strand.Revocation`. What remains possible: members may {@link leaveStrand}
 * (floored by `MinOneMember`), manage their own `MemberPeer` rows, and file
 * `Revocation` tombstones.
 *
 * The `'seal'` branch of `Manager.Authorized` accepts a self-signed delete only
 * when the POST-image manager count is ZERO — a distinct action tag from
 * `'resign'`, so a captured resignation approval can never seal and a raw writer
 * cannot seal by accident. Like {@link removeManager}, the delete pairs with its
 * `Strand.Revocation` tombstone in one transaction.
 *
 * The TS count/identity checks below are UX guards, not the trust boundary — the
 * schema rejects a mis-tagged or mis-counted approval regardless of what this
 * writer (or any raw writer) presents.
 *
 * @param db - The closed strand's database.
 * @param params - The sole manager's own keypair.
 * @throws If more than one manager exists (the caller wants {@link removeManager}),
 *   or the supplied keypair holds no `Manager` row while one exists, or the strand
 *   holds no `Manager` row and has never retired one (not founded yet — see
 *   {@link isStrandSealed}), or any schema constraint rejects; the whole
 *   delete+tombstone transaction rolls back. A strand that is ALREADY sealed logs
 *   and returns quietly (restart-safe, matching {@link bootstrapFounderMembership}
 *   and {@link removeManager}'s absent-row no-op).
 */
export async function sealStrand(db: Database, params: SealStrandParams): Promise<void> {
  const { managerKeyPair } = params;
  const managerCount = await strandTableCount(db, 'Manager');
  if (managerCount === 0) {
    // Zero managers is NOT by itself a seal — a closed strand between its Header
    // and Manager founding inserts looks identical. The retired `Manager` stamp is
    // what separates "frozen forever" from "still foundable"; returning quietly on
    // the latter would report a seal that never happened.
    if (await strandHasManagerRevocation(db)) {
      log('Strand already sealed (no Manager rows, manager stamp retired); skipping seal');
      return;
    }
    throw new Error(
      'Cannot seal: the strand holds no Manager row and has never retired one — it is '
      + 'not founded yet, not sealed. Bootstrap the founding manager first.',
    );
  }
  if (managerCount > 1) {
    throw new Error(
      `Cannot seal: ${managerCount} managers exist and sealing is the SOLE manager's act. `
      + 'The other managers must step down first (removeManager).',
    );
  }
  const self = await managerRow(db, managerKeyPair.publicKeyB64);
  if (self == null) {
    throw new Error('Cannot seal: the supplied keypair does not hold the sole Manager row.');
  }
  const signature = signStrandApproval(
    ['Strand.Manager', 'seal', managerKeyPair.publicKeyB64, self.stampId],
    managerKeyPair.privateKeyB64,
  );
  await inStrandTransaction(db, async () => {
    await db.exec(
      `delete from Strand.Manager
         with context ManagerKey = ?, Signature = ?
         where MemberKey = ?`,
      [managerKeyPair.publicKeyB64, signature, managerKeyPair.publicKeyB64],
    );
    await insertRevocation(db, 'Manager', self.stampId, managerKeyPair);
  });
  log('Sealed strand: sole manager %s stepped down', managerKeyPair.publicKeyB64);
}

/**
 * Whether the strand is `Type = 'c'` (closed). Reads the singleton `Header` via
 * the same `db.eval` scan idiom as {@link strandTableCount}; a strand with no
 * `Header` row yet reports `false`.
 */
async function strandIsClosed(db: Database): Promise<boolean> {
  for await (const row of db.eval('select Type from Strand.Header')) {
    return row.Type === 'c';
  }
  return false;
}

/**
 * Whether the strand is sealed: a CLOSED strand that holds no `Manager` rows AND
 * has retired at least one `Manager` stamp into `Strand.Revocation`.
 *
 * All three conjuncts are load-bearing:
 * - `Header.Type` — an OPEN strand never holds `Manager` rows at all
 *   (`Manager.OnlyClosed`), so a bare manager-count test would report every open
 *   strand as sealed.
 * - the manager count — sealing IS the empty `Manager` table.
 * - the retired `Manager` stamp — "sealed" means admission is frozen FOREVER, and
 *   what makes it permanent is the founding branch of `Manager.Authorized`
 *   refusing to re-seat a generation-0 manager once any `Manager` stamp has been
 *   retired. Without this conjunct a closed strand that is merely NOT FOUNDED YET
 *   reads as sealed: {@link bootstrapFounderMembership} commits `Header`,
 *   `Member` and `Manager` as three sequential statements, so the window between
 *   the first and the last is exactly "closed, zero managers, still foundable".
 *
 * Reads locally visible rows — a node that has not yet converged on the seal
 * still reports `false` (the schema's seal-propagation NOTE).
 *
 * @param db - The strand's database.
 * @returns `true` iff the strand is closed, holds zero `Manager` rows, and has
 *   permanently closed its founding branch.
 */
export async function isStrandSealed(db: Database): Promise<boolean> {
  return await strandIsClosed(db)
    && await strandTableCount(db, 'Manager') === 0
    && await strandHasManagerRevocation(db);
}
