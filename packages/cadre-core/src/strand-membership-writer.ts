import debug from 'debug';
import type { Database } from '@quereus/quereus';
import { digest, sign, verify, generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
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
 * The single-digest ed25519 signer the `Strand.*` membership/RBAC constraints
 * verify against.
 *
 * `schemas/strand.qsql` signs a single SHA-256 digest over a `'|'`-joined payload
 * (e.g. `Member.Authorized` verifies
 * `verify(digest(new.Key), context.ManagerSignature, A.MemberKey, 'ed25519')`).
 * So the signer hashes the payload to raw bytes and ed25519-signs *those bytes*:
 * SQL `digest(...)`'s default output is base64url and `verify(...)`'s default
 * `inputEncoding` is base64url, so signer and verifier operate on identical bytes.
 * This differs from the control-layer's multi-field `buildAuthorizationMessage`
 * (a single digest over MANY fields) — the strand layer is a single digest over ONE
 * joined payload field.
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
 * Mirrors what every `Strand.*` constraint computes:
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

/** The two `Strand.Member` actions a signed approval can be minted for. */
export type StrandMemberAction = 'add' | 'remove';

/**
 * Sign a domain/action-tagged `Strand.Member` approval.
 *
 * `Member.Authorized` verifies `digest('Strand.Member', <action>, <key>)` — the
 * domain and action tags are literal SQL arguments, and this signer passes them
 * as the leading array elements of the variadic digest. The two spellings hash
 * identical bytes; that parity is generically pinned by
 * `test/digest-variadic-parity.spec.ts` case (d). The tagging is what keeps an
 * 'add' approval from ever verifying as a 'remove' (or vice versa) — the idiom
 * of the control layer's `buildAuthorizationMessage`.
 *
 * Like {@link signStrandPayload}, the raw digest BYTES are ed25519-signed
 * directly, matching SQL `verify(...)`'s default base64url input decoding.
 *
 * @param action - Which `Member` rule the approval is minted for.
 * @param memberKey - The member public key the approval is bound to.
 * @param privateKeyB64 - The signer's base64url ed25519 private seed.
 * @returns The base64url ed25519 signature over the tagged digest.
 */
export function signStrandMemberAction(action: StrandMemberAction, memberKey: string, privateKeyB64: string): string {
  const hashBytes = digest(['Strand.Member', action, memberKey], 'sha256', 'bytes') as Uint8Array;
  return sign(hashBytes, privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}

/**
 * Sign a domain/action-tagged `Strand.MemberPeer` removal approval — the payload a
 * MANAGER signs to clear another member's peer binding.
 *
 * The manager branch of `MemberPeer.Authorized` verifies
 * `digest('Strand.MemberPeer', 'remove', old.MemberKey, old.PeerId)`, which is
 * deliberately DISTINCT from the untagged `MemberKey || '|' || PeerId` payload
 * {@link signStrandPayload} produces for registration. That separation is what stops
 * a captured registration signature from being replayed as a removal. Same tagged
 * variadic-digest idiom as {@link signStrandMemberAction}; the four-element spelling
 * is pinned against SQL by `test/digest-variadic-parity.spec.ts` case (d).
 *
 * The member's OWN removal of its own binding does NOT use this — the self branch
 * verifies the same untagged payload registration signs, so `signStrandPayload`
 * covers it.
 *
 * @param memberKey - The `MemberPeer.MemberKey` of the row being cleared.
 * @param peerId - The `MemberPeer.PeerId` of the row being cleared.
 * @param privateKeyB64 - The signing manager's base64url ed25519 private seed.
 * @returns The base64url ed25519 signature over the tagged digest.
 */
export function signStrandMemberPeerRemoval(memberKey: string, peerId: string, privateKeyB64: string): string {
  const hashBytes = digest(['Strand.MemberPeer', 'remove', memberKey, peerId], 'sha256', 'bytes') as Uint8Array;
  return sign(hashBytes, privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
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
 * seat, never for a batch. Guarding on the count makes this idempotent: a re-run
 * (the founder re-`addStrand`/`resumeStrand`) finds the member present and skips.
 */
async function insertFounderMemberIfAbsent(db: Database, memberKey: string, strandId: string): Promise<void> {
  if (await strandTableCount(db, 'Member') > 0) {
    log('Member already present for strand %s; skipping founder Member', strandId);
    return;
  }
  await db.exec(
    `insert into Strand.Member (Key)
       with context ManagerKey = null, ManagerSignature = null, MemberSignature = null
       values (?)`,
    [memberKey],
  );
  log('Inserted founding Member for strand %s', strandId);
}

/**
 * Insert the founding `Strand.Manager` if no manager exists yet.
 *
 * The empty-table state satisfies the bootstrap branch of `Manager.Authorized`, so
 * no signature is needed. The founder is seated at `Generation = 0` — the root of
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
 */
async function insertFounderManagerIfAbsent(db: Database, memberKey: string, strandId: string): Promise<void> {
  if (await strandTableCount(db, 'Manager') > 0) {
    log('Manager already present for strand %s; skipping founder Manager', strandId);
    return;
  }
  await db.exec(
    `insert into Strand.Manager (MemberKey, Generation)
       with context ManagerKey = null, Signature = null
       values (?, 0)`,
    [memberKey],
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

  await db.beginTransaction();
  try {
    // 1. Member — admitted by the deferred invite branch (the matching
    //    ConsumedInvite below), so no manager signature is supplied.
    await db.exec(
      `insert into Strand.Member (Key)
         with context ManagerKey = null, ManagerSignature = null, MemberSignature = null
         values (?)`,
      [memberKey],
    );

    // 2. ConsumedInvite — proves possession of the invite private key and that the
    //    invite has not expired (NotExpired gate against the canonical Now).
    await db.exec(
      `insert into Strand.ConsumedInvite (InviteKey, MemberKey)
         with context InviteSignature = ?, Now = ?
         values (?, ?)`,
      [inviteSignature, nowCanonical, inviteKey, memberKey],
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

/** Parameters for {@link addMemberByManager}. */
export interface AddMemberByManagerParams {
  /**
   * The admitting manager's strand keypair. Its `publicKeyB64` must be a
   * `Strand.Manager` row; it signs the new member key directly.
   */
  managerKeyPair: Ed25519KeyPair;
  /** The joining member's ed25519 PUBLIC key (base64url) — the new `Member.Key`. */
  memberKey: string;
}

/**
 * Admit a `Member` directly by manager signature — the sibling of the invite
 * path on `Member.Authorized`'s direct-manager branch.
 *
 * The constraint verifies the add-tagged digest `digest('Strand.Member', 'add',
 * new.Key)` against a pre-existing (`committed.Manager`) row matching
 * `context.ManagerKey`, so the signature comes from
 * {@link signStrandMemberAction} with the `'add'` action. No `ConsumedInvite`
 * is involved: this is the path a manager uses to seat a member it already
 * trusts (e.g. a manager-side enrollment that admits a party already authorised
 * out-of-band).
 *
 * @param db - The closed strand's database.
 * @param params - The admitting manager keypair and the new member key.
 * @throws If `Member.Authorized` rejects (e.g. a non-manager key); the insert
 *   rolls back, leaving no `Member` row.
 */
export async function addMemberByManager(db: Database, params: AddMemberByManagerParams): Promise<void> {
  const { managerKeyPair, memberKey } = params;
  const signature = signStrandMemberAction('add', memberKey, managerKeyPair.privateKeyB64);
  await db.exec(
    `insert into Strand.Member (Key)
       with context ManagerKey = ?, ManagerSignature = ?, MemberSignature = null
       values (?)`,
    [managerKeyPair.publicKeyB64, signature, memberKey],
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
   * target key.
   */
  managerKeyPair: Ed25519KeyPair;
  /** The `Member.Key` row to delete. */
  memberKey: string;
}

/**
 * Revoke a `Member` on the signature of an existing manager.
 *
 * The manager-removal branch of `Member.Authorized` verifies the remove-tagged
 * digest `digest('Strand.Member', 'remove', old.Key)` against a
 * `committed.Manager` row matching `context.ManagerKey` — distinct from the
 * add-tagged admission payload, so a captured admission cannot be replayed as an
 * eviction (or vice versa).
 *
 * A revoked member cannot re-admit itself off the invite it ALREADY SPENT: that
 * `ConsumedInvite` row is stale, and the invite branch requires a
 * same-transaction FRESH consumption. Re-admission normally takes a fresh
 * manager action ({@link addMemberByManager} or a new invite).
 *
 * It does NOT, however, neutralize an UNSPENT invite the revoked party holds:
 * `Strand.Invite` has no deactivation path (only an optional `Expiration`), so
 * any unexpired invite whose private key it kept still consumes into a fresh
 * `ConsumedInvite` and re-seats it. Revocation is therefore not a re-entry gate
 * on its own — tracked as `bug-strand-invite-no-revocation`, pinned by
 * `test/strand-member-revocation.spec.ts`.
 *
 * A manager must resign its `Manager` row before (or in the same transaction
 * as) losing membership — `Member.NotAManager` rejects un-membering a key that
 * still holds a Manager row. And the strand never drops to zero members
 * (`Member.MinOneMember`, a local-count floor with the same cross-node caveat
 * as `MinOneManager`).
 *
 * @param db - The closed strand's database.
 * @param params - The revoking manager keypair and the target member key.
 * @throws If `Member.Authorized` rejects (a non-manager or same-transaction
 *   signer), `Member.NotAManager` rejects (the target still holds a Manager
 *   row), or `Member.MinOneMember` rejects (the removal would empty the member
 *   set); the delete rolls back.
 */
export async function revokeMember(db: Database, params: RevokeMemberParams): Promise<void> {
  const { managerKeyPair, memberKey } = params;
  const signature = signStrandMemberAction('remove', memberKey, managerKeyPair.privateKeyB64);
  await db.exec(
    `delete from Strand.Member
       with context ManagerKey = ?, ManagerSignature = ?, MemberSignature = null
       where Key = ?`,
    [managerKeyPair.publicKeyB64, signature, memberKey],
  );
  log('Revoked member %s by manager %s', memberKey, managerKeyPair.publicKeyB64);
}

/** Parameters for {@link leaveStrand}. */
export interface LeaveStrandParams {
  /**
   * The departing member's OWN strand keypair. Its `publicKeyB64` is the
   * `Member.Key` row being deleted; it self-signs the remove-tagged digest —
   * the self-departure branch verifies the signature against `old.Key` itself,
   * so only the departing key's holder can produce it. No manager is involved.
   */
  memberKeyPair: Ed25519KeyPair;
}

/**
 * A member leaves the strand by deleting its own `Member` row.
 *
 * The self-departure branch of `Member.Authorized` verifies
 * `digest('Strand.Member', 'remove', old.Key)` against `old.Key` itself via
 * `context.MemberSignature` — the same remove-tagged payload a manager
 * revocation signs, but bound to the departing key, so member C's signature can
 * never remove member B.
 *
 * The same floors as {@link revokeMember} apply: a manager must resign first
 * (`NotAManager`) and the last member cannot leave (`MinOneMember`).
 *
 * @param db - The closed strand's database.
 * @param params - The departing member's own keypair.
 * @throws If `Member.Authorized`, `Member.NotAManager`, or `Member.MinOneMember`
 *   rejects; the delete rolls back.
 */
export async function leaveStrand(db: Database, params: LeaveStrandParams): Promise<void> {
  const { memberKeyPair } = params;
  const signature = signStrandMemberAction('remove', memberKeyPair.publicKeyB64, memberKeyPair.privateKeyB64);
  await db.exec(
    `delete from Strand.Member
       with context ManagerKey = null, ManagerSignature = null, MemberSignature = ?
       where Key = ?`,
    [signature, memberKeyPair.publicKeyB64],
  );
  log('Member %s left the strand', memberKeyPair.publicKeyB64);
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
 * The member self-signs `MemberKey || '|' || PeerId` with its OWN key; the schema's
 * `MemberPeer.Authorized` verifies that signature against `coalesce(new.MemberKey,
 * old.MemberKey)` — i.e. the member key itself — so only the member that owns the
 * key can register peers for it. A deferred `MemberExists` additionally requires the
 * `Member` row to already exist, so a peer for a non-member is rejected at commit.
 *
 * Insert-if-absent: a re-register on restart (or a redundant call) is a no-op. The
 * platform DOES reject a duplicate-PK insert, but a restart-safe re-register should
 * succeed quietly rather than throw, so the writer guards on existence instead of
 * catching. The guard ({@link memberPeerExists}) scans the member's peers and compares
 * both key columns in JavaScript rather than seeking the composite primary key — see
 * its doc for why a full-PK point lookup is not reliable on a networked strand. A member
 * may register multiple DISTINCT `PeerId`s (multi-device); each is its own row under the
 * same `MemberKey`.
 *
 * Peer DELETION is signature-checked too, not rejected outright: `Authorized` carries an
 * explicit `on insert, delete` mask and coalesces `new`/`old`, so a delete verifies against
 * the member key the row names. `MemberExists` is insert-only (a delete leaves no row image
 * to validate), so it neither blocks nor cascades. Both removal paths — the member clearing
 * its own binding and a manager clearing someone else's — live in {@link removeMemberPeer}.
 * UPDATE is refused outright by `NoUpdate`: a re-binding is a remove plus a fresh register.
 *
 * @param db - The closed strand's database (the member already exists).
 * @param params - The member's own keypair and the peer id to bind.
 * @throws If `MemberPeer.Authorized`/`MemberExists` rejects (wrong signer, or no
 *   matching `Member` row); the insert rolls back, leaving no `MemberPeer` row.
 */
export async function registerMemberPeer(db: Database, params: RegisterMemberPeerParams): Promise<void> {
  const { memberKeyPair, peerId } = params;
  const memberKey = memberKeyPair.publicKeyB64;

  if (await memberPeerExists(db, memberKey, peerId)) {
    log('MemberPeer (%s, %s) already present; skipping', memberKey, peerId);
    return;
  }

  const payload = `${memberKey}|${peerId}`;
  const signature = signStrandPayload(payload, memberKeyPair.privateKeyB64);
  await db.exec(
    `insert into Strand.MemberPeer (MemberKey, PeerId)
       with context Signature = ?, ManagerKey = null, ManagerSignature = null
       values (?, ?)`,
    [signature, memberKey, peerId],
  );
  log('Registered MemberPeer (%s, %s)', memberKey, peerId);
}

/**
 * Yield every `PeerId` bound to `memberKey`, re-comparing the member key in JavaScript.
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
async function* scanMemberPeerIds(db: Database, memberKey: string): AsyncGenerator<string> {
  // NOTE: because the predicate is not pushed down, the storage layer walks the WHOLE
  // MemberPeer table (every member's rows) per call and the SQL engine filters. Fine at
  // strand scale; if MemberPeer ever grows large, the fix is a reliable composite-key
  // seek, not a bigger scan.
  // NOTE: if a secondary index on MemberPeer.MemberKey is ever added, this query stops
  // being a scan and becomes an index seek — re-introducing the seek dependency this
  // shape exists to remove.
  for await (const row of db.eval(
    'select MemberKey, PeerId from Strand.MemberPeer where MemberKey = ?',
    [memberKey],
  )) {
    if (row.MemberKey === memberKey) {
      yield row.PeerId as string;
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
  for await (const peerId of scanMemberPeerIds(db, memberKey)) {
    peerIds.push(peerId);
  }
  return peerIds;
}

/**
 * True iff a `MemberPeer` row already exists for this `(MemberKey, PeerId)`.
 *
 * NOTE: check-then-write is not atomic. Two nodes registering the same
 * (MemberKey, PeerId) concurrently can both observe "absent"; the primary key is the
 * real backstop. This guard is for the sequential restart / re-register path.
 */
async function memberPeerExists(db: Database, memberKey: string, peerId: string): Promise<boolean> {
  for await (const found of scanMemberPeerIds(db, memberKey)) {
    if (found === peerId) {
      return true;
    }
  }
  return false;
}

/** Parameters for the SELF branch of {@link removeMemberPeer}. */
export interface RemoveOwnPeerParams {
  /**
   * The member's OWN strand keypair. Its `publicKeyB64` is the `MemberPeer.MemberKey`
   * of the row being deleted, and it signs the same untagged `MemberKey || '|' || PeerId`
   * payload registration signs — the self branch of `MemberPeer.Authorized` verifies
   * against the row's own member key, so no OTHER member's row is reachable this way.
   *
   * Because insert and delete share that payload, a captured registration approval also
   * authorizes the matching delete, and constraint context travels with the write out to
   * the strand's peers. The exposure is availability only (the binding is re-registerable,
   * and no other member's row is reachable); domain/action tagging for this branch is
   * tracked by the `bug-strand-approval-domain-separation` ticket alongside the schema's
   * other untagged approvals.
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
   * seated in the same transaction cannot authorize); it signs the remove-tagged
   * digest over the exact row.
   */
  managerKeyPair: Ed25519KeyPair;
  /** The `MemberPeer.MemberKey` whose binding is being cleared. */
  memberKey: string;
  /** The `PeerId` of the binding to delete. */
  peerId: string;
}

/**
 * Either shape accepted by {@link removeMemberPeer}. A discriminated union rather than
 * one opaque keypair: the two branches sign DIFFERENT payloads (untagged self vs
 * remove-tagged manager), so each case carries exactly the fields its payload needs.
 */
export type RemoveMemberPeerParams = RemoveOwnPeerParams | RemoveMemberPeerByManagerParams;

/**
 * Delete a `MemberPeer` binding — either the member clearing its own, or a manager
 * clearing another member's.
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
 * remove any member". It verifies the remove-tagged
 * `digest('Strand.MemberPeer', 'remove', old.MemberKey, old.PeerId)` against a
 * `committed.Manager` row, so a captured registration signature (untagged payload) can
 * never be replayed as a removal.
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

  // Delete-if-present mirrors registerMemberPeer's insert-if-absent, so a repeated or
  // restarted cleanup is a quiet no-op rather than a silent zero-row "success" that the
  // caller cannot distinguish from a real one.
  if (!(await memberPeerExists(db, memberKey, peerId))) {
    log('MemberPeer (%s, %s) already absent; skipping', memberKey, peerId);
    return;
  }

  if ('memberKeyPair' in params) {
    await deleteOwnMemberPeer(db, params);
  } else {
    await deleteMemberPeerByManager(db, params);
  }

  // NOTE: the delete's `where` puts an equality on BOTH composite-PK columns, which the
  // optimystic vtab module serves via a single-key seek that can MISS on a networked
  // strand (see memberPeerExists' doc). A missed seek deletes zero rows and still
  // reports success — a silent no-op on the very cleanup path this writer exists to
  // provide. The re-check turns that into a loud failure. Tracked as
  // `debt-composite-pk-point-lookup-unreliable-untracked`; this is an availability
  // failure mode, never a security one (a miss removes nothing, it never over-removes).
  if (await memberPeerExists(db, memberKey, peerId)) {
    throw new Error(`MemberPeer (${memberKey}, ${peerId}) still present after delete`);
  }
  log('Removed MemberPeer (%s, %s)', memberKey, peerId);
}

/** The self branch: the owning member signs the untagged registration payload. */
async function deleteOwnMemberPeer(db: Database, params: RemoveOwnPeerParams): Promise<void> {
  const { memberKeyPair, peerId } = params;
  const memberKey = memberKeyPair.publicKeyB64;
  const signature = signStrandPayload(`${memberKey}|${peerId}`, memberKeyPair.privateKeyB64);
  await db.exec(
    `delete from Strand.MemberPeer
       with context Signature = ?, ManagerKey = null, ManagerSignature = null
       where MemberKey = ? and PeerId = ?`,
    [signature, memberKey, peerId],
  );
}

/** The manager branch: a manager signs the remove-tagged digest over the target row. */
async function deleteMemberPeerByManager(db: Database, params: RemoveMemberPeerByManagerParams): Promise<void> {
  const { managerKeyPair, memberKey, peerId } = params;
  const signature = signStrandMemberPeerRemoval(memberKey, peerId, managerKeyPair.privateKeyB64);
  await db.exec(
    `delete from Strand.MemberPeer
       with context Signature = null, ManagerKey = ?, ManagerSignature = ?
       where MemberKey = ? and PeerId = ?`,
    [managerKeyPair.publicKeyB64, signature, memberKey, peerId],
  );
}

// ── Manager rotation (add / remove RBAC admins) ───────────────────────────────

/** Parameters for {@link addManager}. */
export interface AddManagerParams {
  /**
   * An EXISTING manager's strand keypair. Its `publicKeyB64` must already be a
   * `Strand.Manager` row (the existing-manager branch of `Manager.Authorized`
   * rejects a non-manager once the founder manager exists); it signs the new
   * manager key and is bound as `context.ManagerKey`.
   */
  byManagerKeyPair: Ed25519KeyPair;
  /** The member key to promote — the new `Manager.MemberKey` row. */
  newManagerKey: string;
}

/**
 * Promote a member to `Manager` on the signature of an existing manager.
 *
 * The promotion branch of `Manager.Authorized` requires the authorizer to be a
 * `Manager` row of STRICTLY SMALLER `Generation` than the new row, verifying
 * `digest(new.MemberKey || '|' || new.Generation)` against `context.ManagerKey`.
 * So this writer reads the authorizer's generation, seats the new manager at that
 * value + 1 (the natural successor; the schema enforces only the strict ordering),
 * and signs `` `${newManagerKey}|${generation}` `` — the generation is inside the
 * signed payload, so a captured promotion cannot be replayed at a different
 * generation, and the insert payload differs from the delete payload (which stays
 * the bare target key — see {@link removeManager}).
 *
 * The strict ordering — not this writer — is what makes a same-transaction takeover
 * impossible; the `Manager.Generation` column comment in `schemas/strand.qsql` carries
 * that argument. All this writer owes it is a generation strictly above the
 * authorizer's, inside the signed payload.
 *
 * When the authorizer has NO `Manager` row (a non-manager signer, or an open
 * strand with no managers at all), the lookup finds nothing and the writer falls
 * back to generation 1 and issues the insert anyway — deliberately letting the
 * SCHEMA be the rejector (`Manager.Authorized` / `OnlyClosed`), not a
 * writer-thrown error, so enforcement is pinned where it actually lives.
 *
 * @param db - The closed strand's database (founder manager already seated).
 * @param params - The authorizing manager's keypair and the new manager key.
 * @throws If `Manager.Authorized` rejects; the insert rolls back.
 */
export async function addManager(db: Database, params: AddManagerParams): Promise<void> {
  const { byManagerKeyPair, newManagerKey } = params;
  // NOTE: a single-key point lookup. On a NETWORKED strand, key seeks have missed
  // for rows that exist (the memberPeerExists guard scans for exactly that reason);
  // a miss here falls back to generation 1 and the schema then spuriously rejects a
  // legitimate promotion by a generation >= 1 authorizer — an availability failure,
  // never a security one. If that ever bites, re-shape this to a scan-and-filter.
  const authorizerRow = await db.get(
    'select Generation from Strand.Manager where MemberKey = ?',
    [byManagerKeyPair.publicKeyB64],
  );
  // NOTE: +1 saturates at Number.MAX_SAFE_INTEGER, where the successor compares equal
  // to its authorizer and the schema rejects. Unreachable while generations only ever
  // grow by 1 from 0, but the schema enforces ordering, not adjacency, so a manager may
  // seat a successor at any larger value; if arbitrary generations ever become writable
  // from outside this function, clamp or reject here rather than emitting a dead row.
  const generation = authorizerRow == null ? 1 : Number(authorizerRow.Generation) + 1;
  const signature = signStrandPayload(`${newManagerKey}|${generation}`, byManagerKeyPair.privateKeyB64);
  await db.exec(
    `insert into Strand.Manager (MemberKey, Generation)
       with context ManagerKey = ?, Signature = ?
       values (?, ?)`,
    [byManagerKeyPair.publicKeyB64, signature, newManagerKey, generation],
  );
  log('Added manager %s (generation %d) by %s', newManagerKey, generation, byManagerKeyPair.publicKeyB64);
}

/** Parameters for {@link removeManager}. */
export interface RemoveManagerParams {
  /**
   * The keypair authorizing the removal, bound as `context.ManagerKey` and
   * signing `digest(targetManagerKey)`. For an ADMIN removal this is a DIFFERENT
   * existing manager (satisfying the existing-manager branch); for a
   * SELF-resignation it is the target's OWN keypair (`publicKeyB64 ===
   * targetManagerKey`, satisfying the former-manager self branch). The same
   * context construction satisfies whichever branch applies — see
   * {@link removeManager}.
   */
  byManagerKeyPair: Ed25519KeyPair;
  /** The `Manager.MemberKey` row to delete. */
  targetManagerKey: string;
}

/**
 * Remove a `Manager` row — either an admin removing a different manager or a
 * manager resigning itself.
 *
 * Both delete-side branches of `Manager.Authorized` sign the same payload — the
 * bare target key, `digest(old.MemberKey = targetManagerKey)` — so a single
 * context construction serves both:
 * - **Admin removal**: `byManagerKeyPair` is a different existing manager; the
 *   removal branch verifies the signature against `A.MemberKey =
 *   context.ManagerKey`. Deliberately NO generation condition: a later-generation
 *   manager may remove an earlier-generation one (generation is lineage, not
 *   privilege), and deletes are safe once inserts are — every accepting branch
 *   requires a `Manager` row in the post-image, and the promotion branch's
 *   generation ordering keeps attacker rows out of it. Note the delete payload
 *   differs from the insert payload (which also carries the generation), so an
 *   "add X" signature no longer doubles as a "remove X" signature — a partial
 *   narrowing of `bug-strand-manager-authority-antireplay`, not its closure
 *   (a captured REMOVAL signature is still replayable as a removal).
 * - **Self-resignation**: `byManagerKeyPair` IS the target (its `publicKeyB64`
 *   equals `targetManagerKey`); the former-manager self branch verifies
 *   `old.MemberKey = context.ManagerKey` and the self-signature over `old.MemberKey`.
 *
 * The caller selects the case purely by which keypair it passes — no branching here.
 *
 * The optimystic bootstrap-mode transactor evaluates deferred (subquery-bearing)
 * CHECK constraints on DELETE as well as INSERT, so `Manager.Authorized` — deferred —
 * IS enforced here: a signer that is neither an existing manager nor the target
 * itself is rejected at commit.
 *
 * THE LAST MANAGER CANNOT BE REMOVED. `Manager.MinOneManager` (`check on delete`,
 * deferred, so it sees the POST-delete count) rejects any delete that would leave the
 * strand with zero managers — an admin-less closed strand could never admit anyone
 * again, since `Invite`, `addMemberByManager`, and `addManager` all require a
 * `Manager` row. The bootstrap branch of `Manager.Authorized` is now gated to INSERTs
 * (`old.MemberKey is null`), so it no longer waives the signature check on a delete
 * that drops the count toward the floor: a second-to-last removal is authorized
 * exactly like any other.
 *
 * HAND-OFF ORDER: a sole manager transferring control must ADD the successor FIRST
 * and resign SECOND. A same-transaction delete-then-insert swap is rejected — the
 * bootstrap branch is gated to the founding state (at most one `Member`), and the
 * successor's insert has no other manager to authorize it once the sole manager's
 * row is gone.
 *
 * Cross-node caveat: `MinOneManager` counts rows visible to THIS transaction, so two
 * nodes concurrently removing different managers can each see a survivor and still
 * converge to zero. Noted in the schema; a cross-node floor is not attempted here.
 *
 * @param db - The closed strand's database.
 * @param params - The authorizing keypair and the target manager key.
 * @throws If `Manager.Authorized` rejects (a signer that is neither another existing
 *   manager nor the target itself) or `Manager.MinOneManager` rejects (the removal
 *   would leave no managers); the delete rolls back.
 */
export async function removeManager(db: Database, params: RemoveManagerParams): Promise<void> {
  const { byManagerKeyPair, targetManagerKey } = params;
  const signature = signStrandPayload(targetManagerKey, byManagerKeyPair.privateKeyB64);
  await db.exec(
    `delete from Strand.Manager
       with context ManagerKey = ?, Signature = ?
       where MemberKey = ?`,
    [byManagerKeyPair.publicKeyB64, signature, targetManagerKey],
  );
  log('Removed manager %s by %s', targetManagerKey, byManagerKeyPair.publicKeyB64);
}
