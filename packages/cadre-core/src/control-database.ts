import debug from 'debug';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { Database, registerPlugin } from '@quereus/quereus';
import type { VTablePluginInfo, FunctionPluginInfo, SqlParameters, SqlValue } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import { digest, randomBytes } from '@optimystic/quereus-plugin-crypto';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { StrandRow, JoinRequestRow, JoinOutcome, PendingJoin, PeerAddressRecord, CadrePeerRow, OwnerKeyRow, RevocationRow, RevocationLedgerOpenResult, DeviceTokenRecord, DeviceTokenRow, PushPlatform, CadreInviteRow, CadreInviteUsageRow, CadreInviteRedemptionResult, CadreInviteStatus, SeedPeer } from './types.js';
import { CONTROL_SCHEMA } from './control-schema.js';
import { canonicalDatetime } from './canonical-datetime.js';
import { controlAuthorizationFields, cadreInviteRowFields, CONTROL_TABLES } from './control-authorization.js';
import type { ControlTable, RevocableTable, ControlDomain, ControlAction, CadreInviteSignedFields } from './control-authorization.js';
import { ed25519PublicKeyB64FromPeerId, requireEd25519PublicKeyB64 } from './ed25519-key.js';
import { verifyCadreInviteRow } from './peer-authorization.js';
import { retryControlWrite, SCHEMA_INIT_RETRY_POLICY } from './control-write-retry.js';
import type { ControlWriteRetryOptions } from './control-write-retry.js';
import { isCohortUnreachableRead, retryControlRead } from './control-read-retry.js';
import type { ControlReadRetryOptions } from './control-read-retry.js';
import { chainMessages } from './control-retry.js';
import type { ControlRetryAbandonment } from './control-retry.js';

export type { ControlTable, RevocableTable, ControlDomain, ControlAction } from './control-authorization.js';

const log = debug('sereus:cadre:control-db');
const timing = debug('sereus:cadre:timing');

/**
 * Generate a unique stamp ID for transaction authorization.
 * Format: 32 bytes base64url encoded
 * - First 16 bytes: SHA-256 hash of peer ID (for distributed uniqueness)
 * - Last 16 bytes: Random bytes (for collision resistance)
 */
export function generateStampId(peerId: string): string {
  // Hash the peer ID and get first 16 bytes (128 bits). A purely local ID
  // generator: never signed/verified against SQL, so the framed single-field
  // digest is fine (the changed framing is not cross-checked anywhere).
  const peerIdHash = digest([peerId], 'sha256', 'bytes') as Uint8Array;
  const peerIdHashPart = peerIdHash.slice(0, 16);

  // Generate 16 random bytes
  const randomPart = randomBytes(128, 'bytes') as Uint8Array;

  // Combine peer ID hash and random bytes
  const combined = new Uint8Array(32);
  combined.set(peerIdHashPart, 0);
  combined.set(randomPart, 16);

  // Convert to base64url
  return uint8ArrayToString(combined, 'base64url');
}

/**
 * A `FormationUsage` was to be recorded against a host `Strand` row that is not
 * present locally.
 *
 * Consent is bound to the strand's one-off `StampId` (see the consent branch of
 * `Strand.AuthorizedInsert`), so the writer must read the live row before inserting.
 * The ordinary "host strand has not converged on this responder yet" case is caught
 * earlier and reported as `missing` by `ControlFormationUsageRecorder.resolveStrand`;
 * reaching here means the row vanished between that check and the write, which is a
 * genuine race and is surfaced rather than left to fail the deferred `StrandExists`
 * CHECK at commit (which would drop the write with a far less legible error).
 */
export class MissingHostStrandError extends Error {
  constructor(readonly strandId: string, readonly token: string) {
    super(`Cannot record formation usage for token ${token}: host strand ${strandId} is not present`);
    this.name = 'MissingHostStrandError';
  }
}

/**
 * A formation write was abandoned because the caller's `AbortSignal` fired BEFORE the
 * `FormationUsage` insert was issued — the invite's single use is NOT spent.
 *
 * Thrown by the formation write paths ({@link ControlDatabase.recordFormationUsage},
 * {@link ControlDatabase.redeemInvitation}) and by `ControlFormationUsageRecorder`'s
 * pre-approval checks when the responder's provisioning budget expires while the work is
 * still queued (e.g. behind the write lock) or still asking the approval hook. Never
 * thrown once the insert has been issued: a half-issued write must be allowed to land,
 * and the formation listener's settle grace then adopts it as a successful join. The
 * manager rethrows this error instead of mapping it to a retryable conflict — the
 * listener's timeout path owns the reply.
 */
export class FormationAbortedError extends Error {
  constructor(
    readonly token: string,
    operation: string,
    options?: { cause?: unknown }
  ) {
    super(`Formation ${operation} for token ${token} was aborted before its write was issued`, options);
    this.name = 'FormationAbortedError';
  }
}

/**
 * The invitation's seat budget is already spent: the count of recorded usage rows for the
 * invitation has reached its `TotalUses`, so this redemption cannot be given a seat. `token`
 * is the `FormationInvite.Token` or the `CadreInvite.Key`, whichever table the caller
 * redeemed against.
 *
 * Raised off the committed-count check ({@link ControlDatabase.assertSeatRemains}) ahead of
 * the write, inside {@link ControlDatabase.redeemInvitation} /
 * {@link ControlDatabase.recordFormationUsage}, off the same check for a cadre invitation
 * ({@link ControlDatabase.redeemCadreInvite}), and off the unlocked pre-check
 * `ControlFormationUsageRecorder.authorizeUsage` runs before the manager issues a membership
 * pass — and off nothing else. It exists because
 * without it the refusal surfaces as a generic `CHECK constraint failed: Authorized` from the
 * schema's own count-based cap clause, which the manager reports as a retryable
 * `Formation conflict, retry` — telling the joiner to retry something that can never succeed.
 * Two redemptions of one token racing on the SAME node serialize behind the local write
 * queue, so the loser reads the winner's committed row and is refused here by name —
 * `StrandFormationManager.validateToken`'s `isTokenUsed` check cannot catch that, since it
 * ran before either redemption wrote anything.
 */
export class InvitationExhaustedError extends Error {
  constructor(
    readonly token: string,
    readonly usesRecorded: number,
    readonly totalUses: number,
  ) {
    super(
      `Invitation ${token} is exhausted: ${usesRecorded} of ${totalUses} use(s) already recorded`
    );
    this.name = 'InvitationExhaustedError';
  }
}

/**
 * {@link ControlDatabase.seatCadreInvite} was refused by `CadreInvite.AuthorizedInsert`: the
 * row's `IssuerKey` is not an owner on THIS node, or its `IssuerSig` does not verify. The
 * common cause is the first — the issuing owner's `OwnerKey` row has not replicated here yet,
 * or that owner has since been removed — which is why the redemption protocol maps this to a
 * retryable code; a tampered row fails the same way and simply never succeeds.
 */
export class CadreInviteIssuerUnknownError extends Error {
  constructor(
    readonly inviteKey: string,
    readonly issuerKey: string,
    options?: { cause?: unknown }
  ) {
    super(
      `Cadre invitation ${inviteKey} cannot be seated here: its issuer ${issuerKey} is not an owner on this node, or its signature does not verify`,
      options
    );
    this.name = 'CadreInviteIssuerUnknownError';
  }
}

/** The refusal {@link CadreInviteIssuerUnknownError} wraps — the constraint named, as the engine words it. */
const CADRE_INVITE_UNAUTHORIZED = /CHECK constraint failed: AuthorizedInsert\b/;

/**
 * What a recorded `FormationUsage` row came out as.
 *
 * `usageStampId` is echoed back so a caller that obtained an approver sign-off can prove the
 * nonce it signed over is the one that landed — the two must match or
 * `FormationUsage.Authorized` rejects the row (see {@link formationVouchMessage}).
 */
export interface FormationUsageResult {
  /** The single-use nonce written to `UsageStampId` (the row's primary key) — the caller's, or a freshly minted one. */
  usageStampId: string;
}

/**
 * Parse a stored Quereus `datetime` value into epoch milliseconds.
 *
 * Quereus canonicalises a `datetime` column to a bare UTC `PlainDateTime` string
 * (e.g. `2026-06-04T12:34:56`, no `Z`). JS `Date` reads a timezone-less
 * date-time as LOCAL, so we append `Z` when no offset/zone is present to keep the
 * value anchored to UTC. Numbers (already epoch ms) pass through.
 */
function parseStoredDatetimeMs(value: string | number): number {
  if (typeof value === 'number') return value;
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(value);
  return new Date(hasZone ? value : `${value}Z`).getTime();
}

/**
 * Parse a nullable stored `datetime` column into epoch ms, mapping both "absent"
 * and "unparseable" to null — i.e. "no expiry". Shared by every `ExpiresAt`
 * reader so the NaN guard cannot drift between them.
 */
function parseNullableStoredDatetimeMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = parseStoredDatetimeMs(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Build the canonical authorization message that owner signatures are bound to.
 *
 * The message is a SINGLE framed SHA-256 digest over the ordered field vector from
 * {@link controlAuthorizationFields} (the crypto plugin's injective multi-field
 * encoding): two fixed literals — the domain tag naming the table rule and the action
 * tag — followed by the row fields in the schema's fixed order, with the single-use
 * StampId as the final field where the table has one:
 *
 *   message = sha256(encodeFields([domain, action, field_1, ..., StampId]))   // raw digest bytes
 *
 * ed25519 signs these raw digest bytes DIRECTLY (no second hash). The SQL constraints
 * verify the identical bytes with one variadic call
 * (`verify(digest('CadreControl.X', 'add', field_1, ...), context.Signature, A.Key, 'ed25519')`):
 * SQL `digest(...)` returns the base64url string of the same digest, which `verify`'s default
 * base64url input encoding decodes back to those raw bytes — so signer and verifier
 * operate on the same bytes. Every field is TEXT on both sides (the SQL columns are
 * `cast(... as text)` / `coalesce(...,'')`; the TS args are strings), so the per-field
 * type tags agree. Binding the row contents closes captured-stamp replay; the leading
 * domain/action tags scope the signature to ONE table rule, so an approval minted for
 * one constraint can never satisfy another (e.g. a ValidationKey enrollment can no
 * longer double as an OwnerKey enrollment). Single source of truth: every signed writer
 * (and every test/harness signer) MUST build the message through this function with the
 * schema's tags and field order, or `verify` will reject the row.
 */
export function buildAuthorizationMessage(
  domain: ControlDomain,
  action: ControlAction,
  rowFields: string[],
): Uint8Array {
  return digest(controlAuthorizationFields(domain, action, rowFields), 'sha256', 'bytes') as Uint8Array;
}

/**
 * The exact bytes an outside approver signs to authorize ONE redemption of a
 * `ValidationUrl`-bearing `FormationInvite` — the TS mirror of the `'vouch'` digest in
 * `FormationUsage.Authorized`, in the schema's field order.
 *
 * The approval covers the whole redemption: the invitation (`token`), the single-use nonce
 * the JOINING peer minted for THIS redemption (`usageStampId`), the network being joined
 * (`strandId`), the joining peer's own ed25519 public key (`peerKey`), and the disclosure
 * text. That makes it non-transferable — an approval cannot be re-presented for another use
 * of the same invitation, another network, or another joiner — and the nonce's `unique`
 * column makes a verbatim re-presentation a duplicate-row rejection. The joiner mints the
 * nonce ({@link generateStampId}) and sends it in its contact message; sign these bytes over
 * that same nonce, then pass BOTH the nonce and the signature to
 * {@link ControlDatabase.redeemInvitation} / {@link ControlDatabase.recordFormationUsage}:
 * signing one nonce and inserting another fails the CHECK.
 */
export function formationVouchMessage(fields: {
  token: string;
  usageStampId: string;
  strandId: string;
  peerKey: string;
  disclosure: string;
}): Uint8Array {
  return buildAuthorizationMessage('CadreControl.FormationUsage', 'vouch', [
    fields.token, fields.usageStampId, fields.strandId, fields.peerKey, fields.disclosure,
  ]);
}

/**
 * The exact bytes the JOINING peer signs to consent to ONE redemption of a
 * `FormationInvite` — the TS mirror of the `'consent'` digest in the schema's
 * `FormationUsage.PeerConsented` constraint, in its field order.
 *
 * A sibling of {@link formationVouchMessage}, not a replacement: the approver's vouch
 * says the redemption may proceed, this says the joiner itself agreed to it, and the
 * two are signed by different keys over the same nonce so neither can stand in for
 * the other. Verify the result with `peer-authorization.ts`'s
 * `verifyFormationConsent`, whose `formationConsentDigest` is the base64url twin of
 * this vector — the two must stay in lockstep.
 *
 * `strandId` is deliberately absent, unlike its vouch sibling: the joiner cannot know
 * the strand when it signs (a bound invite's host strand arrives only in the result
 * frame; an unbound strand is minted by the responder). The responder cannot
 * substitute one anyway — a bound invite is pinned to its own strand by `Authorized`,
 * and an unbound redemption mints a fresh strand, so there is no victim to name.
 */
export function formationConsentMessage(fields: {
  token: string;
  usageStampId: string;
  peerKey: string;
  disclosure: string;
}): Uint8Array {
  return buildAuthorizationMessage('CadreControl.FormationUsage', 'consent', [
    fields.token, fields.usageStampId, fields.peerKey, fields.disclosure,
  ]);
}

/**
 * The exact bytes an owner signs to seat a `CadreInvite` row — the TS mirror of the `'add'`
 * digest in `CadreInvite.AuthorizedInsert`, over the whole row in the schema's order with
 * nullable columns as `''` (`cadreInviteRowFields`, shared with the base64url verifier
 * `peer-authorization.ts`'s `cadreInviteAddDigest`). `expiresAt` must already be the stored
 * canonical `datetime` string ({@link canonicalDatetime}), as {@link ControlDatabase.insertCadreInvite}
 * produces it, or the signed segment will not match what the CHECK sees after coercion.
 */
export function cadreInviteAddMessage(row: CadreInviteSignedFields): Uint8Array {
  return buildAuthorizationMessage('CadreControl.CadreInvite', 'add', cadreInviteRowFields(row));
}

/** The fields both redemption signatures cover; see {@link cadreInviteRedeemMessage}. */
export interface CadreInviteRedemptionFields {
  inviteKey: string;
  /** The single-use nonce the redeeming device minted for this redemption (`generateStampId`). */
  usageStampId: string;
  /** The redeeming device's own ed25519 public key (base64url). */
  peerKey: string;
}

/**
 * The exact bytes the HOLDER of a cadre invitation signs, with the invitation's private key,
 * to redeem it once — the TS mirror of the `'redeem'` digest `CadreInviteUsage.InvitePossessed`
 * verifies against the invitation's public key. Binding the device and the nonce means a
 * captured redemption can admit no other device and spend no other use.
 */
export function cadreInviteRedeemMessage(fields: CadreInviteRedemptionFields): Uint8Array {
  return buildAuthorizationMessage('CadreControl.CadreInviteUsage', 'redeem', [
    fields.inviteKey, fields.usageStampId, fields.peerKey,
  ]);
}

/**
 * The exact bytes the DEVICE signs, with its own key, to consent to being admitted by one
 * redemption — the TS mirror of the `'consent'` digest `CadreInviteUsage.PeerConsented`
 * verifies against `PeerKey`. Same fields as {@link cadreInviteRedeemMessage} under a
 * distinct action tag, so neither signature can stand in for the other.
 */
export function cadreInviteConsentMessage(fields: CadreInviteRedemptionFields): Uint8Array {
  return buildAuthorizationMessage('CadreControl.CadreInviteUsage', 'consent', [
    fields.inviteKey, fields.usageStampId, fields.peerKey,
  ]);
}

/**
 * Minimal interface for the CollectionFactory returned by the optimystic plugin.
 * We only need the methods we actually use.
 */
interface CollectionFactory {
  registerLibp2pNode(networkName: string, node: Libp2p, coordinatedRepo: IRepo): void;
  shutdown(): Promise<void>;
}

/** Result of registering the optimystic plugin */
interface OptimysticPluginResult {
  collectionFactory: CollectionFactory;
  vtables: VTablePluginInfo[];
  functions: FunctionPluginInfo[];
  /**
   * Hydrate Quereus's in-memory catalog from persisted optimystic vtab schemas.
   * Must run BEFORE applying CONTROL_SCHEMA on a warm restart so the declarative
   * diff sees the existing tables and skips re-emitting CREATE TABLE / CREATE INDEX
   * for each persisted control object. Idempotent; `{ tables: 0, indexes: 0 }` on a
   * cold/in-memory start. Mirrors the strand path's hydrate-before-apply (see
   * compose-strand.ts).
   */
  hydrate: (db: Database) => Promise<{ tables: number; indexes: number }>;
  [key: string]: unknown;
}

/** Runtime guard for the dynamic-`from` count, over the one table list. */
const CONTROL_TABLE_SET: ReadonlySet<ControlTable> = new Set<ControlTable>(CONTROL_TABLES);

/** Primary-key column of each {@link RevocableTable}. */
type GuardedKeyColumn = 'Key' | 'Id' | 'PeerId';

/**
 * Which column identifies one row of each guarded table — the ONLY place that mapping
 * lives, so a stamp read and the delete that binds to it can never disagree about it.
 * Derived rather than passed: every guarded table has exactly one primary key, so a
 * `(table, keyColumn)` pair on a signature is a mismatch waiting to happen.
 */
const GUARDED_KEY_COLUMN: Readonly<Record<RevocableTable, GuardedKeyColumn>> = {
  OwnerKey: 'Key',
  CadrePeer: 'PeerId',
  ValidationKey: 'Key',
  Strand: 'Id',
  StrandPartyKey: 'Id',
  JoinedStrand: 'Id',
  JoinRequest: 'Id',
  DeviceToken: 'PeerId',
  CadreInvite: 'Key',
};

/**
 * A guarded table an owner may remove a row from. `CadreInvite` is excluded by design — its
 * rows are never deleted (`NoDelete`), and withdrawing one is a tombstone alone
 * ({@link ControlDatabase.withdrawCadreInvite}).
 */
type RemovableTable = Exclude<RevocableTable, 'CadreInvite'>;

/**
 * One row incarnation's owner-signed removal, ready for {@link ControlDatabase.execGuardedRemoval}:
 * the row's own `'remove'` signature over (key, stamp), and the tombstone's separate
 * `Revocation` signature over (table, key, stamp). Retiring a stamp is permanent and
 * party-wide, so the delete's signature deliberately does not cover it; the digests are
 * domain-separated and neither replays as the other.
 */
interface GuardedRemoval {
  readonly ref: RevokedRowRef & { readonly tableName: RemovableTable };
  readonly signature: string;
  readonly revocationSignature: string;
}

/**
 * The exact bytes an owner signs to append one `Revocation` tombstone — `Revocation.Authorized`
 * binds the whole (TableName, RowKey, StampId) row under its own domain tag. Shared by every
 * tombstone writer (a guarded removal, a `CadreInvite` withdrawal, the ledger marker) so the
 * field order lives in one place; the base64url verifier is `peer-authorization.ts`'s
 * `revocationDigest`.
 */
function revocationTombstoneMessage(ref: { tableName: string; rowKey: string; stampId: string }): Uint8Array {
  return buildAuthorizationMessage('CadreControl.Revocation', 'remove', [ref.tableName, ref.rowKey, ref.stampId]);
}

/**
 * The exact bytes an owner signs to seat a further `OwnerKey` row (the signed-add branch of
 * `OwnerKey.Authorized`); the base64url twin is `peer-authorization.ts`'s `ownerKeyAddDigest`.
 */
function ownerKeyAddMessage(key: string, stampId: string): Uint8Array {
  return buildAuthorizationMessage('CadreControl.OwnerKey', 'add', [key, stampId]);
}

function signGuardedRemoval(
  tableName: RemovableTable,
  rowKey: string,
  stampId: string,
  signMessage: (message: Uint8Array) => string
): GuardedRemoval {
  const ref = { tableName, rowKey, stampId };
  return {
    ref,
    signature: signMessage(buildAuthorizationMessage(`CadreControl.${tableName}`, 'remove', [rowKey, stampId])),
    revocationSignature: signMessage(revocationTombstoneMessage(ref)),
  };
}

/** The control tables keyed by a strand id whose repeat insert a caller may treat as idempotent. */
type StrandIdTable = Extract<RevocableTable, 'Strand' | 'JoinedStrand'>;

/** The control tables keyed by an `Id` column whose repeat insert a caller may classify. */
type IdKeyedTable = StrandIdTable | Extract<RevocableTable, 'JoinRequest'>;

/**
 * The rejection a second insert of an already-seated id into `table` produces, as the
 * optimystic vtab words it (`uniqueConstraintMessage`, qualified by table name only — no
 * schema prefix, matching `test/control-constraint-helpers.ts`'s `expectUniqueViolation`).
 *
 * Each table's `StampId` is unique too, but a fresh stamp is minted per insert attempt, so
 * only the primary key can collide on a repeat insert. Matching the column explicitly
 * keeps any OTHER uniqueness failure out of the caller's idempotency branch.
 */
function idConflictPattern(table: IdKeyedTable): RegExp {
  return new RegExp(`UNIQUE constraint failed: ${table}\\.Id\\b`, 'i');
}

/**
 * Did this write to `table` fail because the strand id is already seated there?
 *
 * {@link CadreNode.publishStrand} uses this to tell "my own earlier publish already
 * landed" (re-read, and no-op when the row matches) apart from every other rejection —
 * an unauthorized signer, a retired stamp — which must keep surfacing. For `JoinedStrand`
 * the same test tells "another machine of this party already published this join" apart.
 *
 * Matched by TEXT, not by type: the typed engine error does not survive the trip out of
 * optimystic (same constraint the retry classifiers in `control-write-retry.ts` document).
 * Fails CLOSED — a rewording upstream turns the idempotent branch back into the raw
 * uniqueness error the caller saw before, never into a silent overwrite. The
 * `publish-strand.spec.ts` repeat-publish cases assert against the live engine error, so a
 * reword reddens there.
 */
export function isStrandIdConflict(error: unknown, table: StrandIdTable): boolean {
  return errorChainMatches(error, idConflictPattern(table));
}

/**
 * Did {@link ControlDatabase.insertJoinRequest} fail because the party already holds a
 * `JoinRequest` row for this invitation? The caller adopts the existing request instead.
 * Text-matched, failing closed, like {@link isStrandIdConflict}.
 *
 * NOTE: the existing row may be one {@link ControlDatabase.queryPendingJoin} hides (its stamp
 * is retired and no reap pass has removed it yet), so an adopting re-read can come back empty
 * until the next reap pass.
 */
export function isPendingJoinConflict(error: unknown): boolean {
  return errorChainMatches(error, idConflictPattern('JoinRequest'));
}

/**
 * The `JoinRequest.Id` of an invitation: the base64url sha256 `digest` of its token. One row
 * per invitation, and the `Revocation` tombstone that names a removed row carries this, never
 * the bearer token itself.
 */
export function pendingJoinId(token: string): string {
  return digest([token], 'sha256', 'base64url') as string;
}

/** A `JoinRequest` row as written: every column but the stamp, which each write mints. */
export type JoinRequestFields = Omit<JoinRequestRow, 'StampId'>;

/** A pending join as re-written: its request fields and its outcome, under a stamp the write mints. */
export type PendingJoinFields = Omit<PendingJoin, 'StampId'>;

/**
 * A pending-join write found that the live join is not the one the caller read: another write
 * recorded an outcome, asked again or dismissed it first. Nothing was written; the caller
 * decides again from `live`, which is null when the request is gone.
 */
export class PendingJoinChangedError extends Error {
  constructor(
    readonly id: string,
    readonly live: PendingJoin | null,
  ) {
    super(`Pending join ${id} changed: ${live === null ? 'no request' : `request ${live.StampId}, ${live.outcome?.kind ?? 'pending'}`}`);
    this.name = 'PendingJoinChangedError';
  }
}

/**
 * The one `CadreControl.Revocation` row that retires nothing, filed once by an owner
 * ({@link ControlDatabase.openRevocationLedger}) so the table is never a never-written
 * block. The schema's table comment says why that matters and why the row can never read
 * as a retirement; `RowIsGone` pins this exact triple.
 */
export const REVOCATION_LEDGER_MARKER = {
  tableName: 'Revocation',
  rowKey: 'ledger',
  stampId: 'opened',
} as const;

/**
 * The rejection a second insert of the ledger marker produces: the optimystic vtab's
 * primary-key wording (see {@link idConflictPattern}), naming both columns of
 * `Revocation`'s composite key. Applied only to the marker's own insert, whose key
 * ('Revocation', 'opened') no row but the marker can hold (`RowIsGone`), and `Revocation`
 * has no other unique constraint.
 */
const REVOCATION_LEDGER_CONFLICT = /UNIQUE constraint failed: Revocation\.TableName, Revocation\.StampId\b/i;

/** Did the ledger marker's insert fail because the marker is already filed? Text-matched, failing closed, like {@link isStrandIdConflict}. */
function isRevocationLedgerConflict(error: unknown): boolean {
  return errorChainMatches(error, REVOCATION_LEDGER_CONFLICT);
}

/** Whether any message in `error`'s cause chain matches `pattern`; false for a non-`Error`. */
function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && chainMessages(error).some(message => pattern.test(message));
}

/**
 * Project `CadrePeer` rows into the {@link SeedPeer} list a seed, or a cadre invitation
 * redemption reply, carries.
 *
 * Owner identity is sourced from the `OwnerKey` table, not from the transport peer id. An
 * Ed25519 libp2p peer id embeds its public key (identity multihash), so each peer's ed25519
 * key is derivable from its `PeerId`; a peer is an owner iff that derived key is in
 * `ownerKeys`. This makes any owner node markable — not just the local one. A non-Ed25519
 * or unparsable id yields a non-owner rather than failing the whole projection.
 *
 * NOTE: this is the one owner lookup deliberately left on the REPLICATED table rather than
 * the node-local anchor. `SeedPeer.isOwner` is a dial hint — the receiver dials owner-flagged
 * peers first — not a trust decision, and the receiver re-derives real trust from its own
 * anchor. So a polluted table costs at most a wasted dial, while anchoring here would
 * silently drop legitimate co-owners this node never pinned. If `isOwner` ever gates
 * anything the receiver TRUSTS, move it to the anchor.
 */
