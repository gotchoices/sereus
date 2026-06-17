import debug from 'debug';
import type { Database } from '@quereus/quereus';
import { digest, sign } from '@optimystic/quereus-plugin-crypto';
import type { SAppConfig } from './types.js';
import type { AuthorityKeyPair } from './authority-key.js';

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
