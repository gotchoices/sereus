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
 * The empty-table state satisfies the `count(1) from Member <= 1` bootstrap branch
 * of `Member.Authorized`, so no manager signature is needed — the context fields
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
       with context ManagerKey = null, ManagerSignature = null
       values (?)`,
    [memberKey],
  );
  log('Inserted founding Member for strand %s', strandId);
}

/**
 * Insert the founding `Strand.Manager` if no manager exists yet.
 *
 * The empty-table state satisfies the `count(1) from Manager <= 1` bootstrap
 * branch of `Manager.Authorized`, so no signature is needed. Idempotent via the
 * same count guard. Must run AFTER the Header insert: `Manager.OnlyClosed` is a
 * deferred (subquery) check evaluated at commit, and the sequential auto-commit
 * Header→Member→Manager order ensures the closed `Header` is committed first.
 */
async function insertFounderManagerIfAbsent(db: Database, memberKey: string, strandId: string): Promise<void> {
  if (await strandTableCount(db, 'Manager') > 0) {
    log('Manager already present for strand %s; skipping founder Manager', strandId);
    return;
  }
  await db.exec(
    `insert into Strand.Manager (MemberKey)
       with context ManagerKey = null, Signature = null
       values (?)`,
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
         with context ManagerKey = null, ManagerSignature = null
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
 * The constraint verifies `digest(new.Key)` against a `Manager` row matching
 * `context.ManagerKey`, so the payload is just the member key (no `'|'` join).
 * No `ConsumedInvite` is involved: this is the path a manager uses to seat a
 * member it already trusts (e.g. a manager-side enrollment that admits a
 * party already authorised out-of-band).
 *
 * @param db - The closed strand's database.
 * @param params - The admitting manager keypair and the new member key.
 * @throws If `Member.Authorized` rejects (e.g. a non-manager key); the insert
 *   rolls back, leaving no `Member` row.
 */
export async function addMemberByManager(db: Database, params: AddMemberByManagerParams): Promise<void> {
  const { managerKeyPair, memberKey } = params;
  const signature = signStrandPayload(memberKey, managerKeyPair.privateKeyB64);
  await db.exec(
    `insert into Strand.Member (Key)
       with context ManagerKey = ?, ManagerSignature = ?
       values (?)`,
    [managerKeyPair.publicKeyB64, signature, memberKey],
  );
  log('Admitted member %s by manager %s', memberKey, managerKeyPair.publicKeyB64);
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
 * Out of scope: peer DELETION. The schema's `MemberExists` reads `new.MemberKey`,
 * which is null on delete, so a `MemberPeer` delete is currently rejected by the
 * schema (noted in the `apply-strand-membership-schema` review). Removing a peer
 * would need a schema tweak (e.g. `coalesce(new.MemberKey, old.MemberKey)` in
 * `MemberExists`), so no `removeMemberPeer` is provided here.
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
       with context Signature = ?
       values (?, ?)`,
    [signature, memberKey, peerId],
  );
  log('Registered MemberPeer (%s, %s)', memberKey, peerId);
}

/**
 * True iff a `MemberPeer` row already exists for this `(MemberKey, PeerId)`.
 *
 * Deliberately does NOT filter on the full composite primary key. `MemberPeer`'s PK
 * is `(MemberKey, PeerId)`, so a `where MemberKey = ? and PeerId = ?` predicate puts
 * an equality on BOTH key columns — which the optimystic virtual-table module reports
 * as fully handled and serves via a single-key point lookup (one `find` descent), with
 * the SQL engine adding no filter of its own. On a networked strand that descent is not
 * reliable: a miss returns zero rows for a row that provably exists, the guard answers
 * `false`, and `registerMemberPeer` re-inserts a duplicate.
 *
 * Filtering on only the LEADING key column is a partial PK match, which the same module
 * explicitly declines to handle — it falls through to a table scan and the SQL engine
 * applies `MemberKey = ?` itself. No seek is involved, so no seek can miss. Both columns
 * are then re-compared here in JavaScript, so correctness depends only on the scan
 * returning a SUPERSET of the matching rows — the weakest possible assumption about the
 * storage layer. The `where` clause is a size optimization, not a correctness dependency:
 * a dropped or mis-applied predicate cannot produce a false positive (e.g. a different
 * member that happens to have registered the same `PeerId`).
 */