export function projectSeedPeers(rows: readonly CadrePeerRow[], ownerKeys: ReadonlySet<string>): SeedPeer[] {
  return rows.map(({ peerId, multiaddr }) => {
    const pubKeyB64 = ed25519PublicKeyB64FromPeerId(peerId);
    const isOwner = pubKeyB64 !== null && ownerKeys.has(pubKeyB64);
    return {
      peerId,
      multiaddrs: multiaddr ? multiaddr.split(',') : [],
      isOwner,
      ...(isOwner ? { publicKey: pubKeyB64 } : {}),
    };
  });
}

/**
 * The conditions a cadre invitation must still meet to be redeemed, short of its use count:
 * not withdrawn, unexpired (`expiresAt <= now` is expired, as the redemption refuses it),
 * and issued by a current owner. Shared by {@link ControlDatabase.hasLiveCadreInvite},
 * {@link ControlDatabase.isCadreInviteLive} and {@link ControlDatabase.listCadreInviteStatuses}
 * so they cannot drift from each other, or from `CadreInviteUsage.Authorized`.
 */
function cadreInviteStillOpen(
  row: { stampId: string; issuerKey: string; expiresAt: string | null },
  withdrawn: ReadonlySet<string>,
  owners: ReadonlySet<string>,
  nowMs: number
): boolean {
  if (withdrawn.has(row.stampId) || !owners.has(row.issuerKey)) {
    return false;
  }
  const expiresAtMs = parseNullableStoredDatetimeMs(row.expiresAt);
  return expiresAtMs === null || expiresAtMs > nowMs;
}

/**
 * Guarded tables a node may reap locally once their tombstone has committed — the
 * tables whose `AuthorizedDelete` carries the REAP branch (see the constraint comment on
 * `CadrePeer.AuthorizedDelete` in the schema). `Strand` and `StrandPartyKey` are
 * deliberately absent: their rows carry `MemberPrivateKey` / `PrivateKey` — party
 * secrets stored nowhere else (tickets/backlog/debt-strand-tombstone-reap.md owns any
 * future change). `JoinedStrand` also carries a `MemberPrivateKey` but IS reapable: that
 * secret is the joined strand's shared read key, which its founding party and every member
 * hold, so a reaped row is recoverable by re-forming. `JoinRequest` is reapable for the same
 * reason: the inviting party and the user also hold its invitation. `OwnerKey` has no
 * production removal path and `MinOneOwner` makes an automated owner-key reap a
 * party-bricking hazard. `CadreInvite` is never deleted at all (its tombstone is a
 * withdrawal over a row that stays), so there is nothing to reap.
 */
export const REAPABLE_TABLES = ['CadrePeer', 'DeviceToken', 'ValidationKey', 'JoinedStrand', 'JoinRequest'] as const satisfies readonly RevocableTable[];
export type ReapableTable = (typeof REAPABLE_TABLES)[number];

/**
 * Runtime membership test for {@link REAPABLE_TABLES}, narrowing a tombstone's
 * `TableName` to the subset {@link ControlDatabase.reapRevokedRow} accepts. A tombstone
 * naming an excluded table (`Strand`, `OwnerKey`, `CadreInvite`) is skipped silently —
 * `Strand` tombstones are the common case in a party that has unpublished a strand, so a
 * log line per skip would be per-pass noise.
 */
const REAPABLE_TABLE_SET: ReadonlySet<RevocableTable> = new Set<RevocableTable>(REAPABLE_TABLES);
const isReapableTable = (table: RevocableTable): table is ReapableTable => REAPABLE_TABLE_SET.has(table);

/** Every `CadreInvite` column, in the order {@link cadreInviteRowOf} reads them; callers append their `where`. */
const CADRE_INVITE_SELECT_SQL = 'select Key, PeerId, GrantsOwner, ExpiresAt, TotalUses, IssuerKey, IssuerSig, StampId from CadreControl.CadreInvite';

/**
 * A stored `CadreInvite` row as a {@link CadreInviteRow}. `ExpiresAt` is kept as the
 * engine-canonical string it reads back as — the form the `'add'` signature covers — never
 * parsed to ms here; `GrantsOwner` is the schema's 0/1 integer.
 */
function cadreInviteRowOf(row: Record<string, SqlValue>): CadreInviteRow {
  return {
    key: row.Key as string,
    peerId: (row.PeerId as string | null) ?? null,
    grantsOwner: Number(row.GrantsOwner) === 1,
    expiresAt: row.ExpiresAt == null ? null : String(row.ExpiresAt),
    totalUses: (row.TotalUses as number | null) ?? null,
    issuerKey: row.IssuerKey as string,
    issuerSig: row.IssuerSig as string,
    stampId: row.StampId as string,
  };
}

/** A stored `CadreInviteUsage` row as a {@link CadreInviteUsageRow}. */
function cadreInviteUsageRowOf(row: Record<string, SqlValue>): CadreInviteUsageRow {
  return {
    usageStampId: row.UsageStampId as string,
    inviteKey: row.InviteKey as string,
    peerId: row.PeerId as string,
    peerKey: row.PeerKey as string,
    peerStampId: row.PeerStampId as string,
    ownerStampId: (row.OwnerStampId as string | null) ?? null,
    inviteSig: row.InviteSig as string,
    peerSig: row.PeerSig as string,
  };
}

/** A `JoinedStrand` row as a {@link StrandRow}; the schema's `KnownType` check backs the `Type` cast. */
function joinedStrandRow(row: Record<string, SqlValue>): StrandRow {
  return {
    Id: row.Id as string,
    MemberPrivateKey: row.MemberPrivateKey as string | null,
    Type: row.Type as 'o' | 'c',
    FounderOwnerKey: null,
  };
}

const JOIN_REQUEST_INSERT_SQL = `
  insert into CadreControl.JoinRequest (Id, Invitation, Disclosure, RequestedAt, ExpiresAt, StampId)
    with context OwnerKey = ?, Signature = ?
    values (?, ?, ?, ?, ?, ?)
`;

const JOIN_SUCCESS_INSERT_SQL = `
  insert into CadreControl.JoinSuccess (RequestStampId, RecordedAt, StrandId, MembershipInvite)
    with context OwnerKey = ?, Signature = ?
    values (?, ?, ?, ?)
`;

const JOIN_FAILURE_INSERT_SQL = `
  insert into CadreControl.JoinFailure (RequestStampId, RecordedAt, Code, Reason)
    with context OwnerKey = ?, Signature = ?
    values (?, ?, ?, ?)
`;

/**
 * A request with its outcome in one statement: the outcome tables are keyed by the request's
 * stamp, so the join finds exactly this incarnation's outcome.
 */
const PENDING_JOIN_SELECT_SQL = `
  select R.Id, R.Invitation, R.Disclosure, R.RequestedAt, R.ExpiresAt, R.StampId,
         S.RecordedAt as JoinedAt, S.StrandId, S.MembershipInvite,
         F.RecordedAt as FailedAt, F.Code, F.Reason
    from CadreControl.JoinRequest R
      left join CadreControl.JoinSuccess S on S.RequestStampId = R.StampId
      left join CadreControl.JoinFailure F on F.RequestStampId = R.StampId
`;

/** A {@link PENDING_JOIN_SELECT_SQL} row as read. */
function pendingJoinOf(row: Record<string, SqlValue>): PendingJoin {
  return {
    Id: row.Id as string,
    Invitation: row.Invitation as string,
    Disclosure: row.Disclosure as string,
    RequestedAt: row.RequestedAt as number,
    ExpiresAt: row.ExpiresAt as number,
    StampId: row.StampId as string,
    outcome: joinOutcomeOf(row),
  };
}

/** The outcome half of a {@link PENDING_JOIN_SELECT_SQL} row; a request never has both (`JoinSuccess.NoFailure`, `JoinFailure.NotJoined`). */
function joinOutcomeOf(row: Record<string, SqlValue>): JoinOutcome | null {
  if (typeof row.JoinedAt === 'number') {
    return { kind: 'joined', RecordedAt: row.JoinedAt, StrandId: row.StrandId as string, MembershipInvite: row.MembershipInvite as string | null };
  }
  if (typeof row.FailedAt === 'number') {
    return { kind: 'failed', RecordedAt: row.FailedAt, Code: row.Code as string, Reason: row.Reason as string };
  }
  return null;
}

/** The fields `JoinRequest.AuthorizedInsert` signs, in the schema's order; integers sign as their text. */
function joinRequestAddFields(row: JoinRequestRow): string[] {
  return [row.Id, row.Invitation, row.Disclosure, String(row.RequestedAt), String(row.ExpiresAt), row.StampId];
}

/** A statement with its parameters, signed and ready to run. */
interface SignedStatement {
  readonly sql: string;
  readonly params: SqlValue[];
}

/**
 * The owner-signed insert of `outcome` for the request incarnation `requestStampId`: the
 * `JoinSuccess` / `JoinFailure` row and the signature its `AuthorizedInsert` verifies, over the
 * row's columns in the schema's order (a null column signs as `''`, an integer as its text).
 */
function signJoinOutcomeInsert(
  requestStampId: string,
  outcome: JoinOutcome,
  ownerKey: string,
  signMessage: (message: Uint8Array) => string
): SignedStatement {
  const at = String(outcome.RecordedAt);
  const { table, sql, fields, values } = outcome.kind === 'joined'
    ? {
        table: 'JoinSuccess' as const, sql: JOIN_SUCCESS_INSERT_SQL,
        fields: [requestStampId, at, outcome.StrandId, outcome.MembershipInvite ?? ''],
        values: [requestStampId, outcome.RecordedAt, outcome.StrandId, outcome.MembershipInvite],
      }
    : {
        table: 'JoinFailure' as const, sql: JOIN_FAILURE_INSERT_SQL,
        fields: [requestStampId, at, outcome.Code, outcome.Reason],
        values: [requestStampId, outcome.RecordedAt, outcome.Code, outcome.Reason],
      };
  const signature = signMessage(buildAuthorizationMessage(`CadreControl.${table}`, 'add', fields));
  return { sql, params: [ownerKey, signature, ...values] };
}

/**
 * Notified after a membership write (a `CadreControl.CadrePeer` or `OwnerKey` row, see
 * {@link ControlDatabase.mutateCadrePeer}) has COMMITTED.
 *
 * The one hook the party-membership snapshot a node admits control-DB traffic
 * against ({@link CadreNode.refreshMembershipGate}) hangs off, so that snapshot
 * is refreshed by the WRITE rather than by whoever remembered to ask. `reason`
 * only labels the log line. Must not reject (the notifier swallows and logs
 * anyway — a committed write never fails because a snapshot refresh did).
 */
export type MembershipChangeListener = (reason: string) => Promise<void>;

/**
 * Identity of the tombstone a committed guarded delete wrote — the triple a
 * {@link RevocationRow} is keyed and signed over. The counter is left out because a
 * fresh tombstone always seats it at 0 (`FreshTombstone`), and the signer pair because
 * the writer that files the row supplies it.
 */
export type RevokedRowRef = Pick<RevocationRow, 'tableName' | 'rowKey' | 'stampId'>;

/**
 * Notified after a guarded-table delete — and the `CadreControl.Revocation`
 * tombstone it writes in the same transaction — has COMMITTED.
 *
 * The seam the write-while-alone re-replication queue hangs off
 * ({@link CadreNode.noteGuardedDelete}): one listener covers every guarded table
 * because every owner delete funnels through {@link deleteGuardedRow} (or the
 * two-table `deleteStrandAndPartyKey`). Synchronous — the
 * handler only records the tombstone's identity; it must not throw (the notifier
 * swallows and logs anyway — a committed delete never fails because bookkeeping did).
 */
export type GuardedDeleteListener = (revocation: RevokedRowRef) => void;

/**
 * Notified when the control-write retry funnel GIVES UP on a local control write — the
 * classifier declined the failure as non-transient, or every attempt / the elapsed budget
 * ran out. Carries the operation label, how far it got and the error
 * ({@link ControlRetryAbandonment}).
 *
 * The seam that stops an abandoned BACKGROUND write from disappearing: those are `void`-ed
 * with a `debug`-only catch, and that namespace is off unless somebody set `DEBUG=`, so
 * without this the write, the operator and the embedding app all learn nothing. Synchronous
 * and must not throw — the retry loop swallows and logs if it does, because the write's own
 * failure is what has to reach the caller.
 */
export type ControlWriteAbandonedListener = (abandonment: ControlRetryAbandonment) => void;

export interface ControlDatabaseConfig {
  /** Party ID for the control network */
  partyId: string;
  /**
   * Optional path to the control schema file.
   * If not provided, uses the embedded schema for cross-platform compatibility.
   * Only use this if you need to override the default schema (e.g., for testing).
   */
  schemaPath?: string;
  /** Libp2p node for the control network (injected) */
  libp2pNode: Libp2p;
  /** Coordinated repo from the libp2p node */
  coordinatedRepo: IRepo;
}

/**
 * ControlDatabase manages the CadreControl schema using Quereus with Optimystic backend.
 * It provides typed query methods for accessing control network data.
 */
export class ControlDatabase {
  private db: Database | null = null;
  private collectionFactory: CollectionFactory | null = null;
  private readonly config: ControlDatabaseConfig;
  private initialized = false;
  private membershipListener: MembershipChangeListener | null = null;
  private guardedDeleteListener: GuardedDeleteListener | null = null;
  private controlWriteAbandonedListener: ControlWriteAbandonedListener | null = null;
  /** Tail of the local-write chain — see {@link withWriteLock}. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  /**
   * Locked write bodies currently running (see {@link runWriteBody}); what
   * {@link readRowsOnce} consults to route an unlocked read around a write that has
   * started but not yet opened its transaction. At most 1 while every writer takes the
   * lock — a count rather than a flag so it stays truthful if that ever stops holding.
   */
  private runningWriteBodies = 0;
  /**
   * Pacing seams for {@link lockedWithRetry}. Production leaves this empty (real backoff,
   * real clock); specs inject a recorded `sleep` / fake `now` so no test waits out a real
   * backoff. Applied OVER the call site's policy, so it overrides pacing without a spec
   * having to restate the policy's attempts or classifier.
   */
  private controlWriteRetryPacing: ControlWriteRetryOptions = {};
  /**
   * Pacing seams for {@link readRows}'s retry — the read twin of
   * {@link controlWriteRetryPacing}, with the same contract: production leaves this
   * empty, specs inject a recorded `sleep` / fake `now` so no test waits out a real
   * backoff. Applied OVER the read policy's defaults but UNDER the call site's `label`.
   */
  private controlReadRetryPacing: ControlReadRetryOptions = {};

  constructor(config: ControlDatabaseConfig) {
    this.config = config;
  }

  /**
   * Initialize the database - load schema and register plugins
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      log('ControlDatabase already initialized');
      return;
    }

    log('Initializing ControlDatabase for party: %s', this.config.partyId);

    // Create database instance
    this.db = new Database();

    // Register crypto plugin (provides digest, sign, verify functions)
    let t0 = performance.now();
    await registerPlugin(this.db, cryptoPlugin);
    timing('[controlDb] cryptoPlugin: %dms', Math.round(performance.now() - t0));
    log('Registered crypto plugin');

    // Register optimystic plugin with network transactor as default
    t0 = performance.now();
    const networkName = `control-${this.config.partyId}`;
    const pluginResult = optimysticPlugin(this.db, {
      default_transactor: 'network',
      default_key_network: 'libp2p',
      default_network_name: networkName,
      enable_cache: true,
    }) as unknown as OptimysticPluginResult;

    // Register vtables and functions manually since we need access to collectionFactory
    for (const vtable of pluginResult.vtables) {
      this.db.registerModule(vtable.name, vtable.module, vtable.auxData);
    }
    for (const func of pluginResult.functions) {
      this.db.registerFunction(func.schema);
    }
    timing('[controlDb] optimysticPlugin: %dms', Math.round(performance.now() - t0));

    this.collectionFactory = pluginResult.collectionFactory;

    // Inject the libp2p node into the collection factory
    t0 = performance.now();
    this.collectionFactory.registerLibp2pNode(
      networkName,
      this.config.libp2pNode,
      this.config.coordinatedRepo
    );
    timing('[controlDb] registerLibp2pNode: %dms', Math.round(performance.now() - t0));
    log('Registered libp2p node with collection factory');

    // Network-back the control tables. CONTROL_SCHEMA's `declare schema CadreControl
    // { table ... }` tables carry NO per-table `using optimystic(...)`, so storage is
    // chosen by the database's DEFAULT vtab. Routing the default to optimystic (with
    // the network transactor + this party's control network) is what makes a control
    // write replicate peer-to-peer — exactly what connectToStrand does for strand
    // tables (compose-strand.ts). Without these two calls the tables fall back to
    // Quereus's in-memory vtab and never converge across the cadre.
    this.db.setDefaultVtabName('optimystic');
    this.db.setDefaultVtabArgs({
      networkName,
      transactor: 'network',
      keyNetwork: 'libp2p',
    });
    log('Set default vtab to optimystic (networkName=%s, transactor=network)', networkName);

    // Hydrate Quereus's catalog from any persisted optimystic vtab schemas BEFORE
    // applying CONTROL_SCHEMA, so a warm restart with persistent storage diffs the
    // control DDL against the already-present tables and re-emits nothing — the same
    // warm-start regression connectToStrand's hydrate-before-apply guards against.
    // No-op on a cold / in-memory start (`{ tables: 0, indexes: 0 }`).
    t0 = performance.now();
    const hydrated = await pluginResult.hydrate(this.db);
    timing('[controlDb] hydrate: %dms (tables=%d, indexes=%d)',
      Math.round(performance.now() - t0), hydrated.tables, hydrated.indexes);
    log('Hydrated control catalog (tables=%d, indexes=%d)', hydrated.tables, hydrated.indexes);

    // Load and execute the schema
    // NOTE: this is where a slow launch is felt. Duration is (raw-storage operations
    // issued) × per-operation storage latency: ~1ms/op on an idle machine, but
    // 50-90ms/op on a loaded disk or a phone's flash under launch contention. A cold
    // start now reaches the backend 48 times (10 tables + 1 index, 23 distinct blocks
    // — dominated by its genuine writes), a warm restart 13, because cadre-core
    // wraps every embedder storage in `@optimystic/db-p2p`'s write-through cache
    // (@serfab/quereus-plugin-sereus's cached-storage.ts). Uncached the same start issued ~2000 operations — the
    // upstream re-read amplification measured in
    // tickets/complete/optimystic-block-read-amplification-on-control-start.md (and
    // its follow-up ...-schema-catalog-reread-per-write-blows-storage-budgets.md),
    // which also rules out the retry policy and cluster deadlines. The counts are
    // pinned by packages/cadre-core/test/control-start-storage-op-budget.spec.ts; if
    // they grow — e.g. the cache leaves this path — that spec fails before anyone
    // has to debug a launch.
    t0 = performance.now();
    await this.loadSchema();
    timing('[controlDb] loadSchema: %dms', Math.round(performance.now() - t0));

    this.initialized = true;
    log('ControlDatabase initialized successfully');
  }

  private async loadSchema(): Promise<void> {
    let schemaContent: string;

    if (this.config.schemaPath) {
      // Load from file if explicitly provided (for testing or custom schemas)
      // This only works in Node.js environments
      log('Loading schema from file: %s', this.config.schemaPath);

      // Check if we're in a Node.js environment
      if (typeof process !== 'undefined' && process.versions?.node) {
        try {
          // Use require to conditionally load fs only in Node.js.
          // This won't be bundled by React Native's Metro bundler — a dynamic
          // import() would be statically picked up by Metro, so require is
          // intentional here (cross-platform constraint, not lazy CommonJS).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require('fs/promises');
          schemaContent = await fs.readFile(this.config.schemaPath, 'utf-8');
        } catch (error) {
          throw new Error(
            `Failed to load schema from ${this.config.schemaPath}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
      } else {
        throw new Error(
          'Loading schema from file is not supported in React Native. ' +
          'Remove the schemaPath option to use the embedded schema instead.'
        );
      }
    } else {
      // Use embedded schema for cross-platform compatibility
      log('Using embedded control schema');
      schemaContent = CONTROL_SCHEMA;
    }

    // Schema init is a DISTRIBUTED write, so it gets the same bounded transient-failure
    // retry every other control write does ({@link lockedWithRetry}). Every CadreControl
    // table is optimystic-backed (the default vtab was routed to optimystic just above),
    // so each `create table` needs a super-majority of the party's peers to answer. On a
    // node joining a party that already has two live members a single unanswered peer
    // during any one create otherwise kills startup outright.
    //
    // Re-running the WHOLE `exec` after a partial failure is safe, and this is the
    // non-obvious part:
    //
    //  - `apply schema` is a DIFF, not a replay. Quereus collects the live catalog, diffs
    //    the declared schema against it, and only emits DDL for what is missing — which is
    //    exactly why `initialize` hydrates persisted optimystic schemas BEFORE getting here.
    //    A table the live catalog already lists generates no statements at all, which is what
    //    makes an apply over an already-complete schema (a warm start) a no-op.
    //    NOTE: a table the catalog lists with DIFFERENT constraint text diffs to
    //    `alter table ... drop constraint`, which the optimystic module refuses, so a store
    //    written by a build with older constraint text fails here on every start (policy:
    //    recreate, docs/architecture.md after the Control Network table). If backwards
    //    compatibility becomes a requirement, this apply is the migration site.
    //  - a failed apply is taken back WHOLE (Quereus 4.20.0). The migration loop keeps an
    //    undo journal; when a step fails it runs that journal in reverse, re-renders the
    //    catalog, compares it against a fingerprint taken BEFORE the apply, and only then
    //    rethrows the step's own error. So attempt 2 does not resume where attempt 1 died —
    //    it re-emits the whole schema, because the catalog is back where the apply started.
    //
    // Together: attempt 2 emits exactly the DDL the live catalog is missing, whatever
    // attempt 1 reached. No `if not exists` juggling, no per-table loop, no statement
    // splitting.
    //
    // That second bullet carries a dependency the pre-4.20.0 argument did not have. The
    // unwind Quereus performs is the CATALOG's; whether STORAGE follows it is the optimystic
    // plugin's doing. Quereus runs the forward steps, the undo steps and the verification
    // all inside the module's `beginSchemaBatch`/`endSchemaBatch` pair, and the plugin puts
    // each undo statement (`drop table`, `drop index if exists`) through its ordinary hooks
    // in that one write batch, then commits the restored state. On a plugin build WITHOUT
    // those batch hooks storage would be left holding objects the catalog no longer lists,
    // and the re-run would diff against a catalog that disagrees with the blocks. So this
    // argument is a statement about the pair, not about Quereus alone — pinned by
    // `test/control-schema-apply-unwind.spec.ts`.
    //
    // Only the "cohort did not answer, nothing committed" class is retried; the classifier
    // vetoes indeterminate commits and does not match `Missing block`, which is a durable
    // convergence fault a retry cannot heal (tracked separately) and must keep propagating.
    // The cases the unwind cannot cover — a failed undo statement, a post-unwind catalog
    // that does not match its fingerprint, an irreversible step — are retried deliberately
    // rather than vetoed; why, on `RETRIABLE_SCHEMA_INIT_MATCHERS`.
    //
    // This is the ONE call site on a non-default policy: the re-run safety argued above is
    // also what lets schema init absorb optimystic's self-coordination grace refusal, which
    // is unsafe for control writes in general. Why, on
    // `RETRIABLE_SCHEMA_INIT_MATCHERS` in `control-write-retry.ts`.
    await this.lockedWithRetry(() => this.db!.exec(schemaContent), SCHEMA_INIT_RETRY_POLICY, 'schema-init');
    log('Schema loaded and executed');
  }

  /**
   * One UNRETRIED drain of a control read to rows — every read in this class bottoms out
   * here (almost all via {@link readRows}, which adds the transient-failure retry), and
   * this is the ONE place the committed-read opt-in is spelled.
   *
   * Reached only through {@link readRows}, which drops straight here for the call sites
   * that pass `retry: false` — reads issued from INSIDE a locked write body, where a
   * backoff sleep would hold the write lock and the write funnel re-runs the read anyway
   * (see the NOTE on {@link readRows}).
   *
   * A control read normally queues on the database's exec mutex, so it does not answer
   * until whatever statement holds that mutex finishes. When a control WRITE is parked
   * against an unresponsive cohort member that is minutes, and a read that only wants
   * the last committed state waits the whole time for no reason
   * (`complete/control-reads-blocked-by-stalled-write`).
   *
   * Quereus's remedy is `readConcurrency: 'committed'` — a PER-CALL opt-in
   * (`Statement.tryRouteConcurrent` refuses anything that did not ask for it by name)
   * that runs an eligible read off the mutex against each table's last committed state.
   * Routing is best-effort and never an error: an ineligible statement falls back to
   * the serialized path silently — any side-effecting node, any table-valued function
   * call (pure ones included), any table whose module does not declare
   * `readCommittedSnapshot`, or an EXPLICIT transaction being open on this database.
   *
   * **It is asked for only while a write is in flight, and that condition is the whole
   * point.** The opt-in does not merely move the read off the mutex: it connects the
   * table with `_readCommitted`, and the optimystic vtab serves such a connection from
   * a pinned pre-transaction snapshot that NEVER refreshes from the network, where an
   * ordinary read calls `update()` on the collection first. Taking that path
   * unconditionally therefore trades "reads block behind a stalled write" for "reads
   * stop seeing what other machines wrote" — measured, not theorised: with every read
   * opted in, `control-write-degraded-cohort-member` could no longer observe a sibling
   * publishing its own `CadrePeer` row and failed at suite setup on two runs out of two.
   *
   * "A write is in flight" is {@link writeInFlight}, and it needs TWO signals because a
   * write is invisible to `getAutocommit()` for part of its life. `Database.exec` takes
   * the exec mutex first; the implicit transaction — the moment `getAutocommit()` turns
   * false — opens only after the write has acquired the mutex, planned the statement,
   * and awaited `begin()` on every connection. While the write WAITS for the mutex (a
   * serialized read holds it, say) it still reports autocommit, so a read routed on
   * `getAutocommit()` alone queued behind the write and answered only after its whole
   * commit — tens of seconds against a slow cohort member, which is what timed out the
   * degraded-cohort scenario's `isMember` read (verified against the engine directly;
   * `complete/control-read-queues-behind-a-write-waiting-for-the-database`). So an
   * UNLOCKED read also takes the committed path while any locked write body is running
   * ({@link runningWriteBodies}), which covers that queued window and everything else a
   * body does before its transaction opens. A read issued INSIDE a locked body
   * (`underWriteLock`) must not: that body is the one being counted, and its guard reads
   * need the refreshing path — so it keeps the transaction-only test.
   *
   * Both signals are sampled synchronously just before `eval`, which claims its place
   * on the mutex in that same tick, so the only race left is a body starting or ending
   * in between: a body that starts after the sample queues its statements BEHIND this
   * read, and one that ended before it has nothing left to queue behind.
   *
   * Residual gaps, both of which still queue a read behind a write:
   * - an EXPLICIT transaction ({@link inTransaction}) disqualifies the committed path in
   *   Quereus itself, so a read overlapping such a body's `COMMIT` falls back to the
   *   serialized path and waits for it;
   * - a writer that bypasses {@link withWriteLock} is not counted (in this repo only
   *   `reference-app-web`'s deliberately-rejected diagnostics insert does).
   *
   * What a committed read gives up is observing a write that has not finished
   * committing, and that is safe for every caller here: an AWAITED write is committed by
   * the time it returns, and a read inside {@link inTransaction} is disqualified by the
   * open explicit transaction and stays serialized, so it still sees its own
   * transaction's rows. A read after an UNAWAITED write on this database would be wrong
   * — no such caller exists, and {@link withWriteLock} is what keeps it that way.
   *
   * NOTE: counting whole bodies widens the stale (non-refreshing) window from "a
   * transaction is open" to "a locked body is running", which adds a body's pre-transaction
   * work and its post-commit tail (a `CadrePeer` write's membership-listener read). The
   * slow part of a write against a degraded cohort is its commit, already inside the old
   * window, so the added time is short; if a poller for replicated rows ever starves
   * behind back-to-back local writes, narrow the count to the span from a body's first
   * statement to its transaction opening.
   */
  private async readRowsOnce(sql: string, params: SqlParameters | undefined, underWriteLock: boolean): Promise<Record<string, SqlValue>[]> {
    let iterator: AsyncIterableIterator<Record<string, SqlValue>>;
    if (this.writeInFlight(underWriteLock)) {
      log('read-eval: a write is in flight (%s), asking for a committed read: %s',
        this.db!.getAutocommit() ? 'locked body running, no transaction open yet' : 'transaction open', sql);
      iterator = this.db!.eval(sql, params, { readConcurrency: 'committed' });
    } else {
      iterator = this.db!.eval(sql, params);
    }
    const rows: Record<string, SqlValue>[] = [];
    for await (const row of iterator) {
      rows.push(row);
    }
    return rows;
  }

  /**
   * Whether a control read should ask for a committed read — see {@link readRowsOnce}.
   * `getAutocommit()` reports the whole `Database` (the property
   * {@link assertCommitBoundary} leans on), so false means some writer's transaction is
   * open. An unlocked read also counts a running locked body that has not opened its
   * transaction yet; a read inside such a body does not, since it is that body.
   */
  private writeInFlight(underWriteLock: boolean): boolean {
    if (!this.db!.getAutocommit()) {
      return true;
    }
    return !underWriteLock && this.runningWriteBodies > 0;
  }

  /**
   * {@link readRowsOnce} plus the bounded transient-failure retry
   * ({@link retryControlRead}) — the funnel every UNLOCKED control read goes through, so a
   * read that failed because the cluster could not be asked properly (a stream reset
   * mid-scan, a partially unreachable cohort) is re-presented a moment later instead of
   * surfacing to every reader.
   *
   * MATERIALIZES the read rather than returning a lazy iterator, and that shape is what
   * makes the retry possible at all: the failure happens during ITERATION, not at call
   * time, and a half-consumed iterator cannot be retried without re-yielding rows the
   * caller already saw. Materializing is safe here — every caller either drains to an
   * array anyway or takes the first row of a statement that yields at most one (a
   * primary-key lookup or a `count(1)`); nothing streams.
   *
   * Each ATTEMPT is a fresh {@link readRowsOnce} call, so the committed-read opt-in
   * ({@link writeInFlight}) is re-evaluated per attempt — a write can finish between
   * attempts and change the right answer.
   *
   * The retry's budget ({@link CONTROL_READ_RETRY_BUDGET_MS}, 1.5 s) is deliberately far
   * under the write funnel's: the tightest caller deadline over a control read is the
   * inbound admission gate's 2 s FAIL-OPEN timeout, and a read that outlives it spends its
   * retries after the gate has already admitted (see `control-read-retry.ts`).
   *
   * `label` names the read in the retry loop's `Control read [<label>] …` debug lines and
   * nothing else; several reads are in flight concurrently in a real party, so an
   * unlabelled line cannot be attributed — keep new call sites labelled.
   *
   * `retry: false` drops straight to {@link readRowsOnce}: reads issued from INSIDE a
   * locked write body must not retry on their own. `retryControlWrite`'s contract is that
   * backoff sleeps happen with NO lock held; a read retrying its own backoff inside a
   * locked body would sleep holding the write lock (stalling every other local writer),
   * and the write funnel already re-runs the body's reads when it re-runs the body. See
   * {@link queryStampId} / {@link assertSeatRemains} / {@link queryCadrePeers} for the
   * per-call opt-outs.
   *
   * NOTE: nothing structural enforces that opt-out — it is per-call because an unlocked
   * read runs CONCURRENTLY with a locked body, so `this`-state cannot tell the two apart,
   * and there is no async-context primitive available on every target platform (browser,
   * React Native) to carry the answer. Reads reached through a CALLBACK invoked under the
   * lock are the easy miss: `notifyMembershipChanged` runs its listener with the lock
   * held, and its membership read is opted out at {@link queryCadrePeers}. If another
   * under-lock callback seam is ever added, audit its read graph the same way.
   */
  private readRows(
    sql: string,
    params: SqlParameters | undefined,
    label: string,
    retry = true
  ): Promise<Record<string, SqlValue>[]> {
    // `retry: false` marks the reads that may run inside a locked write body, which is
    // also what readRowsOnce's committed-read routing must know (see writeInFlight).
    // NOTE: the membership-gate refresh passes it on EVERY trigger, including the
    // unlocked ones (start, reconcile, seed-applied), so those keep the transaction-only
    // routing and can still queue behind a write waiting for the exec mutex (as before this
    // routing existed). Tolerable while its awaiting callers (reconcile, applySeed) carry no
    // tight deadline; if one ever does, pass the locked/unlocked distinction through instead.
    if (!retry) {
      return this.readRowsOnce(sql, params, true);
    }
    // The label lands LAST so the call site's name survives the spec-injected pacing —
    // it changes log attribution only, never behaviour (same layering as lockedWithRetry).
    return retryControlRead(
      () => this.readRowsOnce(sql, params, false),
      { ...this.controlReadRetryPacing, label }
    );
  }

  /**
   * Query all strands from the control database
   */
  async queryStrands(): Promise<StrandRow[]> {
    this.ensureInitialized();
    const results: StrandRow[] = [];
    for (const row of await this.readRows('select Id, MemberPrivateKey, Type, FounderOwnerKey from CadreControl.Strand', undefined, 'strands')) {
      results.push({
        Id: row.Id as string,
        MemberPrivateKey: row.MemberPrivateKey as string | null,
        Type: row.Type as 'o' | 'c',
        FounderOwnerKey: row.FounderOwnerKey as string | null,
      });
    }
    return results;
  }

  /**
   * Read a single strand row by id, or null when absent. Single-row sibling of
   * {@link queryStrands}; the responder uses it to read a host strand's
   * `MemberPrivateKey` (the closed-strand read-gating secret) for delivery to a
   * validated invitee during provision-then-record formation.
   */
  async queryStrand(strandId: string): Promise<StrandRow | null> {
    this.ensureInitialized();
    for (const row of await this.readRows(
      'select Id, MemberPrivateKey, Type, FounderOwnerKey from CadreControl.Strand where Id = ?',
      [strandId],
      'strand'
    )) {
      return {
        Id: row.Id as string,
        MemberPrivateKey: row.MemberPrivateKey as string | null,
        Type: row.Type as 'o' | 'c',
        FounderOwnerKey: row.FounderOwnerKey as string | null,
      };
    }
    return null;
  }

  /**
   * Every strand this party joined from another party (`CadreControl.JoinedStrand`), shaped
   * as a {@link StrandRow} so a reader can treat it like one of the party's own. A joiner
   * never founds, so `FounderOwnerKey` is always null. Read raw, like {@link queryStrands}:
   * no retired-stamp filter.
   */
  async queryJoinedStrands(): Promise<StrandRow[]> {
    this.ensureInitialized();
    const rows = await this.readRows('select Id, Type, MemberPrivateKey from CadreControl.JoinedStrand', undefined, 'joined-strands');
    return rows.map(joinedStrandRow);
  }

  /** Single-row sibling of {@link queryJoinedStrands}: the joined strand with this id, or null. */
  async queryJoinedStrand(strandId: string): Promise<StrandRow | null> {
    this.ensureInitialized();
    const rows = await this.readRows(
      'select Id, Type, MemberPrivateKey from CadreControl.JoinedStrand where Id = ?',
      [strandId],
      'joined-strand'
    );
    return rows.length === 0 ? null : joinedStrandRow(rows[0]!);
  }

  /**
   * Every join this party asked for and has not dismissed, pending or finished: each
   * `CadreControl.JoinRequest` row with its `JoinSuccess` / `JoinFailure` row.
   *
   * A request whose `StampId` is retired in `Revocation` is dropped, as {@link queryCadrePeers}
   * drops such rows: it is a re-asked or dismissed incarnation this node still holds until the
   * reap sweep removes it, or one re-seated by a replayed approval on a node that had not yet
   * seen the tombstone. Either way it must not bring a dismissed join back.
   */
  async queryPendingJoins(): Promise<PendingJoin[]> {
    this.ensureInitialized();
    const revoked = await this.queryRevokedStamps('JoinRequest');
    const rows = await this.readRows(PENDING_JOIN_SELECT_SQL, undefined, 'pending-joins');
    return rows.map(pendingJoinOf).filter(join => !revoked.has(join.StampId));
  }

  /** Single-row sibling of {@link queryPendingJoins}, with the same retired-stamp filter: the join with this id, or null. */
  async queryPendingJoin(id: string): Promise<PendingJoin | null> {
    this.ensureInitialized();
    const revoked = await this.queryRevokedStamps('JoinRequest');
    const join = await this.readPendingJoin(id, true);
    return join === null || revoked.has(join.StampId) ? null : join;
  }

  /** The raw read behind {@link queryPendingJoin}, with no retired-stamp filter. `retry: false` inside a locked write body. */
  private async readPendingJoin(id: string, retry: boolean): Promise<PendingJoin | null> {
    const rows = await this.readRows(`${PENDING_JOIN_SELECT_SQL} where R.Id = ?`, [id], 'pending-join', retry);
    return rows.length === 0 ? null : pendingJoinOf(rows[0]!);
  }

  /**
   * Count rows in a CadreControl table as seen by THIS database instance.
   *
   * `table` is validated against {@link CONTROL_TABLE_SET} before it is interpolated
   * into the `from` clause: the names are not user input, but the check keeps the
   * dynamic query off the injection surface and fails loudly on a typo instead of
   * emitting a malformed statement. The count reflects only the rows this node's
   * control DB has converged on — in the integration harness that is the owner
   * node (one ControlDatabase per party), i.e. the authoritative control-network
   * view, not a per-drone convergence guarantee.
   */
  async countRows(table: ControlTable): Promise<number> {
    this.ensureInitialized();
    if (!CONTROL_TABLE_SET.has(table)) {
      throw new Error(`Unknown CadreControl table: ${table}`);
    }
    for (const row of await this.readRows(`select count(1) as Count from CadreControl.${table}`, undefined, 'count-rows')) {
      return (row.Count as number) ?? 0;
    }
    return 0;
  }

  /**
   * Get the underlying database for advanced queries
   */
  getDatabase(): Database {
    this.ensureInitialized();
    return this.db!;
  }

  /**
   * Check whether any owner key exists in the control database.
   * Used to decide whether a fresh-party genesis insert is required.
   *
   * Deliberately RAW (no retired-stamp filter, unlike {@link getOwnerKeys}): the genesis
   * insert is refused by the schema whenever any physical row exists, so this must see one.
   */
  async hasOwnerKey(): Promise<boolean> {
    this.ensureInitialized();
    for (const row of await this.readRows('select count(1) as Count from CadreControl.OwnerKey', undefined, 'owner-key-exists')) {
      return (row.Count as number) > 0;
    }
    return false;
  }

  /**
   * Idempotent genesis: insert `key` as the founding owner key only when
   * the party has none yet. Returns true if it inserted, false if an owner
   * key already existed (so a repeat `--owner` start is a no-op).
   */
  async ensureOwnerKey(key: string): Promise<boolean> {
    this.ensureInitialized();
    const trimmed = requireEd25519PublicKeyB64(key, 'owner key');
    if (await this.hasOwnerKey()) {
      log('Owner key already present; skipping genesis insert');
      return false;
    }
    await this.insertOwnerKey(trimmed);
    return true;
  }

  /**
   * Collect every owner key (`CadreControl.OwnerKey.Key`) as a set.
   *
   * This is the steady-state trust anchor for seeds: a seed's signer key is
   * trusted only if it is already enrolled here (see `SeedTrustPolicy`). It is
   * also the owner-identity source for `queryPeers`, decoupling owner
   * status from the libp2p transport peer ID.
   *
   * Rows whose `StampId` is retired in `CadreControl.Revocation` are excluded, as
   * {@link queryCadrePeers} excludes them: `OwnerKey` is never reaped (`MinOneOwner` makes
   * an automated reap able to empty the table), so a node that received the tombstone
   * without the delete (a removal committed while the remover was alone, re-issued on growth)
   * keeps the removed owner's physical row next to it. Without the filter a removed owner
   * would still sign on its own node, still count as the issuer of a live invitation and
   * still be preferred as a dial target.
   *
   * `retry: false` from a caller that reads under the write lock, for the reason on
   * {@link queryCadrePeers}.
   */
  async getOwnerKeys(retry = true): Promise<Set<string>> {
    return new Set((await this.queryOwnerKeyRows(retry)).map(row => row.key));
  }

  /**
   * Every live `OwnerKey` row with its persisted proof ({@link OwnerKeyRow}) — what the
   * trusted-owner anchor sync derives from (`CadreNode.syncOwnerAnchor`). Rows whose
   * `StampId` is retired in `CadreControl.Revocation` are excluded here, as
   * {@link queryCadrePeers} excludes them and for the reason on {@link getOwnerKeys}, which
   * reads through this. A row with no stamp (the schema permits it; no writer produces one)
   * is dropped too: no proof can bind to it, so no reader could ever derive it.
   *
   * `retry: false` from the membership-gate refresh, which runs as the control database's
   * membership listener with that database's write lock held — the reason on
   * {@link queryCadrePeers}; both reads here take the flag.
   *
   * @param retired - the retired `OwnerKey` stamps, when the caller has already read the
   *   tombstones (`CadreNode.syncOwnerAnchor` reads {@link queryRevocations} for their
   *   signers); omitted, they are read here. Before the ledger marker is filed every
   *   `Revocation` read is a cohort consult, so the sync passing its own set keeps the
   *   membership refresh at one such read for the anchor.
   */
  async queryOwnerKeyRows(retry = true, retired?: ReadonlySet<string>): Promise<OwnerKeyRow[]> {
    this.ensureInitialized();
    const revoked = retired ?? await this.queryRevokedStamps('OwnerKey', retry);
    const rows: OwnerKeyRow[] = [];
    const sql = 'select Key, StampId, VouchOwner, VouchSig, VouchUsage from CadreControl.OwnerKey';
    for (const row of await this.readRows(sql, undefined, 'owner-keys', retry)) {
      const stampId = (row.StampId as string | null) ?? null;
      if (stampId === null) {
        log('queryOwnerKeyRows: dropping OwnerKey row %s with no StampId', row.Key);
        continue;
      }
      if (revoked.has(stampId)) {
        continue;
      }
      rows.push({
        key: row.Key as string,
        stampId,
        vouchOwner: (row.VouchOwner as string | null) ?? null,
        vouchSig: (row.VouchSig as string | null) ?? null,
        vouchUsage: (row.VouchUsage as string | null) ?? null,
      });
    }
    return rows;
  }

  /**
   * Enumerate the CadrePeer rows (cadre membership) for admin/membership reads.
   * Includes the persisted voucher columns, which
   * {@link CadreNode.listAuthorizedMembers} re-checks against its node-local anchor.
   *
   * Rows whose `StampId` is retired in `CadreControl.Revocation` are excluded HERE, so
   * every membership reader inherits the exclusion — a revoked peer is neither
   * authorizable nor addressable (a replayed row planted at a retired stamp must not
   * be RPC'd or handed out as an address). Reads the retired set through
   * {@link queryRevokedStamps} rather than inlining the SQL, so tests can interpose on
   * that seam to model the replicated live-row-plus-tombstone merge state.
   *
   * NOTE: runs a second query (the retired-stamp set) per call, on the membership-gate
   * refresh path. Its cost is storage consults, not rows (see {@link queryRevokedStamps}):
   * while `Revocation` has never been written every call consults the cohort about it, and
   * the ledger marker ({@link openRevocationLedger}) is what makes it a held block. Folding
   * the exclusion into one statement would not help (it reads the same block), and caching
   * the set would hide a tombstone arriving by replication.
   *
   * NOTE: this filter is HAND-MIRRORED by the gate suites' fake control databases
   * (`test/membership-gate-helpers.ts` and `test/cadre-node-authorized-surface.spec.ts`),
   * which feed the node rows directly. Nothing enforces that the copies stay true, so a
   * change to the filter's SHAPE here (what it keys on, which table it consults) must be
   * carried into both, or those suites keep passing against a contract the database no
   * longer honours. Fine while the filter is one `Set.has` on `StampId`; if it grows a
   * second dimension, give the fakes a shared fixture or a contract test instead.
   *
   * `retry: false` is passed by exactly one caller —
   * `CadreNode.refreshAuthorizedControlPeers`, the membership-gate snapshot refresh —
   * because {@link notifyMembershipChanged} invokes that listener with the write lock
   * HELD, and a retrying read there would sleep its backoff holding the lock (see the
   * NOTE on {@link readRows}). It costs nothing: that refresh is best-effort, keeps the
   * previous snapshot on failure, and is re-driven by the next write and by the timed
   * reconcile. BOTH of this method's reads take the flag — retrying either one under the
   * lock is the same defect.
   */
  async queryCadrePeers(retry = true): Promise<CadrePeerRow[]> {
    this.ensureInitialized();
    const revoked = await this.queryRevokedStamps('CadrePeer', retry);
    const rows: CadrePeerRow[] = [];
    for (const row of await this.readRows('select PeerId, Multiaddr, StampId, VouchOwner, VouchSig, VouchUsage from CadreControl.CadrePeer', undefined, 'cadre-peers', retry)) {
      const stampId = (row.StampId as string | null) ?? null;
      if (stampId !== null && revoked.has(stampId)) {
        continue;
      }
      rows.push({
        peerId: row.PeerId as string,
        multiaddr: (row.Multiaddr as string | null) ?? null,
        stampId,
        vouchOwner: (row.VouchOwner as string | null) ?? null,
        vouchSig: (row.VouchSig as string | null) ?? null,
        vouchUsage: (row.VouchUsage as string | null) ?? null,
      });
    }
    return rows;
  }

  /**
   * The cadre's peers as a seed or a redemption reply carries them: every live `CadrePeer`
   * row with its addresses, each flagged `isOwner` when the key behind its peer id is in
   * the replicated `OwnerKey` table ({@link projectSeedPeers}).
   *
   * Read through {@link queryCadrePeers}, never a raw `CadrePeer` select, so a removed
   * member's addresses are never packed into a seed or handed to a redeeming device as a
   * dial hint: a revoked peer is off the addressable surface everywhere, and this is one of
   * its exits.
   */
  async querySeedPeers(): Promise<SeedPeer[]> {
    return projectSeedPeers(await this.queryCadrePeers(), await this.getOwnerKeys());
  }

  /**
   * Every approver public key currently enrolled in `CadreControl.ValidationKey` — the
   * set a `ValidationUrl` redemption's approval signature must be signed by (see
   * {@link ControlFormationUsageRecorder}, which checks one key at a time via
   * {@link queryValidationKeyStampId}).
   *
   * Sorted in TypeScript rather than SQL so the order is stable regardless of storage
   * order; the enrolled set is a handful of keys, so the sort is free.
   */
  async queryValidationKeys(): Promise<string[]> {
    this.ensureInitialized();
    const keys: string[] = [];
    for (const row of await this.readRows('select Key from CadreControl.ValidationKey', undefined, 'validation-keys')) {
      keys.push(row.Key as string);
    }
    return keys.sort();
  }

  /**
   * Read one guarded row's single-use `StampId` nonce (null when the row does not
   * exist). Every owner-signed delete / re-touch path must bind its signature to the
   * row's CURRENT nonce, so they all read through here first.
   *
   * Deliberately RAW — no `Revocation` filtering (unlike {@link queryCadrePeers} /
   * {@link queryPeerRecord}): {@link deleteGuardedRow} and the insert-if-absent guard
   * in the `CadrePeer` upsert need to see a physically present row. Filtering here
   * would make an insert-if-absent guard read "absent" for a row that exists and
   * collide on the primary key.
   *
   * `table` and its {@link GUARDED_KEY_COLUMN} column are interpolated into the SQL; both
   * come from closed literal unions — no caller-supplied string can reach the statement
   * (same injection-surface discipline as {@link countRows}'s `CONTROL_TABLE_SET` guard).
   *
   * NOTE: `retry: false` is passed by exactly the call sites that run INSIDE a locked
   * write body — {@link deleteGuardedRow} and {@link insertCadrePeer}'s insert-if-absent
   * guard. A read retrying there would sleep its backoff HOLDING the write lock
   * (`retryControlWrite`'s contract is that backoff sleeps happen with no lock held), and
   * the write funnel already re-runs the body's reads when it re-runs the body. The
   * unlocked callers — the public stamp readers, {@link reauthorizeCadrePeer} and
   * {@link reapRevokedRow}, whose stamp reads run BEFORE their locks are taken — keep the
   * default retried path. Explicit per call rather than an ambient flag: unlocked reads
   * run concurrently with a locked body, so `this`-state cannot tell the two apart.
   */
  private async queryStampId(
    table: RevocableTable,
    keyValue: string,
    retry = true
  ): Promise<string | null> {
    this.ensureInitialized();
    const sql = `select StampId from CadreControl.${table} where ${GUARDED_KEY_COLUMN[table]} = ?`;
    for (const row of await this.readRows(sql, [keyValue], `stamp-${table}`, retry)) {
      return (row.StampId as string | null) ?? null;
    }
    return null;
  }

  /**
   * `CadrePeer` stamp nonce — read by {@link SeedBootstrapService.removePeer} as its
   * row-present gate before it delegates to {@link deleteCadrePeer}. The in-class
   * `CadrePeer` writers ({@link insertCadrePeer}, {@link reauthorizeCadrePeer}) go
   * straight to {@link queryStampId}.
   */
  queryCadrePeerStampId(peerId: string): Promise<string | null> {
    return this.queryStampId('CadrePeer', peerId);
  }

  /**
   * `DeviceToken` stamp nonce. {@link deleteDeviceToken} reads the stamp itself, so this
   * is the reader for callers that need to observe a live row's nonce — asserting a token
   * was seated, or that a removal retired the stamp it named.
   */
  queryDeviceTokenStampId(peerId: string): Promise<string | null> {
    return this.queryStampId('DeviceToken', peerId);
  }

  /** `Strand` stamp nonce — bound into {@link deleteStrand}'s remove digest. */
  queryStrandStampId(strandId: string): Promise<string | null> {
    return this.queryStampId('Strand', strandId);
  }

  /** `StrandPartyKey` stamp nonce — bound into {@link deleteStrandPartyKey}'s remove digest. */
  queryStrandPartyKeyStampId(strandId: string): Promise<string | null> {
    return this.queryStampId('StrandPartyKey', strandId);
  }

  /** `JoinedStrand` stamp nonce — bound into {@link deleteJoinedStrand}'s remove digest. */
  queryJoinedStrandStampId(strandId: string): Promise<string | null> {
    return this.queryStampId('JoinedStrand', strandId);
  }

  /**
   * Read THIS party's own strand membership private key (base64 protobuf; decode with
   * `strandMemberKeyPair`) for one strand, or null when no `StrandPartyKey` row exists.
   * The identity source the closed-strand founder bootstrap derives its `Member.Key` /
   * `Manager.MemberKey` from — deliberately NOT `Strand.MemberPrivateKey`, the
   * strand-wide read secret every joining party receives.
   */
  async queryStrandPartyKey(strandId: string): Promise<string | null> {
    this.ensureInitialized();
    for (const row of await this.readRows(
      'select PrivateKey from CadreControl.StrandPartyKey where Id = ?',
      [strandId],
      'strand-party-key'
    )) {
      return (row.PrivateKey as string | null) ?? null;
    }
    return null;
  }

  /** `ValidationKey` stamp nonce — bound into {@link deleteValidationKey}'s remove digest. */
  queryValidationKeyStampId(key: string): Promise<string | null> {
    return this.queryStampId('ValidationKey', key);
  }