async function memberPeerExists(db: Database, memberKey: string, peerId: string): Promise<boolean> {
  // NOTE: this scans one member's peers per registerMemberPeer call. Fine at
  // member × devices scale; if MemberPeer ever grows large per member, the fix is a
  // reliable composite-key seek, not a bigger scan.
  // NOTE: if a secondary index on MemberPeer.MemberKey is ever added, this query stops
  // being a scan and becomes an index seek — re-introducing the seek dependency this
  // shape exists to remove.
  // NOTE: check-then-insert is not atomic. Two nodes registering the same
  // (MemberKey, PeerId) concurrently can both observe "absent"; the primary key is the
  // real backstop. This guard is for the sequential restart / re-register path.
  for await (const row of db.eval(
    'select MemberKey, PeerId from Strand.MemberPeer where MemberKey = ?',
    [memberKey],
  )) {
    if (row.MemberKey === memberKey && row.PeerId === peerId) {
      return true;
    }
  }
  return false;
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
 * The existing-manager branch of `Manager.Authorized` verifies
 * `digest(coalesce(new.MemberKey, old.MemberKey))` — `new.MemberKey` =
 * `newManagerKey` on insert — against a `Manager` row matching
 * `context.ManagerKey`. So the signer signs the new manager key directly (no
 * `'|'` join) and binds itself as `context.ManagerKey`.
 *
 * Once the founder manager exists, the schema's `(select count(1) from Manager)
 * <= 1` bootstrap shortcut no longer applies to a second add (at commit the count
 * includes the new row, so it is ≥ 2), so this genuinely exercises signature
 * verification — a non-manager signer, or a signature over the wrong key, is
 * rejected.
 *
 * @param db - The closed strand's database (founder manager already seated).
 * @param params - The authorizing manager's keypair and the new manager key.
 * @throws If `Manager.Authorized` rejects; the insert rolls back.
 */
export async function addManager(db: Database, params: AddManagerParams): Promise<void> {
  const { byManagerKeyPair, newManagerKey } = params;
  const signature = signStrandPayload(newManagerKey, byManagerKeyPair.privateKeyB64);
  await db.exec(
    `insert into Strand.Manager (MemberKey)
       with context ManagerKey = ?, Signature = ?
       values (?)`,
    [byManagerKeyPair.publicKeyB64, signature, newManagerKey],
  );
  log('Added manager %s by %s', newManagerKey, byManagerKeyPair.publicKeyB64);
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
 * On a DELETE, `coalesce(new.MemberKey, old.MemberKey)` binds `old.MemberKey =
 * targetManagerKey` (there is no `new` row), so the signed payload is the target
 * key for BOTH accepting branches of `Manager.Authorized`, and a single context
 * construction serves both:
 * - **Admin removal**: `byManagerKeyPair` is a different existing manager; the
 *   existing-manager branch verifies the signature against `A.MemberKey =
 *   context.ManagerKey`.
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
 * KNOWN SCHEMA HAZARD (not guarded here): even with enforcement, `Manager.
 * Authorized`'s `(select count(1) from Manager) <= 1` bootstrap branch is true at
 * commit whenever a delete drops the count to ≤ 1, so removing the strand's LAST (or
 * second-to-last) manager would be accepted regardless of signature — and removing
 * the last one orphans the strand (no one can ever add another). The schema does not
 * prevent this; a "min-one-manager" invariant is deferred to a future schema change
 * rather than grown into this writer.
 *
 * @param db - The closed strand's database.
 * @param params - The authorizing keypair and the target manager key.
 * @throws If `Manager.Authorized` rejects (e.g. a non-manager admin removal
 *   while > 2 managers remain); the delete rolls back.
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