  /**
   * Collect the retired `StampId` nonces recorded in `CadreControl.Revocation` for one
   * {@link RevocableTable}. A stamp
   * lands here when its row is removed ({@link SeedBootstrapService.removePeer},
   * {@link deleteValidationKey}, {@link deleteStrand}), and retirement is permanent —
   * rows are never deleted (only their `ReissuedAt` counter moves, via
   * {@link reissueRevocations}). Read-side mitigation for the write-time race: the
   * schema's `NotRevoked` CHECK only sees locally visible tombstones, so a node that
   * converged on a resurrected row before its tombstone can hold both; readers
   * ({@link queryCadrePeers}, {@link queryPeerRecord},
   * {@link CadreNode.resolveDeviceToken}) drop any row whose stamp appears here.
   *
   * NOTE: the per-call cost that matters is the storage layer's, not the row count. While
   * `Revocation` has never been written, this node does not hold its block, and Optimystic
   * consults a block's cohort on every read of a block it does not hold: 1 consult per
   * call (measured), each a round trip to every other member on a multi-machine party. The
   * ledger marker ({@link openRevocationLedger}) ends that — a held block is re-consulted
   * at most once per read-repair window (10 s). Do not cache the set instead: a cache
   * cannot see a tombstone arriving by replication, so it would delay a revocation. The
   * row count only grows (append-only) but stays small while removals are rare; revisit if
   * removals become routine and the scan itself shows up in a profile.
   *
   * An isolated node that has never received the `Revocation` block reads it as holding no
   * revocations instead of throwing — see {@link readRevokedStampRows}.
   *
   * `retry: false` is forwarded by {@link queryCadrePeers} for the one caller that reads
   * under the write lock — see that method's note.
   */
  async queryRevokedStamps(tableName: RevocableTable, retry = true): Promise<Set<string>> {
    this.ensureInitialized();
    const stamps = new Set<string>();
    for (const row of await this.readRevokedStampRows(tableName, retry)) {
      stamps.add(row.StampId as string);
    }
    return stamps;
  }

  /**
   * The `Revocation` scan behind {@link queryRevokedStamps}, answering NO ROWS when the read
   * fails `cohort-unreachable` ({@link isCohortUnreachableRead}): this node does not hold
   * the block and could ask no other cohort member about it. Every other failure rethrows.
   * The retry in {@link readRows} runs first, so a node whose connectivity returns within
   * the read budget still gets the real answer.
   *
   * Without this, a machine cut off from every other machine in its party before it ever
   * received the block — the block does not exist anywhere until the owner files the
   * ledger marker ({@link openRevocationLedger}) on a connected reconcile pass — cannot
   * answer ANY membership, peer-record or device-token lookup, although it holds those
   * rows locally.
   *
   * NOTE: accepted tradeoff — `cohort-unreachable` on THIS read, and only this read, is
   * treated as "no revocations known". It adds no fail-open that does not already exist:
   * an isolated node holding a stale `Revocation` block is served it silently (the consult
   * reaches nobody, so no doubt is raised), and a revocation authored elsewhere is invisible
   * to it either way until connectivity returns. The other reasons still throw:
   * `peers-unreachable` means part of the cohort answered, and `claimed-elsewhere` /
   * `unmaterializable` mean the block exists, so an empty answer could admit a revoked
   * member. Do not move this into {@link readRows}: an empty answer is known-safe only for
   * a table whose empty state is its never-written state; decide any other table in its
   * own reader. Revisit if optimystic starts reporting a held-but-stale block distinctly
   * (the equivalence above then breaks), or if revocation enforcement must fail closed
   * under partition.
   *
   * NOTE: an isolated node pays the whole read retry (up to
   * `CONTROL_READ_RETRY_BUDGET_MS`, plus the slow attempt that exhausted it) before this
   * answers, and {@link queryPeerRecord} then issues its row scan on top. If an isolated
   * node's lookups are seen exceeding the admission gate's 2 s deadline
   * (`ADMISSION_DECISION_TIMEOUT_MS`), skip the retry for this read when the first attempt
   * fails `cohort-unreachable`.
   */
  private async readRevokedStampRows(tableName: RevocableTable, retry: boolean): Promise<Record<string, SqlValue>[]> {
    try {
      return await this.readRows('select StampId from CadreControl.Revocation where TableName = ?', [tableName], 'revoked-stamps', retry);
    } catch (error) {
      if (!isCohortUnreachableRead(error)) {
        throw error;
      }
      log('revoked-stamps(%s): no cohort member reachable and the Revocation block is not held here; reading as no revocations known: %s', tableName, error);
      return [];
    }
  }

  /**
   * Every locally-held `CadreControl.Revocation` tombstone — identity triple, its
   * `ReissuedAt` counter and the stored signer pair. Consumed by the cohort-growth re-issue
   * sweep, which enumerates what this node holds before {@link reissueRevocations}
   * re-broadcasts it, and by the reap sweep ({@link reapRevokedRows}). Plain scan with no
   * `where`, so the composite-primary-key point-lookup hazard (see the statement comment in
   * {@link reissueRevocations}) does not arise. Unlocked, like every other read.
   *
   * Skips the ledger marker ({@link REVOCATION_LEDGER_MARKER}): it retires nothing, so
   * neither sweep may reap or re-sign it, and skipping it keeps `RevocationRow.tableName`
   * a {@link RevocableTable}. Filtered on `TableName` alone, in TypeScript: `RowIsGone`
   * admits no other row under `'Revocation'`.
   *
   * `retry: false` from a caller that reads under the write lock, for the reason on
   * {@link queryCadrePeers}.
   */
  async queryRevocations(retry = true): Promise<RevocationRow[]> {
    this.ensureInitialized();
    const rows: RevocationRow[] = [];
    const sql = 'select TableName, RowKey, StampId, ReissuedAt, SignerKey, SignerSig from CadreControl.Revocation';
    for (const row of await this.readRows(sql, undefined, 'revocations', retry)) {
      if (row.TableName === REVOCATION_LEDGER_MARKER.tableName) {
        continue;
      }
      rows.push({
        tableName: row.TableName as RevocableTable,
        rowKey: row.RowKey as string,
        stampId: row.StampId as string,
        reissuedAt: (row.ReissuedAt as number | null) ?? 0,
        signerKey: row.SignerKey as string,
        signerSig: row.SignerSig as string,
      });
    }
    return rows;
  }

  /**
   * Read a single peer's address record (the full `CadrePeer` row) by PeerId.
   *
   * Returns null when no row exists, or when the row's `StampId` is retired in
   * `CadreControl.Revocation` — a revoked peer reads as absent, so the resolver
   * ({@link CadreNode.resolvePeerAddrs}) never hands out a revoked peer's addresses.
   * The stamp is read for that check only and then dropped; the returned
   * {@link PeerAddressRecord} shape is unchanged. Reads the retired set through
   * {@link queryRevokedStamps} rather than inlining the SQL, so tests can interpose on
   * that seam (see {@link queryCadrePeers}).
   *
   * Missing/null column values are coalesced
   * to their empty form (`''` key/sig, `[]` addrs, `0` stamp) so the caller's
   * verify/freshness gates uniformly reject an unpublished or malformed row.
   * The split `addrs` re-join to the exact stored `Multiaddr` (split-on-`,` is
   * the inverse of join-on-`,`), so the resolver re-verifies over the same bytes
   * the publisher signed.
   */
  async queryPeerRecord(peerId: string): Promise<PeerAddressRecord | null> {
    this.ensureInitialized();
    const revoked = await this.queryRevokedStamps('CadrePeer');
    for (const row of await this.readRows(
      'select PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId from CadreControl.CadrePeer where PeerId = ?',
      [peerId],
      'peer-record'
    )) {
      const stampId = (row.StampId as string | null) ?? null;
      if (stampId !== null && revoked.has(stampId)) {
        return null;
      }
      const multiaddr = (row.Multiaddr as string | null) ?? '';
      return {
        peerId: row.PeerId as string,
        publicKey: (row.PublicKey as string | null) ?? '',
        addrs: multiaddr.length > 0 ? multiaddr.split(',') : [],
        updatedAt: (row.UpdatedAt as number | null) ?? 0,
        sig: (row.Sig as string | null) ?? '',
      };
    }
    return null;
  }

  /**
   * Apply a peer's own self-signed address-record update to an existing row.
   *
   * Authorization is carried entirely by the record: the `Sig` column (verified
   * by the `AuthorizedUpdate` self-branch against the stored `PublicKey`) plus
   * the strictly-increasing `UpdatedAt`. No owner key is involved, so this
   * is the refresh path for any member — owner or drone — once its row
   * exists. `PublicKey` is intentionally not in the SET list (it is immutable on
   * self-update and the constraint enforces `new.PublicKey = old.PublicKey`).
   *
   * Deliberately NOT wrapped in {@link mutateCadrePeer}, the one `CadrePeer` mutator that
   * is not: it only ever touches THIS node's own row (sole caller
   * `CadreNode.publishSelfRecord`), and `CadreNode.listAuthorizedMembers` filters self out
   * of the membership snapshot, so it cannot change that snapshot. It also runs on the
   * periodic self-registration refresh, where a notify would add a recurring membership
   * read for nothing.
   *
   * Its INSERT counterpart (`SeedBootstrapService.insertSelfPeerRecord`) does notify. Not an
   * inconsistency: it shares the one owner-signed insert path with every other member's
   * row, and a self insert happens once at startup, so the wasted refresh is a single read
   * — cheaper than a conditional carve-out inside the shared writer. Only the repeating
   * path is worth exempting.
   */
  async updateSelfPeerRecord(record: PeerAddressRecord): Promise<void> {
    this.ensureInitialized();
    const multiaddr = record.addrs.join(',');
    await this.execWrite(`
      update CadreControl.CadrePeer
        with context OwnerKey = null, Signature = ?
        set Multiaddr = ?, UpdatedAt = ?, Sig = ?
        where PeerId = ?
    `, [record.sig, multiaddr, record.updatedAt, record.sig, record.peerId], 'self-record-update');
    log('Self peer record updated: %s (updatedAt=%d)', record.peerId, record.updatedAt);
  }

  /**
   * Read a single peer's device push token (the full `DeviceToken` row) by PeerId.
   *
   * Returns null when no row exists. Missing/null column values are coalesced to
   * their empty form (`''` token/sig, `0` stamp) so the caller's verify/freshness
   * gates uniformly reject an unpublished or malformed row. `platform` is returned
   * verbatim (the resolver validates it against {@link PushPlatform} and re-verifies
   * the self-signature, which covers the platform field).
   *
   * `stampId` rides along ({@link DeviceTokenRow}) because the resolver must drop a
   * row whose stamp is retired in `CadreControl.Revocation`; it is NOT part of
   * {@link DeviceTokenRecord}, which is the self-signed shape the peer's `Sig` covers.
   */
  async queryDeviceToken(peerId: string): Promise<DeviceTokenRow | null> {
    this.ensureInitialized();
    for (const row of await this.readRows(
      'select PeerId, Platform, Token, UpdatedAt, Sig, StampId from CadreControl.DeviceToken where PeerId = ?',
      [peerId],
      'device-token'
    )) {
      return {
        peerId: row.PeerId as string,
        platform: (row.Platform as string ?? '') as PushPlatform,
        token: (row.Token as string | null) ?? '',
        updatedAt: (row.UpdatedAt as number | null) ?? 0,
        sig: (row.Sig as string | null) ?? '',
        stampId: (row.StampId as string | null) ?? '',
      };
    }
    return null;
  }

  /**
   * Apply a peer's own self-signed device-token update to an existing row.
   *
   * Authorization is carried entirely by the record: the `Sig` column (verified by
   * the `DeviceToken.AuthorizedUpdate` self-branch against the stored
   * `CadrePeer.PublicKey`) plus the strictly-increasing `UpdatedAt`. No owner key
   * is involved, so this is the refresh / rotation path for any member once both its
   * `CadrePeer` row (for the PublicKey) and its `DeviceToken` row exist. `PeerId` is
   * intentionally not in the SET list (immutable; the constraint enforces
   * `new.PeerId = old.PeerId`). Mirrors {@link updateSelfPeerRecord}.
   */
  async updateSelfDeviceToken(record: DeviceTokenRecord): Promise<void> {
    this.ensureInitialized();
    await this.execWrite(`
      update CadreControl.DeviceToken
        with context OwnerKey = null, Signature = ?
        set Platform = ?, Token = ?, UpdatedAt = ?, Sig = ?
        where PeerId = ?
    `, [record.sig, record.platform, record.token, record.updatedAt, record.sig, record.peerId], 'device-token-update');
    log('Self device token updated: %s (platform=%s, updatedAt=%d)', record.peerId, record.platform, record.updatedAt);
  }

  /**
   * Insert the initial owner key (bootstrap - no existing owners required)
   */
  async insertOwnerKey(key: string): Promise<void> {
    this.ensureInitialized();
    log('Inserting owner key: %s', key);

    // Bootstrap is authorized by the schema's genesis branch — `(select count(1) from
    // committed.OwnerKey) = 0`, i.e. the party had no owner before this transaction — so no
    // signature is needed. Every other branch of `OwnerKey.Authorized` requires a signature
    // from a PRE-EXISTING owner, so this method only ever succeeds on a fresh party; a second
    // owner is seated by {@link insertOwnerKeyVouched} and removed by {@link deleteOwnerKey}.
    // We still persist a fresh, unique StampId in the row's own column to satisfy the
    // not-null/unique anti-replay constraint — the StampId is a real column value, not the
    // optimystic `StampId()` SQL function.
    const stampId = generateStampId(this.config.libp2pNode.peerId.toString());
    await this.execWrite(`
      insert into CadreControl.OwnerKey (Key, StampId)
        with context OwnerKey = null, Signature = null
        values (?, ?)
    `, [key, stampId], 'owner-key-insert');
    log('Owner key inserted');
  }

  /**
   * Owner-signed INSERT of a further `OwnerKey` row, notifying the membership listener once
   * it has committed. The signed-add branch of `OwnerKey.Authorized`: the signer must be an
   * owner in the pre-transaction snapshot, its signature covers the `'add'` digest over
   * (Key, StampId), and the stored `VouchOwner`/`VouchSig` are that same pair, so a reader
   * can later judge the add against its own anchor (`verifyOwnerKeyVoucher`).
   *
   * Through {@link mutateCadrePeer}, the membership hub. The liveness read, the stamp and the
   * signature all sit inside the locked body: a {@link lockedWithRetry} re-run starts over a
   * rolled-back attempt with a fresh stamp, as {@link redeemCadreInvite} does.
   *
   * NOTE: re-adding a removed owner from a machine that still holds its retired physical row
   * is refused here by name: `OwnerKey` is not reaped, so a machine that received the
   * tombstone without the delete (see {@link getOwnerKeys}) keeps the row, and an insert there
   * would collide on the primary key. Re-add from the machine that removed the key, or any
   * machine the delete reached; if re-adding removed owners becomes routine, the fix is an
   * `OwnerKey` reap branch, gated so it can never take the table below `MinOneOwner`.
   *
   * @returns `true` when this call seated the row, `false` when `key` is already a live owner
   *   here (nothing written).
   * @throws when this node holds `key`'s row under a retired stamp (above), or when the
   *   schema refuses the signer.
   */
  async insertOwnerKeyVouched(
    key: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    this.ensureInitialized();
    return await this.mutateCadrePeer('owner-key-add', async () => {
      // retry: false on both reads — inside the locked write body (see queryStampId's NOTE).
      const heldStamp = await this.queryStampId('OwnerKey', key, false);
      if (heldStamp !== null) {
        if (!(await this.queryRevokedStamps('OwnerKey', false)).has(heldStamp)) {
          log('insertOwnerKeyVouched: %s is already an owner; nothing written', key);
          return false;
        }
        throw new Error(
          `Cannot re-add owner key ${key} here: this node still holds the row it was removed under ` +
          '(OwnerKey rows are not reaped); re-add it from the machine that removed it'
        );
      }
      const stampId = generateStampId(this.config.libp2pNode.peerId.toString());
      const signature = signMessage(ownerKeyAddMessage(key, stampId));
      // Bare `exec`: already inside the write lock, which is NOT re-entrant.
      await this.db!.exec(`
        insert into CadreControl.OwnerKey (Key, StampId, VouchOwner, VouchSig)
          with context OwnerKey = ?, Signature = ?
          values (?, ?, ?, ?)
      `, [ownerKey, signature, key, stampId, ownerKey, signature]);
      log('Owner key %s added (vouched by %s)', key, ownerKey);
      return true;
    });
  }

  /**
   * Owner-signed removal of one `OwnerKey` row plus the `Revocation` tombstone retiring its
   * stamp, notifying the membership listener once it has committed. The remove branch of
   * `OwnerKey.Authorized` requires a signer other than the removed key, and `MinOneOwner`
   * keeps the table from emptying; both are refused by name here first, read from this
   * node's live owners ({@link getOwnerKeys}), so a caller gets a clear error rather than a
   * constraint failure. The schema stays the authority: a concurrent removal elsewhere can
   * make the local count wrong in either direction, and then `MinOneOwner` or the tombstone's
   * primary key decides (see the NOTE on {@link deleteGuardedRow}).
   *
   * Through {@link mutateCadrePeer}, the membership hub, which notifies whenever the body
   * resolves, the absent-key answer included.
   *
   * @returns `true` when the row was removed, `false` when `key` is not a live owner here
   *   (nothing written, no tombstone).
   * @throws when `key` is `ownerKey`, or is the only live owner.
   */
  async deleteOwnerKey(
    key: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    if (key === ownerKey) {
      throw new Error(`Cannot remove owner key ${key}: an owner cannot remove itself`);
    }
    return await this.mutateCadrePeer('owner-key-remove', async () => {
      // retry: false — inside the locked write body (see queryStampId's NOTE).
      const owners = await this.getOwnerKeys(false);
      if (!owners.has(key)) {
        log('deleteOwnerKey: %s is not a live owner here (already absent)', key);
        return false;
      }
      if (owners.size <= 1) {
        throw new Error(`Cannot remove owner key ${key}: cannot remove the last owner`);
      }
      return await this.deleteGuardedRow('OwnerKey', key, ownerKey, signMessage);
    });
  }

  /**
   * Insert a strand into the control database using an owner signature.
   *
   * Fails with a `Strand.Id` uniqueness violation when the id is already seated — the
   * caller decides whether that is a duplicate of its own earlier write (idempotent) or a
   * genuine conflict; see {@link isStrandIdConflict} and `CadreNode.publishStrand`.
   *
   * The owner signs the canonical row-bound authorization message (see
   * {@link buildAuthorizationMessage}) — NOT a bare stamp — so the signature is bound to
   * this strand's contents and cannot be transplanted onto an attacker-chosen row. The
   * StampId is persisted as a unique column for single-use anti-replay.
   *
   * @param strandId - Unique identifier for the strand
   * @param type - Strand type: 'o' for open, 'c' for closed
   * @param ownerKey - Public key of the authorizing owner
   * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
   *   with the owner's private key, returning a base64url signature
   * @param memberPrivateKey - Optional private key for membership in closed strands
   */
  async insertStrand(
    strandId: string,
    type: 'o' | 'c',
    ownerKey: string,
    signMessage: (message: Uint8Array) => string,
    memberPrivateKey?: string
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting strand: %s (type: %s)', strandId, type);

    // Generate a unique stamp ID using the peer ID for distributed uniqueness
    const peerId = this.config.libp2pNode.peerId.toString();
    const stampId = generateStampId(peerId);

    // Field order MUST match the schema's Strand `AuthorizedInsert` verify:
    // Id, Type, MemberPrivateKey ('' when null), StampId. FounderOwnerKey is
    // deliberately NOT in the digest — the schema binds it by equality to the
    // verified context.OwnerKey instead (see the constraint's comment).
    const message = buildAuthorizationMessage('CadreControl.Strand', 'add', [strandId, type, memberPrivateKey ?? '', stampId]);
    const signature = signMessage(message);

    // StampId is a real, unique column (single-use anti-replay), no longer a context value.
    // FounderOwnerKey must equal the signing owner or the constraint rejects the row.
    await this.execWrite(`
      insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId, FounderOwnerKey)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, ?, ?)
    `, [ownerKey, signature, strandId, type, memberPrivateKey ?? null, stampId, ownerKey], 'strand-insert');

    log('Strand inserted: %s', strandId);
  }

  /**
   * Delete a strand from the control database using an owner signature.
   *
   * Mirrors {@link insertStrand}'s row-bound approach for the delete half: the owner
   * signs the canonical `'remove'`-tagged authorization message over (Id, StampId) — the
   * schema's `Strand.AuthorizedDelete` verifies this DISTINCT digest, so the insert
   * approval (which never expires) can never be replayed as a removal. The delete and
   * the `Revocation` tombstone retiring the row's StampId commit in ONE transaction —
   * `Strand.RevocationRecorded` refuses a bare delete, and without the tombstone the
   * stamp would free up and the original formation approval could re-seat the strand.
   * Body shared with every other guarded delete via {@link deleteGuardedRow}.
   *
   * The remove digest binds only (Id, StampId) — not Type/MemberPrivateKey — so this
   * works identically for open and closed strands.
   *
   * When the strand has a `StrandPartyKey` row (this party's own membership identity for
   * the strand — minted at publish for closed strands), it is deleted IN THE SAME
   * transaction, with its own `'remove'`-tagged signature and its own `Revocation`
   * tombstone, so a re-published strand always mints fresh identity and no crash window
   * can orphan the key row. The party-key delete happens ONLY alongside an actual strand
   * row delete: a `StrandPartyKey` row with no local `Strand` row is a JOINER's identity
   * (the joiner never holds the strand row) and is not this method's to destroy — that
   * is {@link deleteStrandPartyKey}'s.
   *
   * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
   * when a row was actually removed.
   */
  deleteStrand(
    strandId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.lockedWithRetry(() => this.deleteStrandAndPartyKey(strandId, ownerKey, signMessage), {}, 'strand-delete');
  }

  /**
   * The locked body of {@link deleteStrand}: the `Strand` delete + tombstone, plus — when
   * one exists — the strand's `StrandPartyKey` delete + tombstone, all in ONE
   * transaction. A two-table sibling of {@link deleteGuardedRow} (see that method for the
   * per-clause security rationale: stamp read inside the locked body, `'remove'`-tagged
   * digests, mandatory same-transaction tombstones). Both sign through
   * {@link signGuardedRemoval} and run {@link execGuardedRemoval}, so a change to the digest
   * shape or the statement pair reaches this body; only the stamp reads and the companion-row
   * branch are its own, because no other guarded table has a companion row.
   *
   * Not wrapped in {@link withWriteLock} — the caller holds the (non-re-entrant) lock.
   */
  private async deleteStrandAndPartyKey(
    strandId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    this.ensureInitialized();
    // retry: false — these reads run inside the locked write body (see queryStampId's NOTE).
    const strandStamp = await this.queryStampId('Strand', strandId, false);
    if (strandStamp === null) {
      log('delete Strand: no row for %s (already absent)', strandId);
      return false;
    }
    const partyKeyStamp = await this.queryStampId('StrandPartyKey', strandId, false);

    const strandRemoval = signGuardedRemoval('Strand', strandId, strandStamp, signMessage);
    const partyKeyRemoval = partyKeyStamp === null
      ? null
      : signGuardedRemoval('StrandPartyKey', strandId, partyKeyStamp, signMessage);

    await this.inTransaction('delete Strand', async () => {
      await this.execGuardedRemoval(strandRemoval, ownerKey);
      if (partyKeyRemoval !== null) {
        await this.execGuardedRemoval(partyKeyRemoval, ownerKey);
      }
    });

    log('Strand deleted: %s (stamp retired%s)', strandId,
      partyKeyRemoval === null ? '' : '; party key deleted, stamp retired');
    this.notifyGuardedDelete(strandRemoval.ref);
    if (partyKeyRemoval !== null) {
      this.notifyGuardedDelete(partyKeyRemoval.ref);
    }
    return true;
  }

  /**
   * Insert this party's own strand membership identity key (`StrandPartyKey` row) using
   * an owner signature.
   *
   * Mirrors {@link insertStrand}: the owner signs the canonical row-bound authorization
   * message over (Id, PrivateKey, StampId) — binding the key material means a captured
   * approval can only ever reproduce the exact key it approved — and the StampId is
   * persisted as a unique column for single-use anti-replay.
   *
   * @param strandId - The strand this key is the party's identity for.
   * @param privateKey - The party's ed25519 strand member private key, base64 protobuf
   *   (same encoding as `Strand.MemberPrivateKey`; mint with `generateStrandMemberKey`).
   * @param ownerKey - Public key of the authorizing owner.
   * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
   *   with the owner's private key, returning a base64url signature.
   */
  async insertStrandPartyKey(
    strandId: string,
    privateKey: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting strand party key for strand: %s', strandId);

    const peerId = this.config.libp2pNode.peerId.toString();
    const stampId = generateStampId(peerId);

    // Field order MUST match the schema's StrandPartyKey `AuthorizedInsert` verify:
    // Id, PrivateKey, StampId.
    const message = buildAuthorizationMessage('CadreControl.StrandPartyKey', 'add', [strandId, privateKey, stampId]);
    const signature = signMessage(message);

    await this.execWrite(`
      insert into CadreControl.StrandPartyKey (Id, PrivateKey, StampId)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?)
    `, [ownerKey, signature, strandId, privateKey, stampId], 'strand-party-key-insert');

    log('Strand party key inserted for strand: %s', strandId);
  }

  /**
   * Owner-signed removal of one `StrandPartyKey` row — the party's own membership
   * identity for that strand, stored nowhere else, so this is as destructive as
   * {@link deleteStrand} on a closed strand. {@link deleteStrand} already removes the
   * founder's row alongside the `Strand` row in one transaction; this standalone form
   * exists for a party-key row with NO local `Strand` row (a joiner's identity — the
   * shape the formation tickets build on).
   *
   * Mirrors {@link deleteValidationKey}: `'remove'`-tagged digest over (Id, StampId),
   * `Revocation` tombstone in the same transaction. A no-op (no throw, no tombstone)
   * when the row does not exist — `false` then, `true` when a row was actually removed.
   */
  deleteStrandPartyKey(
    strandId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.lockedWithRetry(() => this.deleteGuardedRow('StrandPartyKey', strandId, ownerKey, signMessage), {}, 'strand-party-key-delete');
  }

  /**
   * Record, party-wide, a strand this party joined from another party (`JoinedStrand` row),
   * using an owner signature.
   *
   * Mirrors {@link insertStrand}: the owner signs the canonical row-bound authorization
   * message over (Id, Type, MemberPrivateKey, StampId) — binding the read secret, so a
   * captured approval can only reproduce the row it approved — and the StampId is persisted
   * as a unique column for single-use anti-replay.
   *
   * Fails with a `JoinedStrand.Id` uniqueness violation when the id is already recorded;
   * `isStrandIdConflict(error, 'JoinedStrand')` identifies that case.
   */
  async insertJoinedStrand(
    row: Pick<StrandRow, 'Id' | 'Type' | 'MemberPrivateKey'>,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting joined strand: %s (type: %s)', row.Id, row.Type);

    const stampId = generateStampId(this.config.libp2pNode.peerId.toString());

    // Field order MUST match the schema's JoinedStrand `AuthorizedInsert` verify:
    // Id, Type, MemberPrivateKey ('' when null), StampId.
    const message = buildAuthorizationMessage('CadreControl.JoinedStrand', 'add', [row.Id, row.Type, row.MemberPrivateKey ?? '', stampId]);
    const signature = signMessage(message);

    await this.execWrite(`
      insert into CadreControl.JoinedStrand (Id, Type, MemberPrivateKey, StampId)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, ?)
    `, [ownerKey, signature, row.Id, row.Type, row.MemberPrivateKey, stampId], 'joined-strand-insert');

    log('Joined strand inserted: %s', row.Id);
  }

  /**
   * Owner-signed removal of one `JoinedStrand` row. Mirrors {@link deleteStrandPartyKey}:
   * `'remove'`-tagged digest over (Id, StampId), `Revocation` tombstone in the same
   * transaction. A no-op (no throw, no tombstone) when the row does not exist — `false`
   * then, `true` when a row was actually removed.
   */
  deleteJoinedStrand(
    strandId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.lockedWithRetry(() => this.deleteGuardedRow('JoinedStrand', strandId, ownerKey, signMessage), {}, 'joined-strand-delete');
  }

  /**
   * Record, party-wide, a join this party asked for: a `JoinRequest` row under a fresh stamp,
   * owner-signed over every column. Returns the pending join as written.
   *
   * Fails with a `JoinRequest.Id` uniqueness violation when the party already holds a request
   * for this invitation; {@link isPendingJoinConflict} identifies that case.
   */
  async insertJoinRequest(
    request: JoinRequestFields,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<PendingJoin> {
    this.ensureInitialized();
    const { written, insert } = this.signJoinRequestInsert(request, ownerKey, signMessage);
    await this.execWrite(insert.sql, insert.params, 'join-request-insert');
    log('Join request inserted: %s', request.Id);
    return { ...written, outcome: null };
  }

  /**
   * Record the outcome of the pending join `expected`: its owner-signed `JoinSuccess` /
   * `JoinFailure` row, keyed by the request's stamp. A join recorded over a failure deletes the
   * failure row in the same transaction (the schema authorizes that delete by the join, and
   * leaves the one-outcome rule in that direction to this writer). Returns the pending join as
   * written.
   *
   * The live join must still be what the caller read: the same request incarnation with the
   * same outcome kind. Otherwise this throws {@link PendingJoinChangedError} and writes nothing.
   * That check is local; a sibling machine's write landing between it and the commit fails the
   * transaction instead (its outcome row collides on the primary key, or its tombstone retires
   * the stamp), and the caller re-reads either way.
   */
  async recordJoinOutcome(
    expected: PendingJoin,
    outcome: JoinOutcome,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<PendingJoin> {
    this.ensureInitialized();
    const insert = signJoinOutcomeInsert(expected.StampId, outcome, ownerKey, signMessage);
    return this.lockedWithRetry(async () => {
      const live = await this.readPendingJoin(expected.Id, false);
      if (live === null || live.StampId !== expected.StampId || live.outcome?.kind !== expected.outcome?.kind) {
        throw new PendingJoinChangedError(expected.Id, live);
      }
      await this.inTransaction('record join outcome', async () => {
        if (live.outcome?.kind === 'failed') {
          await this.deleteJoinOutcome('JoinFailure', expected.StampId);
        }
        await this.db!.exec(insert.sql, insert.params);
      });
      log('Join outcome recorded: %s (%s)', expected.Id, outcome.kind);
      return { ...live, outcome };
    }, {}, 'join-outcome-record');
  }

  /**
   * Re-write the pending join `next` (request and outcome) under a fresh stamp, retiring the
   * live request incarnation `expectedStampId`: how a finished request is asked for again, and
   * how a join written while this machine was alone is re-broadcast. One locked transaction
   * deletes the outcome row and the request (owner-signed `'remove'` digest, with its
   * `Revocation` tombstone) and inserts the successors, so no reader ever sees the id missing in
   * between. Throws {@link PendingJoinChangedError} and writes nothing when the live request is
   * not `expectedStampId`.
   *
   * Signatures and the new stamp are minted before the lock, so a retried attempt re-presents
   * the same signed messages (the contract on {@link withWriteLock}). A retry after an attempt
   * that committed but reported failure throws {@link PendingJoinChangedError} whose live join
   * carries the returned stamp, so a caller that re-reads finds its write.
   */
  async rewritePendingJoin(
    expectedStampId: string,
    next: PendingJoinFields,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<PendingJoin> {
    this.ensureInitialized();
    const { outcome, ...request } = next;
    const removal = signGuardedRemoval('JoinRequest', next.Id, expectedStampId, signMessage);
    const { written, insert } = this.signJoinRequestInsert(request, ownerKey, signMessage);
    const outcomeInsert = outcome === null ? null : signJoinOutcomeInsert(written.StampId, outcome, ownerKey, signMessage);

    return this.lockedWithRetry(async () => {
      // retry: false — this runs inside the locked write body (see queryStampId's NOTE).
      const liveStampId = await this.queryStampId('JoinRequest', next.Id, false);
      if (liveStampId !== expectedStampId) {
        throw new PendingJoinChangedError(next.Id, await this.readPendingJoin(next.Id, false));
      }
      await this.inTransaction('rewrite pending join', async () => {
        await this.deleteJoinOutcomes(expectedStampId);
        await this.execGuardedRemoval(removal, ownerKey);
        await this.db!.exec(insert.sql, insert.params);
        if (outcomeInsert !== null) {
          await this.db!.exec(outcomeInsert.sql, outcomeInsert.params);
        }
      });
      log('Pending join rewritten: %s (%s; stamp retired)', next.Id, outcome?.kind ?? 'pending');
      this.notifyGuardedDelete(removal.ref);
      return { ...written, outcome };
    }, {}, 'pending-join-rewrite');
  }

  /**
   * Owner-signed removal of one pending join, as {@link deleteJoinedStrand} removes its row:
   * `'remove'`-tagged digest over (Id, StampId), `Revocation` tombstone in the same transaction,
   * and the request's outcome row with it. A no-op (no throw, no tombstone) when there is no
   * request — `false` then, `true` when one was actually removed.
   */
  deletePendingJoin(
    id: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.lockedWithRetry(
      () => this.deleteGuardedRow('JoinRequest', id, ownerKey, signMessage, (stampId) => this.deleteJoinOutcomes(stampId)),
      {}, 'pending-join-delete');
  }

  /**
   * Mint a fresh stamp for `request` and the owner signature `JoinRequest.AuthorizedInsert`
   * verifies, returning the row as it will be written and its insert.
   */
  private signJoinRequestInsert(
    request: JoinRequestFields,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): { written: JoinRequestRow; insert: SignedStatement } {
    const written: JoinRequestRow = { ...request, StampId: generateStampId(this.config.libp2pNode.peerId.toString()) };
    const signature = signMessage(buildAuthorizationMessage('CadreControl.JoinRequest', 'add', joinRequestAddFields(written)));
    const params = [ownerKey, signature, written.Id, written.Invitation, written.Disclosure, written.RequestedAt, written.ExpiresAt, written.StampId];
    return { written, insert: { sql: JOIN_REQUEST_INSERT_SQL, params } };
  }

  /**
   * Remove the outcome row of the request incarnation `requestStampId`, whichever table holds
   * it. Unsigned: the schema authorizes the delete by the tombstone retiring that stamp, filed
   * in the same transaction or already committed (a reap).
   */
  private async deleteJoinOutcomes(requestStampId: string): Promise<void> {
    await this.deleteJoinOutcome('JoinSuccess', requestStampId);
    await this.deleteJoinOutcome('JoinFailure', requestStampId);
  }

  /** One unsigned outcome delete (see {@link deleteJoinOutcomes}; a failure's is also authorized by the join superseding it). */
  private async deleteJoinOutcome(table: 'JoinSuccess' | 'JoinFailure', requestStampId: string): Promise<void> {
    await this.db!.exec(`
      delete from CadreControl.${table}
        with context OwnerKey = null, Signature = null
        where RequestStampId = ?
    `, [requestStampId]);
  }

  /**
   * Insert a validation key into the control database using an owner signature.
   *
   * Mirrors {@link insertStrand}: the owner signs the canonical row-bound
   * authorization message over (Key, StampId), and the StampId is persisted as a unique
   * column for single-use anti-replay. A `ValidationKey` authorizes verifying strand
   * formation disclosures.
   *
   * @param key - The validation public key to enroll
   * @param ownerKey - Public key of the authorizing owner
   * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
   *   with the owner's private key, returning a base64url signature
   */
  async insertValidationKey(
    key: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting validation key: %s', key);

    const peerId = this.config.libp2pNode.peerId.toString();
    const stampId = generateStampId(peerId);

    // Field order MUST match the schema's ValidationKey `AuthorizedInsert` verify: Key, StampId.
    const message = buildAuthorizationMessage('CadreControl.ValidationKey', 'add', [key, stampId]);
    const signature = signMessage(message);

    await this.execWrite(`
      insert into CadreControl.ValidationKey (Key, StampId)
        with context OwnerKey = ?, Signature = ?
        values (?, ?)
    `, [ownerKey, signature, key, stampId], 'validation-key-insert');

    log('Validation key inserted: %s', key);
  }

  /**
   * Delete a validation key from the control database using an owner signature.
   *
   * Mirrors {@link insertValidationKey}'s row-bound approach for the delete half: the
   * owner signs the canonical `'remove'`-tagged authorization message over (Key,
   * StampId) — the schema's `ValidationKey.AuthorizedDelete` verifies this DISTINCT
   * digest, so the enrollment approval (which never expires) can never be replayed as a
   * removal. The delete and the `Revocation` tombstone retiring the row's StampId commit
   * in ONE transaction — `ValidationKey.RevocationRecorded` refuses a bare delete, and
   * without the tombstone the stamp would free up and the original enrollment approval
   * could re-seat the key. Body shared with every other guarded delete via
   * {@link deleteGuardedRow}.
   *
   * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
   * when a row was actually removed.
   */
  deleteValidationKey(
    key: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.lockedWithRetry(() => this.deleteGuardedRow('ValidationKey', key, ownerKey, signMessage), {}, 'validation-key-delete');
  }

  /**
   * Owner-vouched INSERT of one `CadrePeer` membership row, notifying the membership
   * listener once it has committed.
   *
   * Mints a fresh single-use `StampId` and signs the `'vouch'`-tagged authorization
   * message over (PeerId, StampId) — see {@link buildAuthorizationMessage} — satisfying
   * the schema's `CadrePeer.AuthorizedInsert`. Binding the peer id to the nonce means a
   * captured insert approval cannot be replayed (live rows are blocked by the unique
   * `StampId` column, removed rows by `Revocation` retirement via `CadrePeer.NotRevoked`)
   * and cannot be repurposed as a delete (which signs a distinct `'remove'`-tagged digest).
   *
   * The owner signature does NOT cover the address columns — those are vouched only as far
   * as the owner asserts them, and a peer's own `Sig` (when present) is what makes the row
   * resolvable.
   *
   * The {@link mutateCadrePeer} wrapper lives here rather than in the caller so no
   * `CadrePeer` inserter can forget it — the write itself is what lets the admitted peer's
   * traffic in.
   *
   * Idempotent on an already-present row: two writers can legitimately race the SAME peer's
   * first row — the node's own background self-publish ({@link CadreNode.registerSelf})
   * against a foreground {@link SeedBootstrapService.authorizePeer} of that node's id — and
   * the write lock only serializes them; the loser would hit the `CadrePeer.PeerId` UNIQUE
   * constraint. The existence check runs INSIDE the locked body, so it sees the winner's
   * committed row (a pre-lock check would re-open the read-then-insert window). The existing
   * row — voucher, addresses, self-`Sig` — is left untouched; re-touching a live row is
   * {@link reauthorizeCadrePeer}'s job.
   *
   * @param row - the membership row's columns; `multiaddr` is the comma-joined address list.
   * @param ownerKey - public key of the vouching owner, persisted into `VouchOwner`.
   * @param signMessage - ed25519-signs the raw message bytes (no pre-hash) with that owner's
   *   private key, returning a base64url signature.
   * @returns `true` when this call performed the INSERT, `false` when the in-lock existence
   *   check found the row already seated. The loser needs to know: an authorize seats a row
   *   with a null `Sig`, so a self-publish that lost the race must fall through to a
   *   self-update or its record never lands.
   */
  async insertCadrePeer(
    row: {
      peerId: string;
      publicKey: string | null;
      multiaddr: string;
      updatedAt: number;
      sig: string | null;
    },
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    this.ensureInitialized();
    // Stamp is minted from the ADMITTED peer's id, not this node's — the nonce names the
    // row it vouches.
    const stampId = generateStampId(row.peerId);
    const signature = signMessage(
      buildAuthorizationMessage('CadreControl.CadrePeer', 'vouch', [row.peerId, stampId])
    );
    return await this.mutateCadrePeer('peer-insert', async () => {
      // retry: false — this guard runs inside the locked write body (see queryStampId's NOTE).
      if (await this.queryStampId('CadrePeer', row.peerId, false) !== null) {
        log('CadrePeer row already present for %s; insert skipped (already a member)', row.peerId);
        return false;
      }
      // Bare `exec`: already inside the write lock, which is NOT re-entrant (see the NOTE
      // on withWriteLock — re-entry via execWrite hangs silently and permanently).
      //
      // Persist the vouching (owner, signature) onto the row (VouchOwner/VouchSig) —
      // identical to the context pair, which the AuthorizedInsert constraint binds — so a
      // reader can later re-check the voucher against its node-local trusted-owner anchor.
      await this.db!.exec(`
        insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
          with context OwnerKey = ?, Signature = ?
          values (?, ?, ?, ?, ?, ?, ?, ?)
      `, [ownerKey, signature, row.peerId, row.publicKey, row.multiaddr, row.updatedAt, row.sig, stampId, ownerKey, signature]);
      return true;
    });
  }

  /**
   * Owner "re-touch" of an existing `CadrePeer` membership row: bump `UpdatedAt` and
   * rewrite `VouchOwner`/`VouchSig` under the owner branch of `CadrePeer.AuthorizedUpdate`
   * (a signature over the SAME `'vouch'`-tagged digest {@link insertCadrePeer} builds), so
   * the row is re-emitted as a fresh, broadcasting transaction.
   *
   * This is the write-while-alone re-replication primitive: a membership row that committed
   * local-only (its block's cluster ≤1 at insert) is pushed to the cohort once it grows, by
   * re-issuing this monotonic bump. It is an UPDATE (not the original INSERT) because the row
   * already exists locally; a re-INSERT would hit the `PeerId` PK. Only the freshness stamp
   * and voucher change — `PublicKey` / `Multiaddr` / `Sig` are left intact — so it is safe
   * over a row whose peer has not self-published (`Sig` null); the caller must skip a row
   * that already carries a self-`Sig` (that row is the owning peer's to refresh, and bumping
   * `UpdatedAt` without re-signing would invalidate its self-signature).
   *
   * Signs over the row's CURRENT `StampId` (unchanged by the re-touch), read BEFORE the lock
   * is taken. An absent row returns `false` WITHOUT notifying: nothing was written, so the
   * membership snapshot cannot have changed.
   *
   * NOTE: that stamp read is outside the lock, same as {@link deleteGuardedRow}'s. A writer
   * that removes the row in between makes the `update` match nothing, and this still returns
   * `true` and notifies — harmless today (the sole caller, the write-while-alone drain, only
   * logs the result, and a spurious notify just re-reads the member set), and a remove-then-
   * re-add in the same window fails loudly instead, since the signature binds the retired
   * stamp. If a caller ever acts on `true` as proof the row was written, fold the stamp read
   * into the locked body.
   *
   * Notifies like the insert/remove paths even though this is "only" a re-touch: it rewrites
   * VouchOwner/VouchSig, which the authorized-membership predicate judges on, so it CAN
   * change the member set. Keeping the rule uniform ("every CadrePeer mutator notifies")
   * beats a per-method exception the next reader has to relearn.
   *
   * Also clears `VouchUsage`: a row carries exactly one proof (the owner branch of
   * `AuthorizedUpdate` requires it null), so re-vouching an invitation-admitted row moves it
   * onto the signature and its invitation is no longer consulted for it — the way an owner
   * retires a device's dependency on an invitation it may later withdraw.
   *
   * NOTE: this rebinds VouchOwner to the CALLING owner's key, and the authorized-membership
   * predicate (`CadreNode.listAuthorizedMembers`) now judges rows by that column against each
   * reader's node-local anchor. Benign today because the only caller — the write-while-alone
   * drain — re-touches solely rows this node itself authored (`pendingPeerWrites`), so the
   * voucher is rewritten to the key that already signed it. If a future path ever lets one
   * owner re-touch a row a DIFFERENT owner vouched, the voucher silently flips: readers that
   * anchor the original owner but not this one would drop a legitimate member. Such a path
   * must re-vouch deliberately (or preserve the existing VouchOwner/VouchSig) rather than
   * inherit this rebinding.
   *
   * @param peerId - the membership row to re-touch.
   * @param updatedAt - the strictly-increasing freshness stamp to write.
   * @param ownerKey - public key of the re-vouching owner, rewritten into `VouchOwner`.
   * @param signMessage - ed25519-signs the raw message bytes with that owner's private key.
   * @returns `true` when the row was re-touched, `false` when no row exists (no notify).
   */
  async reauthorizeCadrePeer(
    peerId: string,
    updatedAt: number,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    this.ensureInitialized();
    const stampId = await this.queryStampId('CadrePeer', peerId);
    if (stampId === null) {
      log('reauthorizeCadrePeer: no CadrePeer row for %s (nothing to re-touch)', peerId);
      return false;
    }
    const signature = signMessage(
      buildAuthorizationMessage('CadreControl.CadrePeer', 'vouch', [peerId, stampId])
    );
    await this.mutateCadrePeer('peer-reauthorize', async () => {
      // Bare `exec` — inside the non-re-entrant write lock (see insertCadrePeer).
      await this.db!.exec(`
        update CadreControl.CadrePeer
          with context OwnerKey = ?, Signature = ?
          set UpdatedAt = ?, VouchOwner = ?, VouchSig = ?, VouchUsage = null
          where PeerId = ?
      `, [ownerKey, signature, updatedAt, ownerKey, signature, peerId]);
    });
    return true;
  }

  /**
   * Owner-signed removal of one `CadrePeer` membership row, notifying the membership
   * listener once it has committed.
   *
   * Mirrors {@link deleteStrand} for the membership table: the owner signs the DISTINCT
   * `'remove'`-tagged digest over (PeerId, StampId), so the row's stored `VouchSig` can
   * never be replayed to delete it, and the `Revocation` tombstone retiring the stamp
   * lands in the SAME transaction — `CadrePeer.RevocationRecorded` refuses a bare delete,
   * and without the tombstone the never-expiring admission approval (which the removed
   * peer holds a copy of) could re-seat the row.
   *
   * The {@link mutateCadrePeer} wrapper lives here rather than in the caller so no
   * `CadrePeer` remover can forget it. It notifies whenever the body resolves, including
   * the absent-row no-op below — a caller that must not notify for an already-absent peer
   * gates on {@link queryCadrePeerStampId} first (see
   * {@link SeedBootstrapService.removePeer}).
   *
   * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
   * when a row was actually removed.
   */
  deleteCadrePeer(
    peerId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.mutateCadrePeer('peer-remove', () =>
      this.deleteGuardedRow('CadrePeer', peerId, ownerKey, signMessage));
  }

  /**
   * Owner-signed removal of one peer's `DeviceToken` row (logout / token invalidation).
   *
   * Mirrors {@link deleteStrand}: the owner signs the DISTINCT `'remove'`-tagged digest
   * over (PeerId, StampId), so the insert approval can never be replayed to clear a token,
   * and the `Revocation` tombstone retiring the stamp lands in the SAME transaction —
   * `DeviceToken.RevocationRecorded` refuses a bare delete, and without the tombstone the
   * never-expiring insert approval (which the cleared device holds a copy of) could
   * re-seat the token.
   *
   * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
   * when a row was actually removed.
   */
  deleteDeviceToken(
    peerId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.lockedWithRetry(() => this.deleteGuardedRow('DeviceToken', peerId, ownerKey, signMessage), {}, 'device-token-delete');
  }

  /**
   * Owner-signed delete of one guarded row plus the `Revocation` tombstone retiring its
   * stamp, in ONE transaction. The single body behind EVERY guarded delete —
   * {@link deleteStrand}, {@link deleteValidationKey}, {@link deleteCadrePeer},
   * {@link deleteDeviceToken}, {@link deleteOwnerKey}; see any of them for the per-table
   * security rationale. Each of those is a thin named wrapper, so callers never pass a
   * table name and this generic shape stays off the public surface.
   *
   * The row's CURRENT stamp is read first and signed over, so the remove digest binds to
   * this exact row instance. A no-op (no throw, no tombstone) when the row is absent —
   * reported as `false` so a caller can tell "removed" from "was never there" without a
   * second read (e.g. {@link CadreNode.unpublishStrand}'s committed-while-alone warning,
   * which must not fire for a no-op).
   *
   * `alongside`, when given, runs inside the transaction before the removal, for a table whose
   * row has dependants the schema requires removed with it ({@link deletePendingJoin}).
   *
   * NOTE: the stamp read is outside the transaction. A concurrent writer that removes
   * the row in between makes the signature bind a stamp that is no longer live; the
   * delete then matches nothing and the tombstone insert collides with the other
   * writer's on `Revocation`'s (TableName, StampId) primary key, so the transaction
   * fails rather than silently half-applying. If concurrent owner-device removals ever
   * become routine, fold the stamp read into the transaction instead.
   *
   * Deliberately NOT wrapped in {@link withWriteLock}: every public entry point already
   * holds the (non-re-entrant) lock, so taking it again here would self-deadlock.
   */
  private async deleteGuardedRow(
    table: RemovableTable,
    keyValue: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string,
    alongside?: (stampId: string) => Promise<void>
  ): Promise<boolean> {
    this.ensureInitialized();
    // retry: false — this runs inside the locked write body (see queryStampId's NOTE).
    const stampId = await this.queryStampId(table, keyValue, false);
    if (stampId === null) {
      log('delete %s: no row for %s (already absent)', table, keyValue);
      return false;
    }

    const removal = signGuardedRemoval(table, keyValue, stampId, signMessage);
    await this.inTransaction(`delete ${table}`, async () => {
      await alongside?.(stampId);
      await this.execGuardedRemoval(removal, ownerKey);
    });

    log('%s deleted: %s (stamp retired)', table, keyValue);
    this.notifyGuardedDelete(removal.ref);
    return true;
  }

  /**
   * Delete the row incarnation `removal` names and file its tombstone — the statement pair
   * every owner removal of a guarded row runs ({@link deleteGuardedRow},
   * {@link deleteStrandAndPartyKey}, {@link rewritePendingJoin}). The caller supplies the
   * transaction: the schema's `RevocationRecorded` check refuses the delete unless the
   * tombstone commits with it.
   *
   * The delete matches the stamp as well as the key, so it can only ever remove the
   * incarnation the signature names.
   *
   * `tableName` and its {@link GUARDED_KEY_COLUMN} column are interpolated into the SQL; both
   * come from closed literal unions — no caller-supplied string reaches the statement.
   */
  private async execGuardedRemoval(removal: GuardedRemoval, ownerKey: string): Promise<void> {
    const { tableName, rowKey, stampId } = removal.ref;
    await this.db!.exec(`
      delete from CadreControl.${tableName}
        with context OwnerKey = ?, Signature = ?
        where ${GUARDED_KEY_COLUMN[tableName]} = ? and StampId = ?
    `, [ownerKey, removal.signature, rowKey, stampId]);
    await this.execTombstone(removal.ref, removal.revocationSignature, ownerKey);
  }

  /**
   * File the owner-signed `Revocation` tombstone retiring one row incarnation — the second
   * statement of every guarded removal ({@link execGuardedRemoval}) and the whole of a
   * `CadreInvite` withdrawal ({@link withdrawCadreInvite}), whose row stays — or the ledger
   * marker ({@link openRevocationLedger}), which retires nothing. The caller supplies the
   * lock and, where one is needed, the transaction.
   *
   * `ReissuedAt` is named explicitly at 0 (the only value `FreshTombstone` accepts) rather
   * than leaning on the column default — the seat-at-zero rule is load-bearing for
   * {@link reissueRevocations}' monotonic bump, so state it at the write site.
   *
   * `SignerKey` / `SignerSig` store the context pair (`Revocation.Authorized` pins them
   * equal), so a node that receives the row by replication can tell which owner filed it.
   */
  private async execTombstone(
    ref: RevokedRowRef | typeof REVOCATION_LEDGER_MARKER,
    revocationSignature: string,
    ownerKey: string
  ): Promise<void> {
    await this.db!.exec(`
      insert into CadreControl.Revocation (TableName, RowKey, StampId, ReissuedAt, SignerKey, SignerSig)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, 0, ?, ?)
    `, [ownerKey, revocationSignature, ref.tableName, ref.rowKey, ref.stampId, ownerKey, revocationSignature]);
  }

  /**
   * Fire the guarded-delete listener for one committed tombstone, swallowing (and
   * logging) a listener throw — a committed delete never fails because bookkeeping did.
   * Shared by {@link deleteGuardedRow} and {@link deleteStrandAndPartyKey} (which files
   * up to two tombstones per transaction).
   */
  private notifyGuardedDelete(revocation: RevokedRowRef): void {
    if (!this.guardedDeleteListener) {
      return;
    }
    try {
      this.guardedDeleteListener(revocation);
    } catch (error) {
      log('guarded-delete listener threw (committed delete unaffected): %o', error);
    }
  }

  /**
   * Delete one guarded row that an ALREADY-COMMITTED `Revocation` tombstone retires —
   * the local catch-up for a node that converged on a removal's tombstone while still
   * holding the removed row. That live-row-plus-tombstone state is reachable only by
   * replication merge (local writes cannot build it: `Revocation.RowIsGone` refuses a
   * tombstone while the row is live), and replication cannot carry the delete itself —
   * replaying a delete of a row that is already gone locally is a no-op — so without
   * this the stale row is permanent garbage on every node that held it at revocation
   * time. Authorized by the REAP branch of the table's `AuthorizedDelete`: the
   * tombstone is itself owner-signed (`Revocation.Authorized`), so no owner key is
   * needed HERE — any node holding row + tombstone may reap, drones included.
   *
   * Returns whether a row was removed: `false` without writing when the row is absent
   * locally (the common case on most nodes), or when its live stamp is not `stampId`
   * (a fresh incarnation the owner re-seated, which the old tombstone must not touch).
   *
   * The delete's WHERE clause binds `StampId` too — required, not belt-and-braces: an
   * owner may re-seat the row (fresh stamp) between the stamp read below and the
   * statement, and without the clause the reap would delete the owner's brand-new row.
   * With it the statement matches nothing and the reap is a silent no-op (the schema
   * branch would also refuse that delete, but as a constraint error thrown into a
   * background sweep — matched-nothing is the better failure mode). Like
   * {@link reauthorizeCadrePeer}, a race lost AFTER the guard still returns `true`;
   * harmless — nothing was deleted, and the next sweep re-reads.
   *
   * Writes NOTHING to `Revocation`: `RevocationRecorded` is satisfied by the same
   * committed tombstone that authorizes the reap, so a reap files no second tombstone.
   * It therefore does NOT fire the guarded-delete listener either — that seam exists to
   * queue a tombstone for re-issue when it committed while alone, and a reap has no
   * tombstone of its own to re-issue. A reap that commits while alone needs no
   * re-replication at all: every OTHER node either already lacks the row, or holds the
   * same committed tombstone and reaps its own copy.
   *
   * NOTE: the reap delete is keyed on the primary key; the `StampId` predicate is applied
   * where the statement runs. If a reap on one node ever has to be reconciled against an
   * owner re-seat of the same key that landed on another node, whether the delete or the
   * re-seat wins is decided by the collection's merge order, not by this clause — the same
   * ordering question the owner-signed delete path already carries
   * (`tickets/blocked/forked-control-collection-sync-livelocks.md`). Only matters once a
   * sweep drives this automatically on connected nodes; if that reconcile ever drops a
   * freshly re-seated row, this is the site.
   *
   * `table` and its {@link GUARDED_KEY_COLUMN} column come from closed literal unions —
   * no caller-supplied string reaches the statement (same injection-surface discipline
   * as {@link deleteGuardedRow}). The `with context` clause is PRESENT and bound to
   * nulls, never omitted: Quereus cannot resolve `context.OwnerKey` at plan time when
   * the clause is absent while a constraint references `context.*` (nulls through a
   * present clause are the shape {@link redeemInvitation}'s consent-branch insert ships).
   *
   * Driven automatically by {@link reapRevokedRows}, which the periodic control-cohort
   * reconcile pass runs while the node has at least one control connection.
   */
  async reapRevokedRow(table: ReapableTable, rowKey: string, stampId: string): Promise<boolean> {
    this.ensureInitialized();
    const liveStamp = await this.queryStampId(table, rowKey);
    if (liveStamp === null) {
      log('reap %s: no row for %s (nothing to reap)', table, rowKey);
      return false;
    }
    if (liveStamp !== stampId) {
      log('reap %s: %s holds a fresh incarnation (live stamp differs from the tombstoned one); leaving it', table, rowKey);
      return false;
    }
    const sql = `
      delete from CadreControl.${table}
        with context OwnerKey = null, Signature = null
        where ${GUARDED_KEY_COLUMN[table]} = ? and StampId = ?
    `;
    if (table === 'CadrePeer') {
      // Through mutateCadrePeer so the "EVERY CadrePeer writer goes through here"
      // invariant keeps holding with no new documented exception. The membership
      // snapshot cannot actually change — queryCadrePeers already dropped this row via
      // the retired-stamp gate — so the notify is a redundant refresh. Bare exec:
      // already inside the non-re-entrant write lock (see insertCadrePeer).
      //
      // NOTE: reapRevokedRows calls this in a loop, so a sweep that clears K CadrePeer
      // rows fires K redundant gate refreshes (two table scans each), awaited serially.
      // Harmless today — K is the backlog of unreaped rows, which a party burns down to
      // 0 on its first connected tick and holds there. If a party ever reaps many rows
      // in one pass, hoist the notify to one refresh after the sweep instead.
      await this.mutateCadrePeer('peer-reap', () => this.db!.exec(sql, [rowKey, stampId]));
    } else if (table === 'JoinRequest') {
      // The request's outcome row goes with it; the committed tombstone authorizes that delete
      // too. An outcome row held for a request this node never received (the request was
      // written alone and its outcome connected, before the growth-edge re-issue) is left: it
      // is unreadable, since every reader starts from the request.
      await this.lockedWithRetry(() => this.inTransaction('reap JoinRequest', async () => {
        await this.deleteJoinOutcomes(stampId);
        await this.db!.exec(sql, [rowKey, stampId]);
      }), {}, 'reap-JoinRequest');
    } else {
      await this.execWrite(sql, [rowKey, stampId], `reap-${table}`);
    }
    // A row leaving the control plane without an owner signature at the write site
    // should be visible in a log.
    log('REAPED %s row %s (stamp %s): committed tombstone authorized local removal, no owner signature', table, rowKey, stampId);
    return true;
  }

  /**
   * Sweep every locally-held `Revocation` tombstone and {@link reapRevokedRow} the guarded
   * row each one retires, returning how many rows were actually removed.
   *
   * This is the enumeration half of the reap: replication carries the tombstone but cannot
   * carry the delete (replaying a delete of an already-absent row is a no-op), so a node
   * that converged on a removal while holding the removed row keeps that row as inert
   * garbage until something walks the tombstones and drops it. `CadreNode`'s periodic
   * control-cohort reconcile pass is that something, gated on the node having at least one
   * control connection (a reap is a write, and a write committed alone is local-only).
   *
   * Enumerated UNLOCKED, deleted per-row LOCKED: {@link reapRevokedRow} takes the write
   * lock itself (via {@link mutateCadrePeer} / {@link execWrite}) and the lock is not
   * re-entrant, so this loop must not hold it. Same structure as
   * `CadreNode.reissueAuthoredMembershipRows`.
   *
   * Two rows are deliberately left alone:
   *
   * - **Tables outside {@link REAPABLE_TABLES}** (`Strand`, `StrandPartyKey`, `OwnerKey`)
   *   — no reap branch exists on their `AuthorizedDelete`, so the delete would throw
   *   rather than no-op.
   * - **This node's OWN `CadrePeer` / `DeviceToken` row** (`selfPeerId`). Reaping it would
   *   fight this node's own re-registration: `registerSelf` / `retouchSelfDeviceToken` run
   *   on the heartbeat and the growth drain, and after a self-reap their insert-if-absent
   *   guard takes the INSERT path — which needs an owner signature `NotRevoked` refuses for
   *   a retired stamp, and which a revoked drone cannot produce at all. The trade is
   *   recurring failure noise every cycle against removing the one stale row nobody else
   *   reads from this node (every other node already filters it by tombstone). A revoked
   *   node therefore keeps its own copy of its own row; "a node that learns it has been
   *   revoked should shut itself down" is a distinct behaviour and its own ticket.
   *   `ValidationKey`, `JoinedStrand` and `JoinRequest` have no self notion and are not
   *   special-cased.
   *
   * A per-row failure is logged and skipped rather than aborting the sweep: an abort would
   * starve every tombstone after the failing one on every subsequent pass, and each row is
   * independent. Returns the count so far if the database is closed mid-sweep.
   *
   * `selfPeerId` is a parameter rather than read from the injected libp2p node so the
   * skip-self rule is exercisable without one.
   *
   * NOTE: cost is O(tombstones), not O(live rows) — one {@link queryRevocations} scan plus
   * one {@link queryStampId} point lookup per tombstone, and the empty early return makes
   * the common case (a party that has never revoked anyone; {@link queryRevocations} skips
   * the ledger marker) a single scan per pass. That scan consults the cohort on every pass
   * only while `Revocation` has never been written; the ledger marker
   * ({@link openRevocationLedger}), filed by the same connected pass, makes it a held block.
   * But `Revocation` is append-only and unbounded, so this is O(all tombstones ever) point
   * lookups on every reconcile tick. Fine while revocations stay rare for a cadre-sized
   * party; if the table ever grows, persist a node-local high-water mark of what has
   * already been reaped instead of re-scanning everything (the same bound the sweep in
   * `CadreNode.drainPendingRevocations` wants).
   */
  async reapRevokedRows(selfPeerId: string): Promise<number> {
    this.ensureInitialized();
    const held = await this.queryRevocations();
    if (held.length === 0) {
      return 0;
    }
    let reaped = 0;
    for (const tombstone of held) {
      // Teardown guard, per row: close() can land mid-sweep (the reconcile pass that
      // drives this outlives no node, but it does not hold the node's lifecycle either).
      if (!this.initialized || !this.db) {
        return reaped;
      }
      if (!isReapableTable(tombstone.tableName)) {
        continue;
      }
      if (tombstone.rowKey === selfPeerId
        && (tombstone.tableName === 'CadrePeer' || tombstone.tableName === 'DeviceToken')) {
        continue;
      }
      try {
        if (await this.reapRevokedRow(tombstone.tableName, tombstone.rowKey, tombstone.stampId)) {
          reaped++;
        }
      } catch (error) {
        log('reap sweep: %s row %s (stamp %s) failed (continuing): %o',
          tombstone.tableName, tombstone.rowKey, tombstone.stampId, error);
      }
    }
    return reaped;
  }

  /**
   * Owner-signed re-issue of a batch of `Revocation` tombstones: bump each row's
   * `ReissuedAt` to `reissuedAt` in ONE transaction. Re-writing the row is what makes
   * the storage layer re-broadcast it — a tombstone that committed while the node was
   * alone is local-only, and unlike an insert a delete cannot be replayed (the guarded
   * row is already gone locally), so the tombstone is the half of a removal that can
   * still carry it to the rest of the party.
   *
   * One transaction, not one per row: a sweep may cover every tombstone in the table,
   * and each separate commit is a separate round of network work. One owner signature
   * per row: `AuthorizedReissue`'s digest binds (TableName, RowKey, StampId,
   * ReissuedAt). `reissuedAt` must be STRICTLY above every affected row's current
   * value (`ReissueOnly`); callers derive it as `Math.max(Date.now(), max(existing) + 1)`,
   * mirroring {@link CadreNode.reissuePeerAuthorize}'s monotonic bump. Re-issuing a
   * tombstone whose guarded row was never present locally is the normal case (a node
   * that converged on the tombstone but never held the row) — a re-issue files no
   * delete, so `RowIsGone` / `RevocationRecorded` are not involved.
   *
   * A constraint failure on any row rolls the WHOLE batch back and propagates —
   * {@link lockedWithRetry}'s classifier only re-presents transient cluster failures,
   * so a real refusal (non-owner signer, or a stale counter when two owner devices
   * sweep concurrently and the loser's `ReissueOnly` CHECK fails) surfaces to the
   * caller, which retries with a fresh counter on its next sweep. A row whose
   * `StampId` matches nothing locally is a silent no-op statement; callers enumerate
   * via {@link queryRevocations} first, so they only name stamps they hold.
   *
   * Returns how many UPDATE statements ran (`rows.length` on success).
   */
  reissueRevocations(
    rows: readonly RevocationRow[],
    reissuedAt: number,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<number> {
    this.ensureInitialized();
    // Signatures minted OUTSIDE the locked body: a retried attempt must re-present the
    // exact signed message, never re-mint (the contract on withWriteLock). ReissuedAt
    // rides in the digest as a string — SQL-side it is cast(new.ReissuedAt as text),
    // and every digest field is TEXT on both sides (see buildAuthorizationMessage).
    const signed = rows.map((row) => ({
      row,
      signature: signMessage(buildAuthorizationMessage(
        'CadreControl.Revocation', 'reissue',
        [row.tableName, row.rowKey, row.stampId, String(reissuedAt)]
      )),
    }));
    return this.lockedWithRetry(async () => {
      // Counter lives INSIDE the locked body so a lockedWithRetry re-run (which
      // re-executes the whole body) starts from zero instead of double-counting.
      let executed = 0;
      await this.inTransaction('reissue revocations', async () => {
        for (const { row, signature } of signed) {
          // Keyed on StampId ALONE, deliberately. Equality on every column of the
          // composite primary key (TableName, StampId) makes the optimystic vtab claim
          // the predicate as a point lookup with no engine-side re-check, and that
          // descent has been observed returning zero rows for a row that provably
          // exists (tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked).
          // A re-issue that silently matched nothing would report success and
          // replicate nothing — the exact failure this path exists to remove. StampId
          // alone is a non-leading subset of the key, which the module declines, so
          // the read is a scan the engine filters; a StampId is 128 bits of CSPRNG
          // output minted per row incarnation (generateStampId), so it identifies one
          // row across all TableName values. Do NOT "fix" this by adding TableName to
          // the where clause.
          await this.db!.exec(`
            update CadreControl.Revocation
              with context OwnerKey = ?, Signature = ?
              set ReissuedAt = ?
              where StampId = ?
          `, [ownerKey, signature, reissuedAt, row.stampId]);
          executed++;
        }
      });
      log('Reissued %d revocation tombstone(s) at %d', executed, reissuedAt);
      return executed;
    }, {}, 'revocation-reissue');
  }

  /**
   * Owner-signed filing of the singleton `Revocation` ledger marker
   * ({@link REVOCATION_LEDGER_MARKER}), the one row in that table that retires nothing.
   *
   * Why it exists: while `Revocation` has never been written, this node does not hold its
   * block, and Optimystic consults a block's cohort on EVERY read of a block it does not
   * hold — and every membership lookup, and every guarded insert's `NotRevoked` check,
   * reads this table. Once any row exists the block is held and re-checked at most once per
   * read-repair window, like every other populated table. The schema's table comment says
   * why the row can never read as a retirement.
   *
   * Insert-if-absent, shaped like {@link reissueRevocations}: the signature is minted
   * OUTSIDE the locked body so a retried attempt re-presents the same one, and the guard
   * runs INSIDE it so it sees a concurrent local writer's committed row. The guard scans
   * the `'Revocation'` rows and compares the stamp in TypeScript rather than seeking the
   * full composite primary key, which is served as a point lookup that can miss an existing
   * row on a networked database (tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked).
   *
   * Two owners filing at once: the loser either sees the marker in its guard or is refused
   * on the primary key, and both answer `'already-open'`.
   *
   * The caller decides WHEN. A marker committed while the node is alone is local-only and
   * can fork the collection, so {@link CadreNode} files it only while connected; this
   * method does not look at connectivity.
   *
   * @param ownerKey - owner public key for the write context (`Revocation.Authorized`).
   * @param signMessage - ed25519-signs the raw message bytes (no pre-hash) with that owner's
   *   private key, returning a base64url signature.
   * @returns `'opened'` when this call filed the marker, `'already-open'` when it was
   *   already there.
   */
  async openRevocationLedger(
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<RevocationLedgerOpenResult> {
    this.ensureInitialized();
    const signature = signMessage(revocationTombstoneMessage(REVOCATION_LEDGER_MARKER));
    try {
      return await this.lockedWithRetry<RevocationLedgerOpenResult>(async () => {
        if (await this.revocationLedgerFiled()) {
          return 'already-open';
        }
        // execTombstone is a bare `exec`: already inside the write lock, which is NOT re-entrant.
        await this.execTombstone(REVOCATION_LEDGER_MARKER, signature, ownerKey);
        log('Revocation ledger marker filed');
        return 'opened';
      }, {}, 'revocation-ledger-open');
    } catch (error) {
      if (!isRevocationLedgerConflict(error)) {
        throw error;
      }
      log('Revocation ledger marker already filed (refused on the primary key, most likely by another owner filing first): %s', error);
      return 'already-open';
    }
  }

  /**
   * Whether the ledger marker is present locally: a scan of the `'Revocation'` rows with the
   * stamp compared in TypeScript (see {@link openRevocationLedger} for why not a seek).
   * Called only inside the locked write body, so never retried (see queryStampId's NOTE).
   */
  private async revocationLedgerFiled(): Promise<boolean> {
    const { tableName, stampId } = REVOCATION_LEDGER_MARKER;
    const rows = await this.readRows(
      'select StampId from CadreControl.Revocation where TableName = ?',
      [tableName],
      'revocation-ledger',
      false
    );
    return rows.some(row => row.StampId === stampId);
  }

  /**
   * Run `body` between `beginTransaction` and `commit`, rolling back on failure.
   *
   * A failed `commit()` has already torn the transaction down, so the `rollback()` in
   * the failure path would itself throw "No transaction active" and mask the real
   * cause — that secondary throw is logged and swallowed, and the original error always
   * propagates.
   *
   * It opens a transaction unconditionally (Quereus hard-throws on a nested
   * `beginTransaction`), so a caller already inside one must not call it. A `CadrePeer`
   * write nests this INSIDE {@link mutateCadrePeer}, never the reverse — see
   * {@link assertCommitBoundary}.
   *
   * Private: every multi-statement control write lives in this class (the owner-signed
   * delete/tombstone pairs all go through {@link deleteGuardedRow}), so needing to widen
   * this is a sign the writer that wants it belongs in here too.
   *
   * Deliberately NOT wrapped in {@link withWriteLock}: callers already hold the
   * (non-re-entrant) lock, so taking it again here would self-deadlock.
   *
   * @param label - What the transaction was doing, for the rollback log line.
   */
  private async inTransaction(label: string, body: () => Promise<void>): Promise<void> {
    this.ensureInitialized();
    await this.db!.beginTransaction();
    try {
      await body();
      await this.db!.commit();
    } catch (error) {
      try {
        await this.db!.rollback();
      } catch (rollbackError) {
        log('Rollback after %s failure was a no-op: %s', label, rollbackError);
      }
      throw error;
    }
  }

  /**
   * Wire (or clear, with null) the single listener notified after every committed
   * `CadreControl.CadrePeer` row write.
   *
   * At most one listener: a ControlDatabase instance belongs to exactly one
   * {@link CadreNode}, which wires this in `start()` and clears it on teardown. A
   * second call replaces the first rather than fanning out, so a stale node can
   * never keep receiving notifications for a database it no longer owns.
   */
  setMembershipChangeListener(listener: MembershipChangeListener | null): void {
    this.membershipListener = listener;
  }

  /**
   * Wire (or clear, with null) the single listener notified after every committed
   * guarded-table delete. Same ownership contract as
   * {@link setMembershipChangeListener}: one CadreNode, one listener, a second
   * call replaces the first.
   */
  setGuardedDeleteListener(listener: GuardedDeleteListener | null): void {
    this.guardedDeleteListener = listener;
  }

  /**
   * Wire (or clear, with null) the single listener notified when {@link lockedWithRetry}
   * ABANDONS a control write. Same ownership contract as
   * {@link setMembershipChangeListener}: one CadreNode, wired in `start()` and cleared on
   * teardown, and a second call replaces the first rather than fanning out.
   *
   * Covers every write that reaches the funnel, foreground and background alike. A
   * foreground caller also sees the rethrown error; a background one often does not, which
   * is the whole reason this exists.
   */
  setControlWriteAbandonedListener(listener: ControlWriteAbandonedListener | null): void {
    this.controlWriteAbandonedListener = listener;
  }

  /**
   * Run a membership-relevant mutation and notify the membership listener once it has
   * COMMITTED.
   *
   * Covers every write that can change who is a member or an owner: EVERY `CadrePeer`
   * writer, with one documented exception ({@link updateSelfPeerRecord}, which cannot
   * change the snapshot), the `OwnerKey` writers ({@link insertOwnerKeyVouched},
   * {@link deleteOwnerKey}) and the invitation redemption ({@link redeemCadreInvite}),
   * which seats both. That is what makes the party-membership snapshot refresh automatic
   * rather than a caller obligation. The name predates the `OwnerKey` writers. A
   * writer necessarily holds the target node's ControlDatabase (the `SeedBootstrapService`'s
   * event callbacks are NOT a viable seam: the temp service `CadreNode.applySeed`
   * builds, and services constructed outside `CadreNode` entirely, never get
   * callbacks wired), so this is the one point on the write path that cannot be bypassed.
   *
   * `body` owns its own transaction if it needs one and must COMMIT before returning, so
   * the notification never makes the listener read uncommitted state. A throwing `body`
   * propagates and does NOT notify: nothing changed.
   *
   * That contract is enforced, not merely documented — see {@link assertCommitBoundary}.
   *
   * Runs under {@link withWriteLock}, notification included: with the lock held through
   * the notify, no other local writer can have a transaction open while the listener
   * reads, so the listener always sees exactly the committed state it was told about.
   * The listener itself only READS (it re-materializes the membership snapshot) — a
   * listener that wrote through a locked method would deadlock.
   *
   * Reaches the lock through {@link lockedWithRetry}, so after a transient cluster
   * failure the WHOLE locked body re-runs — `body` must be atomic and re-runnable (the
   * contract on {@link withWriteLock}). The notify sits after a successful `body` inside
   * the same attempt and a throwing attempt never reaches it, so a retried mutation
   * still notifies exactly once: on the attempt that commits, and not at all on
   * exhaustion.
   *
   * @param reason - Label for the log line only (e.g. `'peer-insert'`).
   */
  async mutateCadrePeer<T>(reason: string, body: () => Promise<T>): Promise<T> {
    this.ensureInitialized();
    return this.lockedWithRetry(async () => {
      this.assertCommitBoundary(reason, 'on entry to');
      const result = await body();
      this.assertCommitBoundary(reason, 'on return from');
      await this.notifyMembershipChanged(reason);
      return result;
    }, {}, reason);
  }

  /**
   * Run one local write under the database-wide write lock, serializing it against
   * every other local writer on this ControlDatabase.
   *
   * Quereus tracks transaction state per `Database` (`getAutocommit()`), and a write
   * statement's implicit transaction stays open across the awaits inside `exec`. Two
   * local writers interleaving mid-statement therefore either trip
   * {@link assertCommitBoundary} (any `CadrePeer` path) or silently join each other's
   * open transaction — a torn commit if either side rolls back. This lock closes that
   * class: every public write method of this class runs its statement(s) under it, and
   * `SeedBootstrapService` reaches it through {@link execWrite} rather than touching the
   * `Database` directly, so it is covered too. The race is
   * real, not theoretical: the background self-record publish on a control connection
   * opening (`CadreNode.drainPendingControlReplication` → `registerSelf`) collided with
   * a foreground `authorizePeer` — both `CadrePeer` inserts — and tripped the boundary
   * assert.
   *
   * Reads are deliberately not locked: they take no transaction of their own, and
   * serializing them here would let a listener that reads during a notify (see
   * {@link mutateCadrePeer}) deadlock. The lock is NOT re-entrant — a locked writer's
   * body must never call another locked public method; the private bodies it composes
   * ({@link deleteGuardedRow}, {@link inTransaction}) stay bare for exactly that reason.
   *
   * NOTE: re-entry fails SILENTLY and PERMANENTLY. A locked body that calls another
   * locked public method (including a {@link mutateCadrePeer} body, which runs an
   * arbitrary caller-supplied callback) queues behind its own tail and never resolves —
   * no error, and it strands the whole write queue, not only that call. There is no
   * cheap fail-fast: a "held" flag cannot tell re-entry from a legitimately queued
   * concurrent writer. Compose bare private bodies instead.
   *
   * A locked body must also be ATOMIC and RE-RUNNABLE: the public write surface reaches
   * this lock through {@link lockedWithRetry}, which re-runs the WHOLE body after a
   * transient cluster failure. Atomic holds for every body today — one statement, or
   * wrapped in {@link inTransaction} — so a failed attempt leaves nothing half-applied;
   * re-runnable means a retry re-runs the body's reads too, which is what makes it safe.
   * Signatures and stamp ids minted OUTSIDE the body are deliberately NOT re-minted per
   * attempt: a retry re-presents the exact signed message the first attempt presented.
   */
  async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chain behind the current tail regardless of how it settled, then park a
    // swallowed copy as the new tail so one failed write never poisons the queue.
    const body = () => this.runWriteBody(fn);
    const run = this.writeQueue.then(body, body);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Run one locked body, counted in {@link runningWriteBodies} from the moment it takes
   * the lock until it settles — so an unlocked read routes around it even while its
   * first statement is still waiting for the database's exec mutex, before
   * `getAutocommit()` can show it (see {@link readRowsOnce}).
   */
  private async runWriteBody<T>(fn: () => Promise<T>): Promise<T> {
    this.runningWriteBodies++;
    try {
      return await fn();
    } finally {
      this.runningWriteBodies--;
    }
  }

  /**
   * {@link withWriteLock} plus the bounded transient-failure retry
   * ({@link retryControlWrite}) — the wrapper the whole public write surface goes
   * through, so a control write that failed because the cluster cohort did not answer is
   * re-presented a moment later instead of surfacing to ~19 callers that are not
   * uniformly written to retry.
   *
   * The retry wraps the LOCK, it does not live inside it: each attempt takes and
   * releases the lock, and the backoff sleeps with NO lock held, so a write parked in
   * backoff never stalls the other local writers queued behind it. Safe because every
   * locked body is atomic and re-runnable (the contract on {@link withWriteLock}).
   *
   * Also carries {@link loadSchema}'s distributed DDL, the one caller that runs BEFORE
   * `initialized` is set — so it reaches this method directly rather than through
   * {@link execWrite}, whose {@link ensureInitialized} would reject it. The write queue is
   * necessarily empty at that point, so the lock is uncontended there; it is taken anyway
   * rather than carving out a lockless path. It is also the ONLY caller that passes a
   * `policy` — everything else takes the default, whose classifier and attempt count are
   * unchanged by that call site existing.
   *
   * `label` names the operation in this loop's debug lines and nothing else
   * ({@link ControlWriteRetryOptions.label}). Every call site in this class supplies one:
   * several writes retry CONCURRENTLY in a real party, so an unlabelled line cannot be
   * attributed to a write — keep new call sites labelled. It is also the only thing that
   * attributes an abandonment reported through {@link setControlWriteAbandonedListener}.
   *
   * The abandonment observer lands LAST, after both the policy and the spec-injected
   * pacing, so this class's single listener is the one seam for it — a caller that
   * smuggled its own in through `policy` would be displaced here rather than fanning out.
   */
  private lockedWithRetry<T>(fn: () => Promise<T>, policy: ControlWriteRetryOptions = {}, label?: string): Promise<T> {
    // The label lands LAST so a call site's own name survives both the policy and the
    // spec-injected pacing; it changes log attribution only, never behaviour.
    return retryControlWrite(
      () => this.withWriteLock(fn),
      {
        ...policy,
        ...this.controlWriteRetryPacing,
        ...(label !== undefined ? { label } : {}),
        // Read through the field, not captured: a listener wired (or cleared) while a write
        // is already in backoff still governs that write's abandonment.
        onAbandon: (abandonment) => this.controlWriteAbandonedListener?.(abandonment)
      }
    );
  }

  /**
   * One-statement local write, serialized by {@link withWriteLock} and retried on a
   * transient cluster failure via {@link lockedWithRetry}. Prefer this over a bare
   * `getDatabase().exec` so a new writer cannot forget the lock — the hazard
   * {@link assertCommitBoundary} can only catch after the fact.
   *
   * Public so `SeedBootstrapService`'s direct `CadrePeer`/`DeviceToken` SQL writes go
   * through the same seam. Must NOT be called from inside an already-locked body (the
   * lock is not re-entrant); such a caller uses a bare `getDatabase().exec` instead.
   *
   * `label` names the write in the retry loop's debug lines (see {@link lockedWithRetry});
   * optional only because it is log-only, but every caller in this repo passes one.
   */
  execWrite(sql: string, params?: SqlParameters, label?: string): Promise<void> {
    this.ensureInitialized();
    return this.lockedWithRetry(() => this.db!.exec(sql, params), {}, label);
  }

  /**
   * Throw unless the database sits at a committed boundary — `getAutocommit()` is false
   * exactly while a transaction is open.
   *
   * Both ends of a {@link mutateCadrePeer} body are checked, because either open
   * transaction would notify a listener that then reads PRE-commit state and materializes
   * a membership snapshot silently missing the write it was told about:
   *
   * - open on entry: the wrapper sits INSIDE an enclosing transaction and must be moved
   *   out to enclose that outer commit.
   * - open on return: the body opened a transaction and never committed it.
   *
   * Neither is reachable from today's callers, so this is a fail-fast guard on a future
   * mistake rather than a live code path.
   *
   * NOTE: `getAutocommit()` reports the whole `Database`, not this call. Local writers
   * serialize through {@link withWriteLock}, so with every writer locked this can only
   * trip on the two misuses above. A writer that bypasses the lock (a new method that
   * forgets it, or raw `getDatabase().exec` outside a locked wrapper) re-opens the
   * concurrent-writer window, and this assert is what catches it — it throws instead of
   * silently joining the other write's transaction.
   */
  private assertCommitBoundary(reason: string, where: string): void {
    if (this.db!.getAutocommit()) {
      return;
    }
    throw new Error(
      `mutateCadrePeer(${reason}): a transaction is open ${where} the mutation body — a ` +
      'membership write must commit before the membership listener runs; move the ' +
      'mutateCadrePeer wrapper out to enclose the commit'
    );
  }

  /**
   * Best-effort notify. A listener that throws is logged and swallowed: the write has
   * already committed, and it must never be reported as failed because a downstream
   * snapshot refresh did. A null listener (no `CadreNode` attached — e.g. the service
   * unit tests drive a bare control DB) is a silent no-op.
   */
  private async notifyMembershipChanged(reason: string): Promise<void> {
    if (!this.membershipListener) {
      return;
    }
    try {
      await this.membershipListener(reason);
    } catch (error) {
      log('Membership change listener failed (%s): %s', reason, error);
    }
  }

  /**
   * Insert an owner-signed `FormationInvite` (open invitation token).
   *
   * The invite is the on-network record that later authorizes an
   * owner-signature-FREE `Strand` creation: an invited cadre peer redeems it
   * by inserting a matching `FormationUsage` row (see {@link redeemInvitation}),
   * which satisfies the consent branch of `Strand.AuthorizedInsert`.
   *
   * Like {@link insertStrand}/{@link insertValidationKey}, the owner signs the
   * canonical row-bound authorization message (see {@link buildAuthorizationMessage})
   * over (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId) — NOT a
   * bare stamp — so the signature is bound to this invite's contents and cannot be
   * transplanted onto an attacker-chosen row. The StampId is persisted as a unique
   * column for single-use anti-replay. `FormationInvite.AuthorizedInsert` gates insert
   * over an `'add'`-tagged digest; deletes verify a DISTINCT `'remove'`-tagged digest
   * (`AuthorizedDelete`), so this insert approval can never be replayed as a revocation.
   *
   * `StrandId` binds the invite to a pre-existing host strand (provision-then-record):
   * when set, a responder redeeming this token records a `FormationUsage` against that
   * strand and returns it (see {@link ControlFormationUsageRecorder.resolveStrand}); a
   * null `StrandId` (the default) takes the unbound responder-provisions path: the
   * responder provisions a fresh open strand and atomically records its one consent row.
   * Like ValidationUrl it is a nullable bound field, signed as `''` when absent.
   *
   * The ExpiresAt and TotalUses message fields must byte-match what the (auto-deferred,
   * because it has a subquery) CHECK sees AFTER column coercion: TotalUses becomes a
   * decimal string (`String(totalUses)` ⇔ `cast(new.TotalUses as text)`) and ExpiresAt
   * becomes the engine's canonical `PlainDateTime` string — sourced here from
   * {@link canonicalDatetime} (a `select datetime(?)` round-trip) rather than a hand-rolled
   * ISO formatter, so signer and verifier agree exactly. A null ExpiresAt / TotalUses /
   * ValidationUrl signs as `''`, matching the schema's `coalesce(..., '')`.
   *
   * @param token - Invitation token (the `FormationInvite` primary key)
   * @param sAppId - The sApp a redeemed strand will use
   * @param ownerKey - Public key of the authorizing owner
   * @param signMessage - ed25519-signs the raw message bytes (no pre-hash),
   *   returning a base64url signature — the same callback shape {@link insertStrand} uses
   * @param options - Optional `expiresAtMs` (epoch ms), `totalUses`, `validationUrl`,
   *   `strandId` (bind to a pre-existing host strand for provision-then-record)
   */
  async insertFormationInvite(
    token: string,
    sAppId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string,
    options: { expiresAtMs?: number; totalUses?: number; validationUrl?: string; strandId?: string } = {}
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting formation invite: %s', token);

    const stampId = generateStampId(this.config.libp2pNode.peerId.toString());

    // Build each bound field exactly as the deferred CHECK sees it post-coercion:
    //   - ExpiresAt: engine-canonical datetime string (or '' when absent), sourced from
    //     the engine so it byte-matches the column's stored/coerced form.
    //   - TotalUses: decimal string via String(...) (⇔ cast(new.TotalUses as text)), '' when absent.
    //   - ValidationUrl: the url or '' when absent.
    //   - StrandId: the host strand id or '' when absent (text column, no coercion).
    const expiresAtCanonical = options.expiresAtMs == null
      ? null
      : await canonicalDatetime(this.db!, options.expiresAtMs);
    const expiresAtField = expiresAtCanonical ?? '';
    const totalUsesField = options.totalUses == null ? '' : String(options.totalUses);
    const validationUrlField = options.validationUrl ?? '';
    const strandIdField = options.strandId ?? '';

    // Field order MUST match the schema's FormationInvite `AuthorizedInsert` verify:
    // Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId.
    const message = buildAuthorizationMessage('CadreControl.FormationInvite', 'add', [
      token, sAppId, expiresAtField, totalUsesField, validationUrlField, strandIdField, stampId,
    ]);
    const signature = signMessage(message);

    // Persist the canonical ExpiresAt string (datetime parse is idempotent on it) so the
    // signed source-of-truth and the stored value are produced once. StampId is a real,
    // unique column (single-use anti-replay), no longer a context value.
    await this.execWrite(`
      insert into CadreControl.FormationInvite (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, ?, ?, ?, ?)
    `, [
      ownerKey, signature,
      token, sAppId,
      expiresAtCanonical,
      options.totalUses ?? null,
      options.validationUrl ?? null,
      options.strandId ?? null,
      stampId,
    ], 'formation-invite-insert');

    log('Formation invite inserted: %s', token);
  }

  /**
   * Redeem a `FormationInvite` by inserting the `Strand` row and a matching
   * `FormationUsage` row **atomically, in one transaction**.
   *
   * The two CHECK constraints are mutually circular under immediate evaluation:
   * `Strand.AuthorizedInsert`'s consent branch requires a `FormationUsage` row naming
   * this strand's `(Id, StampId)`, while `FormationUsage.StrandExists` requires a
   * `Strand` row matching that same pair — the ONE freshly-minted `strandStampId` below
   * satisfies both, which is what binds the consent record to this specific strand ROW
   * (so a later owner-signed, tombstoned removal cannot be undone by re-inserting the
   * id with a fresh stamp). Both CHECKs contain
   * subqueries, so Quereus auto-defers them to transaction commit — wrapping both
   * inserts in a single explicit `begin … commit` lets both deferred CHECKs see
   * both rows at commit. The strand is authorised WITHOUT an owner signature
   * (the `FormationUsage` branch of `Strand.AuthorizedInsert`) but still gets a fresh,
   * unique `StampId` column to satisfy the not-null/unique anti-replay column.
   *
   * The seated strand is always open (`'o'`) and keyless — the consent branch of
   * `Strand.AuthorizedInsert` accepts nothing else, the invite must be UNBOUND
   * (`FormationInvite.StrandId` null; a bound invite's host strand is owner-provisioned
   * and only ever record-only, see {@link recordFormationUsage}), and a given strand id
   * may be consent-seated once, EVER: after an owner-signed removal, re-joining that id
   * takes an owner re-seat ({@link insertStrand}) plus a bound invite, never another
   * redemption.
   *
   * The usage row is keyed by the joiner's own nonce (`UsageStampId` is the primary key), so
   * concurrent redemptions of one token never contend for a shared row key — there is no
   * lost race to retry and no second trip through the approval hook. The invite's seat
   * budget is checked by COUNT ({@link assertSeatRemains}) inside the write lock, ahead of
   * the write, so a spent invite is refused by name (`InvitationExhaustedError`) instead of
   * as the schema cap clause's generic `Authorized` CHECK failure.
   */
  async redeemInvitation(params: {
    token: string;
    strandId: string;
    /** The joining peer's own ed25519 public key. Required: it is inside BOTH signed digests (see {@link formationVouchMessage} / {@link formationConsentMessage}). */
    peerKey: string;
    disclosure?: string;
    /** Single-use nonce for this redemption, minted by the JOINER; both signed digests cover it. */
    usageStampId: string;
    /** The joiner's signature over the `'consent'` digest — verified by the `PeerConsented` CHECK. */
    peerSignature: string;
    nowMs?: number;
    validationKey?: string;
    validationSignature?: string;
    /**
     * Aborted when the caller has given up. Checked once PER ATTEMPT, inside the write lock,
     * before that attempt's transaction is opened — never between the two inserts — throwing
     * {@link FormationAbortedError} with the invite unspent.
     */
    signal?: AbortSignal;
    /**
     * The invite's seat budget, when the caller already has it in hand (e.g. it already read
     * the `FormationInvite` row to get here). Passed through to {@link assertSeatRemains} so
     * the seat check needs no extra read. `undefined` falls back to a fresh
     * {@link queryFormationInvite} read; `null` means "no invite row" / unlimited.
     */
    totalUses?: number | null;
  }): Promise<FormationUsageResult> {
    this.ensureInitialized();
    const {
      token, strandId, disclosure = '',
      peerKey, peerSignature, usageStampId,
      nowMs, validationKey, validationSignature, signal, totalUses,
    } = params;
    log('Redeeming invitation %s -> strand %s', token, strandId);

    const localPeerId = this.config.libp2pNode.peerId.toString();
    // A failed attempt rolls its whole transaction back, so nothing was ever persisted under
    // this stamp, and it is deliberately not part of the approver's signed digest.
    const strandStampId = generateStampId(localPeerId);

    // Ordering inside the locked body is contractual: the abort check, then the seat check,
    // then the write — FormationAbortedError may only ever be thrown before the write is
    // issued, and a transient-failure retry (lockedWithRetry re-runs the whole body) must
    // re-check both before re-presenting the write.
    await this.lockedWithRetry(async () => {
      // Inside the lock: a write still parked behind another writer when the caller's
      // budget expired is abandoned rather than executed.
      if (signal?.aborted) {
        throw new FormationAbortedError(token, 'redemption');
      }
      await this.assertSeatRemains(token, totalUses);
      await this.inTransaction('redemption', async () => {
        // 1. Strand row — authorised by the FormationUsage branch (no owner sig),
        //    still carrying a fresh unique StampId for the anti-replay column.
        //    Hard-coded open + keyless + explicit null FounderOwnerKey: the
        //    consent branch admits no other shape (no signature means no
        //    trustworthy founder machine to record — see the schema's NOTE).
        await this.db!.exec(`
          insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId, FounderOwnerKey)
            with context OwnerKey = null, Signature = null
            values (?, 'o', null, ?, null)
        `, [strandId, strandStampId]);

        // 2. FormationUsage row — authorised by the matching FormationInvite, and
        //    carrying the strand's stamp so it authorizes THIS row and no other.
        await this.execFormationUsageInsert({
          token, usageStampId, disclosure, strandId, strandStampId,
          peerKey, peerSignature, nowMs: nowMs ?? Date.now(),
          validationKey: validationKey ?? null, validationSignature: validationSignature ?? null,
        });
      });
    }, {}, 'formation-usage');

    log('Redeemed invitation %s -> strand %s (stamp %s)', token, strandId, usageStampId);
    return { usageStampId };
  }

  /**
   * Record a `FormationUsage` against an **already-existing** `Strand` (no strand
   * insert). This is the redemption path when the strand was provisioned
   * separately (e.g. owner-signed) and the consent record is added after the
   * fact: the single insert auto-commits, and the deferred `StrandExists` CHECK
   * is satisfied by the pre-existing committed strand row. Echoes back the
   * redemption's `usageStampId` (the row's primary key).
   *
   * Use {@link redeemInvitation} instead when the strand must be created by
   * consent atomically with the usage.
   *
   * The strand's live `StampId` is read first and written onto the usage row:
   * `FormationUsage.StrandExists` matches the (id, stamp) PAIR, and
   * `Strand.AuthorizedInsert`'s consent branch reads the same pair back, so a consent
   * record authorizes exactly the strand ROW it was recorded against. A missing strand
   * THROWS here rather than being left to the deferred `StrandExists` CHECK — the
   * ordinary "host strand has not converged yet" case is already reported as `missing`
   * by {@link ControlFormationUsageRecorder.resolveStrand}, so an absent row at this
   * point is a genuine race and deserves a named error, not a silent rollback.
   *
   * The row is keyed by the joiner's own nonce (`UsageStampId` is the primary key), so this
   * path — the one production actually races on (a bound invite published by `cadre-web` /
   * `cadre-phone` is always record-only) — never contends with another redemption for a
   * shared row key: there is no lost race to retry and no second trip through the approval
   * hook. The invite's seat budget is checked by COUNT ({@link assertSeatRemains}) inside
   * the write lock, ahead of the write.
   */
  async recordFormationUsage(params: {
    token: string;
    strandId: string;
    /** The joining peer's own ed25519 public key. Required: it is inside BOTH signed digests (see {@link formationVouchMessage} / {@link formationConsentMessage}). */
    peerKey: string;
    disclosure?: string;
    /** Single-use nonce for this redemption, minted by the JOINER; both signed digests cover it. */
    usageStampId: string;
    /** The joiner's signature over the `'consent'` digest — verified by the `PeerConsented` CHECK. */
    peerSignature: string;
    nowMs?: number;
    validationKey?: string;
    validationSignature?: string;
    /**
     * Aborted when the caller has given up. Checked inside the write lock, before the insert
     * is issued, throwing {@link FormationAbortedError} with the invite unspent. Never
     * checked once the insert has been issued.
     */
    signal?: AbortSignal;
    /**
     * The invite's seat budget, when the caller already has it in hand (e.g. it already read
     * the `FormationInvite` row to get here). Passed through to {@link assertSeatRemains} so
     * the seat check needs no extra read. `undefined` falls back to a fresh
     * {@link queryFormationInvite} read; `null` means "no invite row" / unlimited.
     */
    totalUses?: number | null;
  }): Promise<FormationUsageResult> {
    this.ensureInitialized();
    const {
      token, strandId, disclosure = '',
      peerKey, peerSignature, usageStampId, nowMs, validationKey, validationSignature, signal,
      totalUses,
    } = params;

    // The host strand is pre-existing and owner-signed; its stamp names the strand ROW the
    // consent record authorizes.
    const strandStampId = await this.queryStrandStampId(strandId);
    if (strandStampId === null) {
      throw new MissingHostStrandError(strandId, token);
    }

    // Ordering inside the locked body is contractual — abort check, seat check, write — see
    // the matching note in redeemInvitation.
    await this.lockedWithRetry(async () => {
      if (signal?.aborted) {
        throw new FormationAbortedError(token, 'usage recording');
      }
      await this.assertSeatRemains(token, totalUses);
      await this.execFormationUsageInsert({
        token, usageStampId, disclosure, strandId, strandStampId,
        peerKey, peerSignature, nowMs: nowMs ?? Date.now(),
        validationKey: validationKey ?? null, validationSignature: validationSignature ?? null,
      });
    }, {}, 'formation-usage');

    log('Recorded formation usage: token=%s strand=%s (stamp %s)', token, strandId, usageStampId);
    return { usageStampId };
  }

  /**
   * Refuse a redemption that would consume a seat the invite does not have.
   *
   * The schema's count-based cap clause (`FormationUsage.Authorized`) refuses an over-limit
   * write at the database anyway — but it fails as a generic `CHECK constraint failed:
   * Authorized`, which the manager reports as a retryable conflict. Catching it here as
   * {@link InvitationExhaustedError} lets the joiner be told the invitation is spent instead
   * of being sent around a loop that can never close. Runs inside the write lock, so on a
   * same-node race the loser reads the winner's committed row and is refused by name.
   *
   * `knownTotalUses` lets a caller that already read the `FormationInvite` row (both
   * production callers in `ControlFormationUsageRecorder` do) skip a second read on the common,
   * non-racing path. `undefined` falls back to a fresh read here.
   *
   * NOTE: a passed-in budget is a value read BEFORE the write lock (and, for a validating
   * invite, before an outbound approval call). Safe today because `FormationInvite` is
   * insert/delete only (its `Immutable` constraint), so the only way to stale it is an owner
   * revoking the token and re-issuing it with MORE seats mid-redemption; if invites ever gain
   * an update path, drop the parameter and read here instead.
   */
  private async assertSeatRemains(
    token: string,
    knownTotalUses: number | null | undefined,
  ): Promise<void> {
    // A missing invite is left to `Authorized` — it is not an exhaustion, and the CHECK's
    // rejection is already the right, non-retryable answer for it. That fallback is also what
    // makes this read's failure mode safe: it is a full-primary-key point lookup
    // (`FormationInvite where Token = ?`), the shape whose reliability on a networked strand
    // is still open (tracked by `debt-composite-pk-point-lookup-unreliable-untracked`). A
    // spurious empty result only costs the attempt its NAMED exhaustion error, reverting it to
    // today's generic `Authorized` refusal — never a seat the invite does not have.
    // Both reads pass retry: false — assertSeatRemains only ever runs inside the locked
    // write bodies of redeemInvitation / recordFormationUsage, where a read retrying its
    // own backoff would sleep holding the write lock and the write funnel re-runs these
    // reads anyway (see the NOTE on readRows).
    const totalUses = knownTotalUses !== undefined
      ? knownTotalUses
      : (await this.queryFormationInvite(token, false))?.totalUses ?? null;
    if (totalUses == null) {
      return;
    }
    const used = await this.countFormationUsage(token, false);
    if (used >= totalUses) {
      throw new InvitationExhaustedError(token, used, totalUses);
    }
  }

  /** Parameterised `FormationUsage` insert shared by redeem + record paths. */
  private async execFormationUsageInsert(opts: {
    token: string;
    /** Single-use nonce bound into the approver's signed digest; the row's primary key, so one approval spends once. */
    usageStampId: string;
    disclosure: string;
    strandId: string;
    /** The live `Strand.StampId` this consent record authorizes (`StrandExists` matches the pair). */
    strandStampId: string;
    peerKey: string;
    peerSignature: string;
    nowMs: number;
    validationKey: string | null;
    validationSignature: string | null;
  }): Promise<void> {
    // Derive `context.Now` through the same `canonicalDatetime` transform that
    // produced the stored `ExpiresAt`, so the deferred CHECK's `FI.ExpiresAt >
    // context.Now` compares two byte-identical engine-`datetime` strings. The
    // previous `new Date(nowMs).toISOString()` form differed only by a trailing
    // `.000Z` (the engine `datetime()` separator is `T`, not a space), which never
    // flipped the strict `>` against a second-granular `ExpiresAt` — so this is a
    // robustness/consistency change, matching the strand layer's `consumeInvite`,
    // not a fix for an observable mis-ordering.
    const nowCanonical = await canonicalDatetime(this.db!, opts.nowMs);
    await this.db!.exec(`
      insert into CadreControl.FormationUsage (Token, UsageStampId, PeerKey, PeerSig, Disclosure, StrandId, StrandStampId)
        with context Now = ?, ValidationKey = ?, ValidationSignature = ?
        values (?, ?, ?, ?, ?, ?, ?)
    `, [
      nowCanonical, opts.validationKey, opts.validationSignature,
      opts.token, opts.usageStampId, opts.peerKey,
      opts.peerSignature, opts.disclosure, opts.strandId, opts.strandStampId,
    ]);
  }

  /**
   * Read a `FormationInvite` row by token, or null when absent. `expiresAtMs` is
   * the parsed epoch-ms of the stored `datetime` (null when the invite never
   * expires); the caller compares it against the wall clock for freshness.
   *
   * `retry: false` is passed only by {@link assertSeatRemains}, which runs INSIDE a
   * locked write body — same per-call opt-out, and for the same reason, as
   * {@link queryStampId}'s. Every unlocked caller keeps the default retried path.
   */
  async queryFormationInvite(token: string, retry = true): Promise<{
    token: string;
    sAppId: string;
    expiresAtMs: number | null;
    totalUses: number | null;
    validationUrl: string | null;
    strandId: string | null;
  } | null> {
    this.ensureInitialized();
    const sql = 'select Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId from CadreControl.FormationInvite where Token = ?';
    for (const row of await this.readRows(sql, [token], 'formation-invite', retry)) {
      return {
        token: row.Token as string,
        sAppId: row.sAppId as string,
        expiresAtMs: parseNullableStoredDatetimeMs(row.ExpiresAt as string | number | null),
        totalUses: (row.TotalUses as number | null) ?? null,
        validationUrl: (row.ValidationUrl as string | null) ?? null,
        strandId: (row.StrandId as string | null) ?? null,
      };
    }
    return null;
  }

  /**
   * Count `FormationUsage` rows recorded against a token (uses consumed so far).
   *
   * Served by a seek through the `FormationUsageByToken` index rather than a full scan of
   * the table, which is append-only and grows for the life of the party.
   *
   * This read is NOT the seat cap. The authoritative cap is the deferred `Authorized` CHECK
   * in `schemas/control.qsql` — `FI.TotalUses > (select count(1) from
   * committed.FormationUsage U where U.Token = new.Token)` — evaluated by the validating
   * cohort against the committed snapshot at commit time. Every caller of this method is a
   * permissive PRE-check that runs ahead of it, and a transiently short read costs each of
   * them only a worse outcome for the ATTEMPT, never a seat the invitation did not pay for:
   * {@link assertSeatRemains} loses its named exhaustion error and falls back to the CHECK's
   * generic refusal; `ControlFormationUsageRecorder.isTokenUsed` reports not-used and lets
   * the redemption proceed to the CHECK, which decides; {@link hasOutstandingFormationInvite}
   * holds the stranger-admission door open slightly longer.
   *
   * NOTE: index convergence still gates the cap — just at the CHECK, not here, since the
   * CHECK's own count is served by the same `FormationUsageByToken` index. That convergence
   * failed from 2026-08-04 to 2026-08-25: a descent on a second machine returned only the
   * rows that machine had written, and the index was removed until the engine was fixed
   * upstream (re-measured 2026-09-17, `complete/restore-formation-usage-token-index`). The
   * live guard is the integration-tests scenario `strand-formation-concurrent-redemption`,
   * which asserts both machines' views of a raced redemption. If it fails on BOTH views
   * again, index convergence has regressed — fix the engine or take this read off the index,
   * and do not weaken that scenario's assertions to get a green run. A failure on ONE view is
   * NOT automatically that scenario being slow: one-way convergence lag, and the 2026-08 defect
   * itself, both present that way whenever only the sibling node wrote the rows. What separates
   * them is the failure message, which prints both nodes' rows and counts — a sibling holding
   * rows the failing view is missing is a convergence problem, not a slow run.
   *
   * `retry: false` is passed only by {@link assertSeatRemains}, which runs INSIDE a
   * locked write body — same per-call opt-out, and for the same reason, as
   * {@link queryStampId}'s. Every unlocked caller keeps the default retried path.
   */
  async countFormationUsage(token: string, retry = true): Promise<number> {
    this.ensureInitialized();
    const sql = 'select count(1) as Count from CadreControl.FormationUsage where Token = ?';
    for (const row of await this.readRows(sql, [token], 'formation-usage-count', retry)) {
      return (row.Count as number) ?? 0;
    }
    return 0;
  }

  /**
   * Is any `FormationInvite` row still redeemable — unexpired AND with usage
   * below its `TotalUses`? A null `ExpiresAt` never expires and a null
   * `TotalUses` is unlimited, matching {@link ControlFormationUsageRecorder}'s
   * per-token semantics (`isTokenValid` / `isTokenUsed`).
   *
   * Answers the control-network connection gate's coarse "does this node expect
   * a stranger?" question, which has no token to ask about. The expiry
   * comparison is `expiresAtMs <= now` — identical to `isTokenValid`'s — so an
   * invite the formation handler would reject can never hold the gate open.
   *
   * The scan is deliberately not pushed into SQL: nothing else here compares a
   * stored `datetime` with an inequality, so the parse stays in JS via the
   * shared {@link parseNullableStoredDatetimeMs}. Only invites that are
   * unexpired AND use-metered cost a {@link countFormationUsage} read, and an
   * unlimited-use invite anywhere in the scan short-circuits all of them.
   */
  async hasOutstandingFormationInvite(nowMs: number = Date.now()): Promise<boolean> {
    this.ensureInitialized();
    // NOTE: scans every FormationInvite row (expired ones included) on the
    // stranger path of an inbound connection. Cadre-scale invite counts make
    // that free today; if a long-lived cadre accumulates thousands of expired
    // invites and inbound upgrades slow down, add an expiry-ordered index or
    // prune redeemed/expired rows.
    const metered: Array<{ token: string; totalUses: number }> = [];
    let unlimitedOutstanding = false;
    for (const row of await this.readRows(
      'select Token, ExpiresAt, TotalUses from CadreControl.FormationInvite',
      undefined,
      'outstanding-invites'
    )) {
      const expiresAtMs = parseNullableStoredDatetimeMs(row.ExpiresAt as string | number | null);
      if (expiresAtMs !== null && expiresAtMs <= nowMs) {
        continue;
      }
      const totalUses = (row.TotalUses as number | null) ?? null;
      if (totalUses === null) {
        unlimitedOutstanding = true;
      } else {
        metered.push({ token: row.Token as string, totalUses });
      }
    }
    if (unlimitedOutstanding) {
      return true;
    }
    // NOTE: this loop issues one retried read per metered invite, each carrying its own
    // CONTROL_READ_RETRY_BUDGET_MS, on a path the inbound admission gate awaits under a
    // 2 s FAIL-OPEN deadline — so with N unexpired metered invites the worst case is
    // (1 + N) budgets, not one. Fine while a cadre holds a couple of live invites and
    // transient read failures are rare; if a party ever keeps many metered invites open,
    // give this whole method one shared deadline rather than raising the per-read budget.
    for (const invite of metered) {
      if (await this.countFormationUsage(invite.token) < invite.totalUses) {
        return true;
      }
    }
    return false;
  }

  // ── Cadre invitations (CadreInvite / CadreInviteUsage) ─────────────────────────────────

  /**
   * Mint and insert an owner-signed `CadreInvite`: an invitation to join THIS cadre that any
   * member machine can later redeem on the owner's behalf ({@link redeemCadreInvite}).
   *
   * The owner signs the whole row ({@link cadreInviteAddMessage}) — `ExpiresAt` through
   * {@link canonicalDatetime} so the signed segment byte-matches the stored `datetime`, as
   * {@link insertFormationInvite} does — and the stored `IssuerKey`/`IssuerSig` are pinned to
   * that signer by `CadreInvite.AuthorizedInsert`. The signature is part of the row because
   * the row travels: the returned {@link CadreInviteRow} is what the invitation bundle
   * carries to the holder, and {@link seatCadreInvite} re-inserts it verbatim on a member
   * that has not received it by replication.
   *
   * `key` is the invitation's ed25519 PUBLIC key; the caller minted the pair and hands the
   * private half to the invitee out of band. It is never stored here (`Strand.Invite` has the
   * same shape).
   *
   * @param invite.key - the invitation public key (base64url ed25519), the row's primary key
   * @param invite.peerId - the device the invitation is for, or null for whoever redeems first
   * @param invite.grantsOwner - whether redemption also seats an `OwnerKey` row for the device
   * @param invite.expiresAtMs - epoch ms after which it cannot be redeemed; omit for never
   * @param invite.totalUses - how many redemptions it allows; omit for unlimited
   * @returns the row as stored, `expiresAt` in its canonical form
   */
  async insertCadreInvite(
    invite: {
      key: string;
      peerId?: string | null;
      grantsOwner: boolean;
      expiresAtMs?: number | null;
      totalUses?: number | null;
    },
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<CadreInviteRow> {
    this.ensureInitialized();
    const key = requireEd25519PublicKeyB64(invite.key, 'cadre invitation key');
    const signed: CadreInviteSignedFields = {
      key,
      peerId: invite.peerId ?? null,
      grantsOwner: invite.grantsOwner,
      expiresAt: invite.expiresAtMs == null ? null : await canonicalDatetime(this.db!, invite.expiresAtMs),
      totalUses: invite.totalUses ?? null,
      stampId: generateStampId(this.config.libp2pNode.peerId.toString()),
    };
    const row: CadreInviteRow = {
      ...signed,
      issuerKey: ownerKey,
      issuerSig: signMessage(cadreInviteAddMessage(signed)),
    };
    await this.lockedWithRetry(() => this.execCadreInviteInsert(row), {}, 'cadre-invite-insert');
    log('Cadre invitation inserted: %s (peer=%s owner=%s)', key, row.peerId ?? 'any', row.grantsOwner);
    return row;
  }

  /**
   * Seat an owner-signed `CadreInvite` row received inside an invitation bundle, under its own
   * stored `IssuerKey`/`IssuerSig` as the write context — insert-if-absent, so a member that
   * already holds the row (by replication, or from an earlier redemption attempt) is a no-op.
   *
   * @returns `true` when this call inserted the row, `false` when it was already present.
   * @throws {CadreInviteIssuerUnknownError} when `CadreInvite.AuthorizedInsert` refuses it: the
   *   issuer is not an owner on this node (not replicated yet, or removed), or the signature does
   *   not verify. Every other refusal (a withdrawn stamp, `NotRevoked`) propagates as is.
   */
  async seatCadreInvite(row: CadreInviteRow): Promise<boolean> {
    this.ensureInitialized();
    try {
      return await this.lockedWithRetry(async () => {
        // retry: false — inside the locked write body (see queryStampId's NOTE).
        if (await this.queryStampId('CadreInvite', row.key, false) !== null) {
          log('CadreInvite %s already seated; seat skipped', row.key);
          return false;
        }
        await this.execCadreInviteInsert(row);
        log('Cadre invitation seated from its bundle: %s', row.key);
        return true;
      }, {}, 'cadre-invite-seat');
    } catch (error) {
      if (errorChainMatches(error, CADRE_INVITE_UNAUTHORIZED)) {
        throw new CadreInviteIssuerUnknownError(row.key, row.issuerKey, { cause: error });
      }
      throw error;
    }
  }

  /** Bare `CadreInvite` insert shared by {@link insertCadreInvite} and {@link seatCadreInvite}; the caller holds the lock. */
  private async execCadreInviteInsert(row: CadreInviteRow): Promise<void> {
    await this.db!.exec(`
      insert into CadreControl.CadreInvite (Key, PeerId, GrantsOwner, ExpiresAt, TotalUses, IssuerKey, IssuerSig, StampId)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.issuerKey, row.issuerSig,
      row.key, row.peerId, row.grantsOwner ? 1 : 0, row.expiresAt, row.totalUses,
      row.issuerKey, row.issuerSig, row.stampId,
    ]);
  }

  /**
   * Read one `CadreInvite` row by key, or null when absent. Withdrawn rows are returned too —
   * the row is the holder's proof and never goes away; liveness is {@link hasLiveCadreInvite}'s
   * question, and `CadreInviteUsage.Authorized`'s at redemption.
   *
   * `retry: false` is passed by {@link redeemCadreInvite}, which reads INSIDE its locked write
   * body — the same per-call opt-out, for the same reason, as {@link queryStampId}'s.
   */
  async queryCadreInvite(key: string, retry = true): Promise<CadreInviteRow | null> {
    this.ensureInitialized();
    for (const row of await this.readRows(`${CADRE_INVITE_SELECT_SQL} where Key = ?`, [key], 'cadre-invite', retry)) {
      return cadreInviteRowOf(row);
    }
    return null;
  }

  /**
   * Every `CadreInvite` row this node holds, withdrawn and expired ones included (see
   * {@link queryCadreInvite}). Read by the membership predicate when at least one `CadrePeer`
   * row is invitation-admitted; `retry: false` is forwarded from
   * {@link CadreNode.listAuthorizedMembers} on the membership-gate refresh path for
   * {@link queryCadrePeers}' reason.
   */
  async queryCadreInvites(retry = true): Promise<CadreInviteRow[]> {
    this.ensureInitialized();
    const rows = await this.readRows(CADRE_INVITE_SELECT_SQL, undefined, 'cadre-invites', retry);
    return rows.map(cadreInviteRowOf);
  }

  /**
   * Every `CadreInviteUsage` row this node holds — the redemption records the membership
   * predicate verifies invitation-admitted rows against. Same `retry` contract as
   * {@link queryCadreInvites}.
   */
  async queryCadreInviteUsages(retry = true): Promise<CadreInviteUsageRow[]> {
    this.ensureInitialized();
    const rows = await this.readRows(
      'select UsageStampId, InviteKey, PeerId, PeerKey, PeerStampId, OwnerStampId, InviteSig, PeerSig from CadreControl.CadreInviteUsage',
      undefined, 'cadre-invite-usages', retry
    );
    return rows.map(cadreInviteUsageRowOf);
  }

  /**
   * How many times a cadre invitation has been redeemed (its `CadreInviteUsage` rows), served
   * through the `CadreInviteUsageByInvite` index. As {@link countFormationUsage}: a permissive
   * PRE-check, not the cap — the cap is `CadreInviteUsage.Authorized`'s own committed count.
   *
   * `retry: false` is passed by {@link assertCadreInviteSeatRemains}, inside the locked body.
   */
  async countCadreInviteUsage(key: string, retry = true): Promise<number> {
    this.ensureInitialized();
    const sql = 'select count(1) as Count from CadreControl.CadreInviteUsage where InviteKey = ?';
    for (const row of await this.readRows(sql, [key], 'cadre-invite-usage-count', retry)) {
      return (row.Count as number) ?? 0;
    }
    return 0;
  }

  /**
   * Is any cadre invitation still redeemable — not withdrawn, unexpired, with uses below its
   * `TotalUses`, and issued by a current owner? The conditions `CadreInviteUsage.Authorized`
   * applies, read ahead of time so the control-network connection gate can answer "does this
   * node expect a stranger?" with no key to ask about, exactly as
   * {@link hasOutstandingFormationInvite} answers it for strand formation. The expiry
   * comparison is `expiresAtMs <= now`, so an invitation the redemption would refuse never
   * holds the gate open.
   *
   * Withdrawal is read through {@link queryRevokedStamps}, the per-table retired-stamp seam
   * every other revocation-aware reader uses (and the one an isolated node can still answer).
   */
  async hasLiveCadreInvite(nowMs: number = Date.now()): Promise<boolean> {
    this.ensureInitialized();
    // NOTE: getOwnerKeys reads the retired OwnerKey stamps first, so this gate path scans
    // Revocation twice (once per table, the two in parallel). If the stranger path's decision
    // ever nears the admission gate's 2 s deadline, read the retired stamps once for both.
    const [withdrawn, owners] = await Promise.all([this.queryRevokedStamps('CadreInvite'), this.getOwnerKeys()]);
    // NOTE: scans every CadreInvite row (expired and withdrawn ones included, since rows are
    // never deleted) on the stranger path of an inbound connection. Cadre-scale invitation
    // counts make that free today; if a long-lived cadre accumulates thousands and inbound
    // upgrades slow down, add an expiry-ordered index or prune withdrawn/expired rows (which
    // first needs every device they admitted re-vouched, so the chain no longer needs them).
    const metered: Array<{ key: string; totalUses: number }> = [];
    let unlimitedLive = false;
    for (const row of await this.readRows(
      'select Key, ExpiresAt, TotalUses, IssuerKey, StampId from CadreControl.CadreInvite',
      undefined,
      'live-cadre-invites'
    )) {
      const open = cadreInviteStillOpen(
        { stampId: row.StampId as string, issuerKey: row.IssuerKey as string, expiresAt: (row.ExpiresAt as string | null) ?? null },
        withdrawn, owners, nowMs
      );
      if (!open) {
        continue;
      }
      const totalUses = (row.TotalUses as number | null) ?? null;
      if (totalUses === null) {
        unlimitedLive = true;
      } else {
        metered.push({ key: row.Key as string, totalUses });
      }
    }
    if (unlimitedLive) {
      return true;
    }
    // NOTE: one retried read per metered invitation, each with its own read budget, on a path
    // the admission gate awaits under a 2 s fail-open deadline — the same shape and the same
    // revisit condition as hasOutstandingFormationInvite's loop.
    for (const invite of metered) {
      if (await this.countCadreInviteUsage(invite.key) < invite.totalUses) {
        return true;
      }
    }
    return false;
  }

  /**
   * Is this one cadre invitation still redeemable here — the conditions
   * {@link hasLiveCadreInvite} applies, for one invitation? The row judged is the one this node
   * holds under `invite.key`; when it holds none, `invite` itself (a bundle's copy, not seated
   * yet), but only if its issuer signature verifies, because an unsigned copy would otherwise be
   * judged by whichever owner it names as issuer. A permissive pre-check like
   * {@link countCadreInviteUsage}: {@link seatCadreInvite} and the redemption's own write are
   * what enforce every condition.
   */
  async isCadreInviteLive(invite: CadreInviteRow, nowMs: number = Date.now()): Promise<boolean> {
    this.ensureInitialized();
    const row = await this.queryCadreInvite(invite.key) ?? (verifyCadreInviteRow(invite) ? invite : null);
    if (row === null) {
      return false;
    }
    const [withdrawn, owners] = await Promise.all([this.queryRevokedStamps('CadreInvite'), this.getOwnerKeys()]);
    if (!cadreInviteStillOpen(row, withdrawn, owners, nowMs)) {
      return false;
    }
    return row.totalUses === null || await this.countCadreInviteUsage(row.key) < row.totalUses;
  }

  /**
   * Every `CadreInvite` row this node holds with its standing: how many redemptions are
   * recorded, whether it is withdrawn, and whether it is still redeemable — the same
   * conditions {@link hasLiveCadreInvite} applies, answered per row for an owner's listing
   * rather than short-circuited. One usage count per row, so this is the owner's
   * occasional read, not a gate's.
   */
  async listCadreInviteStatuses(nowMs: number = Date.now()): Promise<CadreInviteStatus[]> {
    this.ensureInitialized();
    const [invites, withdrawnStamps, owners] = await Promise.all([
      this.queryCadreInvites(), this.queryRevokedStamps('CadreInvite'), this.getOwnerKeys()
    ]);
    const statuses: CadreInviteStatus[] = [];
    // NOTE: one retried count read per invitation, withdrawn and expired rows included, since
    // rows are never deleted; if a long-lived cadre's listing ever shows as slow, group the
    // usage counts in one statement or skip the count for rows that are no longer open.
    for (const invite of invites) {
      const usesRecorded = await this.countCadreInviteUsage(invite.key);
      const withdrawn = withdrawnStamps.has(invite.stampId);
      const live = cadreInviteStillOpen(invite, withdrawnStamps, owners, nowMs)
        && (invite.totalUses === null || usesRecorded < invite.totalUses);
      statuses.push({ invite, live, withdrawn, usesRecorded });
    }
    return statuses;
  }

  /**
   * Owner-signed WITHDRAWAL of a cadre invitation: file the `Revocation` tombstone retiring its
   * stamp, with the row kept. The row stays because every device the invitation admitted
   * proves its membership through it (`CadrePeer.AuthorizedInsert`'s consent branch,
   * `verifyInvitationAdmission`); `CadreInvite.NoDelete` refuses a delete, and
   * `Revocation.RowIsGone` admits a `'CadreInvite'` tombstone while the row lives. Afterwards
   * `CadreInviteUsage.Authorized` refuses every further redemption, and `CadreInvite.NotRevoked`
   * refuses re-seating the row from the holder's signed copy on any node holding the
   * tombstone.
   *
   * Idempotent: a no-op (no throw, nothing written) when the row is absent locally or already
   * withdrawn — `false` then, `true` when this call filed the tombstone. The owner must hold the
   * row to withdraw it, since the tombstone names the row's stamp.
   *
   * Fires the guarded-delete listener like a removal does, so a withdrawal committed while the
   * node was alone is queued for re-issue on cohort growth ({@link CadreNode.noteGuardedDelete}).
   */
  async withdrawCadreInvite(
    key: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    this.ensureInitialized();
    const filed = await this.lockedWithRetry(async (): Promise<RevokedRowRef | null> => {
      // retry: false on both reads — inside the locked write body (see queryStampId's NOTE).
      const stampId = await this.queryStampId('CadreInvite', key, false);
      if (stampId === null) {
        log('withdrawCadreInvite: no CadreInvite row for %s (nothing to withdraw)', key);
        return null;
      }
      if ((await this.queryRevokedStamps('CadreInvite', false)).has(stampId)) {
        log('withdrawCadreInvite: %s already withdrawn (stamp %s retired)', key, stampId);
        return null;
      }
      const ref: RevokedRowRef = { tableName: 'CadreInvite', rowKey: key, stampId };
      await this.execTombstone(ref, signMessage(revocationTombstoneMessage(ref)), ownerKey);
      return ref;
    }, {}, 'cadre-invite-withdraw');
    if (filed === null) {
      return false;
    }
    log('Cadre invitation withdrawn: %s (stamp %s retired, row kept)', key, filed.stampId);
    this.notifyGuardedDelete(filed);
    return true;
  }

  /**
   * Redeem a seated `CadreInvite` on the owner's behalf: admit `peerId` as a cadre member and,
   * when the invitation grants ownership, as an owner — with NO owner signature. One
   * transaction writes the `CadrePeer` row (consent branch of `AuthorizedInsert`), the
   * `OwnerKey` row when granted (consent branch of `Authorized`), and last the
   * `CadreInviteUsage` row that authorizes both; the usage row's own checks (`PeerExists`,
   * `OwnerExists`) read the rows back, so the three are mutually bound to this exact
   * redemption and none can be held in reserve. The invitation must already be committed
   * ({@link seatCadreInvite}): every consent branch reads `committed.CadreInvite`.
   *
   * The two signatures are the holder's and the device's, minted on the device over
   * {@link cadreInviteRedeemMessage} / {@link cadreInviteConsentMessage}; this machine only
   * verifies them (by writing the row). `peerId` must be the identity multihash of `peerKey`:
   * the schema cannot derive it, so a writer asserts the pair and every reader re-derives it
   * (`verifyInvitationAdmission`) — a mismatched pair is written and then never trusted.
   *
   * Idempotent for a retry after a dropped reply: when the device's row is already present
   * (and its `OwnerKey` row too, when granted) nothing is written and no seat is spent —
   * `alreadyMember: true`. A present row whose `OwnerKey` row is missing under an
   * owner-granting invitation is completed: the usage row then names the existing peer stamp.
   * The seat check ({@link assertCadreInviteSeatRemains}) runs after that, so the retry of a
   * single-use redemption is answered `alreadyMember` rather than refused as exhausted.
   *
   * Through {@link mutateCadrePeer}, so the membership hub is notified; inside the locked body
   * every read passes `retry: false` and every stamp is minted per attempt, so a
   * {@link lockedWithRetry} re-run starts clean.
   *
   * @throws {InvitationExhaustedError} when the invitation's seats are all spent (by name,
   *   ahead of the schema's generic `Authorized` refusal — see {@link assertSeatRemains}).
   */
  async redeemCadreInvite(params: {
    inviteKey: string;
    peerId: string;
    /** The device's ed25519 public key (base64url); `peerId` is its identity multihash. */
    peerKey: string;
    /** The device's dialable addresses, if known; stored comma-joined as `authorizePeer` does. */
    multiaddrs?: string[];
    /** Single-use nonce minted by the device; both signatures cover it. */
    usageStampId: string;
    /** The holder's signature with the invitation private key over the `'redeem'` digest. */
    inviteSig: string;
    /** The device's signature with its own key over the `'consent'` digest. */
    peerSig: string;
    nowMs?: number;
  }): Promise<CadreInviteRedemptionResult> {
    this.ensureInitialized();
    const { inviteKey, peerId, peerKey, usageStampId, inviteSig, peerSig } = params;
    const nowMs = params.nowMs ?? Date.now();
    const multiaddr = params.multiaddrs?.length ? params.multiaddrs.join(',') : '';
    log('Redeeming cadre invitation %s for %s', inviteKey, peerId);

    return this.mutateCadrePeer('cadre-invite-redeem', async () => {
      const invite = await this.queryCadreInvite(inviteKey, false);
      if (invite === null) {
        throw new Error(`Cannot redeem cadre invitation ${inviteKey}: no CadreInvite row is seated on this node (seatCadreInvite first)`);
      }
      const seated = await this.readSeatedAdmission(peerId, peerKey, invite.grantsOwner);
      if (seated.peerStampId !== null && (!invite.grantsOwner || seated.ownerStampId !== null)) {
        log('redeemCadreInvite: %s already admitted; nothing written', peerId);
        return { alreadyMember: true, peerStampId: seated.peerStampId, ownerStampId: seated.ownerStampId };
      }
      await this.assertCadreInviteSeatRemains(invite);

      // Stamps minted from the ADMITTED device's id, as insertCadrePeer does: the nonce names
      // the row it seats. Minted inside the body, so a re-run mints afresh over a rolled-back
      // attempt rather than re-presenting a stamp the usage row may already name.
      const peerStampId = seated.peerStampId ?? generateStampId(peerId);
      const ownerStampId = invite.grantsOwner ? (seated.ownerStampId ?? generateStampId(peerId)) : null;
      const nowCanonical = await canonicalDatetime(this.db!, nowMs);
      await this.inTransaction('cadre-invite-redeem', async () => {
        if (seated.peerStampId === null) {
          await this.db!.exec(`
            insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig, VouchUsage)
              with context OwnerKey = null, Signature = null
              values (?, ?, ?, ?, null, ?, ?, null, ?)
          `, [peerId, peerKey, multiaddr, nowMs, peerStampId, invite.issuerKey, usageStampId]);
        }
        if (ownerStampId !== null && seated.ownerStampId === null) {
          await this.db!.exec(`
            insert into CadreControl.OwnerKey (Key, StampId, VouchOwner, VouchSig, VouchUsage)
              with context OwnerKey = null, Signature = null
              values (?, ?, ?, null, ?)
          `, [peerKey, ownerStampId, invite.issuerKey, usageStampId]);
        }
        await this.db!.exec(`
          insert into CadreControl.CadreInviteUsage (UsageStampId, InviteKey, PeerId, PeerKey, PeerStampId, OwnerStampId, InviteSig, PeerSig)
            with context Now = ?
            values (?, ?, ?, ?, ?, ?, ?, ?)
        `, [nowCanonical, usageStampId, inviteKey, peerId, peerKey, peerStampId, ownerStampId, inviteSig, peerSig]);
      });
      log('Redeemed cadre invitation %s: %s admitted (owner=%s, usage %s)', inviteKey, peerId, ownerStampId !== null, usageStampId);
      return { alreadyMember: false, peerStampId, ownerStampId };
    });
  }

  /**
   * The rows a redemption would seat that are already present: the device's `CadrePeer`
   * stamp, and — only when the invitation grants ownership — its `OwnerKey` stamp. Raw stamp
   * reads ({@link queryStampId}), so a physically present row counts; inside the locked
   * body, so never retried.
   */
  private async readSeatedAdmission(
    peerId: string,
    peerKey: string,
    grantsOwner: boolean
  ): Promise<{ peerStampId: string | null; ownerStampId: string | null }> {
    return {
      peerStampId: await this.queryStampId('CadrePeer', peerId, false),
      ownerStampId: grantsOwner ? await this.queryStampId('OwnerKey', peerKey, false) : null,
    };
  }

  /**
   * Refuse a redemption that would consume a seat the cadre invitation does not have, by
   * name ({@link InvitationExhaustedError}) — the cadre-invitation twin of
   * {@link assertSeatRemains}, for the same reason: the schema's cap clause refuses as a
   * generic `Authorized` failure a caller would otherwise report as retryable. Reads the
   * committed count inside the locked body, so on a same-node race the loser is refused here.
   */
  private async assertCadreInviteSeatRemains(invite: CadreInviteRow): Promise<void> {
    if (invite.totalUses === null) {
      return;
    }
    const used = await this.countCadreInviteUsage(invite.key, false);
    if (used >= invite.totalUses) {
      throw new InvitationExhaustedError(invite.key, used, invite.totalUses);
    }
  }

  /**
   * Close the database and cleanup resources.
   *
   * Drains the local-write chain first: {@link withWriteLock} can park a write behind
   * others across an await, and a queued closure evaluates `this.db!` only when it
   * finally runs — so nulling the handle out from under it would throw a TypeError on a
   * null handle instead of committing. The tail never rejects (it swallows both
   * outcomes), so the bare await is safe.
   *
   * NOTE: this makes `close()` wait on a stuck write. Acceptable today — every locked
   * body is a bounded local `exec` — but revisit (bounded drain, or abandon after a
   * deadline) if a write can ever hang.
   */
  async close(): Promise<void> {
    await this.writeQueue;
    if (this.collectionFactory) {
      await this.collectionFactory.shutdown();
      this.collectionFactory = null;
    }
    if (this.db) {
      void this.db.close();
      this.db = null;
    }
    this.initialized = false;
    log('ControlDatabase closed');
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error('ControlDatabase not initialized. Call initialize() first.');
    }
  }
}

