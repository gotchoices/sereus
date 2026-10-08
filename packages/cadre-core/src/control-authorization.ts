/**
 * The single definition of the field vector every signed control-plane message
 * covers. Both producers of signed bytes — `control-database.ts`'s
 * `buildAuthorizationMessage` (raw digest bytes) and `peer-authorization.ts`'s
 * digest helpers (base64url digest strings) — build their vector here, so the
 * byte layout cannot drift between them or away from the SQL constraints in
 * `schemas/control.qsql`.
 *
 * Every vector leads with two fixed literals and the party id:
 *
 *   digest(<domain>, <action>, <party id>, <row field 1>, ..., <row field n>)
 *
 * so a signature verifies ONLY against the one rule, in the one party, it was
 * minted for. Without the tags, several rules built byte-identical tuples (e.g.
 * `ValidationKey` insert and `OwnerKey` insert both signed `digest(Key, StampId)`),
 * so an approval for a narrow grant doubled as an approval for full ownership.
 * Without the party, two parties sharing an owner key (one node key owning two
 * cadres, a hardware owner key) would accept each other's approvals. The SQL side
 * reads the party from the node-local `party_id()` function `ControlDatabase`
 * registers (never from a context value or a replicated table), and every
 * TypeScript signer and verifier passes the party it is configured for.
 *
 * Two digests carry NO party ({@link UnboundControlDomain}): the `FormationUsage`
 * `'consent'` and `'vouch'` digests, whose signers do not know the party (see the
 * schema's `FormationUsage.Authorized` comment), and the offline `'Cadre.Enrollment'`
 * vouch, which no table checks.
 *
 * This module deliberately has no Quereus / Optimystic / libp2p imports so the
 * lightweight verifiers (`peer-authorization.ts`, consumed by the offline
 * `cadre enroll register` check) can use it without pulling in the runtime.
 */

/**
 * Names of the CadreControl tables, in schema order. The single list: the
 * {@link ControlTable} union is derived from it and `ControlDatabase.countRows`
 * guards its dynamic `from` clause against it (keeping the table name off the
 * SQL-injection surface), so a new table cannot be added to one and missed in
 * the other.
 *
 * `Revocation` is here for the same two reasons as every other entry: it
 * derives a `'CadreControl.Revocation'` domain tag — its `Authorized` CHECK
 * verifies an owner signature over the `'remove'`-tagged digest that
 * `peer-authorization.ts`'s `revocationDigest` mints, and its `AuthorizedReissue`
 * CHECK the `'reissue'`-tagged digest `ControlDatabase.reissueRevocations`
 * signs — and `countRows` counts it.
 */
export const CONTROL_TABLES = [
  'OwnerKey',
  'ValidationKey',
  'Strand',
  'StrandPartyKey',
  'JoinedStrand',
  'JoinRequest',
  'JoinSuccess',
  'JoinFailure',
  'CadrePeer',
  'DeviceToken',
  'FormationInvite',
  'FormationUsage',
  'CadreInvite',
  'CadreInviteUsage',
  'Revocation',
] as const;

/**
 * Name of a CadreControl table. Doubles as the table half of a
 * {@link ControlDomain} tag.
 */
export type ControlTable = typeof CONTROL_TABLES[number];

/**
 * The control tables whose rows carry a single-use `StampId` retired into
 * `CadreControl.Revocation` on delete — i.e. the ones the schema's
 * `NotRevoked` / `RevocationRecorded` CHECK pair guards, and the only values
 * `Revocation.RowIsGone` accepts in `TableName`. `Extract` from
 * {@link ControlTable} rather than a fresh literal list, so a renamed table is a
 * compile error here instead of a silently dead branch.
 *
 * `CadreInvite` is the one member whose rows are never deleted: its tombstone is a
 * withdrawal over a row that stays (`NotRevoked` refuses re-seating the withdrawn
 * row; there is no `RevocationRecorded`, since nothing is ever removed), so it is
 * revocable without being removable — `control-database.ts`'s `RemovableTable`
 * excludes it.
 *
 * Lives in this import-free module rather than beside its main consumer
 * (`control-database.ts`) so the lightweight signers — `peer-authorization.ts`'s
 * `revocationDigest` — can type against it without pulling in the runtime.
 */
export type RevocableTable = Extract<ControlTable, 'OwnerKey' | 'CadrePeer' | 'ValidationKey' | 'Strand' | 'StrandPartyKey' | 'JoinedStrand' | 'JoinRequest' | 'DeviceToken' | 'CadreInvite'>;

/**
 * What a signature authorizes, scoped to one table rule — or, for
 * `'Cadre.Enrollment'`, the offline peer vouch that `cadre enroll register`
 * verifies (no table checks it, so it needs its own domain to stay disjoint
 * from every table rule).
 */
export type ControlDomain = `CadreControl.${ControlTable}` | 'Cadre.Enrollment';

/**
 * The domains whose digests bind no party id — the only two
 * {@link unboundAuthorizationFields} accepts. `FormationUsage`: neither signer knows
 * the party, and the invitation token scopes the digest instead (the reason is at the
 * schema's `FormationUsage.Authorized` comment). `Cadre.Enrollment`: no table checks it.
 */
export type UnboundControlDomain = 'CadreControl.FormationUsage' | 'Cadre.Enrollment';

/** Every domain whose digests bind the party id — the only ones {@link controlAuthorizationFields} accepts. */
export type BoundControlDomain = Exclude<ControlDomain, UnboundControlDomain>;

/**
 * The action half of the tag:
 *  - `'add'` / `'remove'` — insert / delete of the named row.
 *  - `'vouch'` — an owner (or validation key) vouches the row's semantics
 *    without adding or removing it: the `CadrePeer` membership vouch (shared,
 *    deliberately, by its insert and its owner-update branch), the
 *    `FormationUsage` disclosure validation, and the offline enrollment vouch.
 *    `DeviceToken` has no `'vouch'` digest — its owner re-touch branch was
 *    removed (it rewrote the row outside the monotonicity guard), so an owner
 *    correcting a token deletes and re-inserts it.
 *  - `'publish'` — a peer self-signs its OWN record (the `CadrePeer` /
 *    `DeviceToken` self-update branches), with its own key rather than an
 *    owner key.
 *  - `'consent'` — a peer self-signs its OWN `FormationUsage` or
 *    `CadreInviteUsage` redemption (the joiner proving it agreed to join), with
 *    its own key. Distinct from the approver's `'vouch'` over the same table so
 *    the two stored signatures are never interchangeable.
 *  - `'redeem'` — the holder of a `CadreInvite`'s private key proves possession
 *    on a `CadreInviteUsage` row. Distinct from the device's `'consent'` over the
 *    same fields: the two signatures are by different keys and neither may stand
 *    in for the other.
 *  - `'reissue'` — an owner re-writes an existing `Revocation` tombstone,
 *    bumping its `ReissuedAt` counter so a tombstone committed while the node
 *    was alone can be re-broadcast. Distinct from `'remove'` so a tombstone
 *    append approval can never be replayed as a re-issue and vice versa.
 */
export type ControlAction = 'add' | 'remove' | 'vouch' | 'publish' | 'consent' | 'redeem' | 'reissue';

/**
 * The `CadreInvite` columns its `'add'` signature binds, in the schema's order and
 * with the row's stored forms: `expiresAt` is the engine-canonical `datetime` string
 * (`canonicalDatetime`), never epoch ms, because the SQL side digests
 * `cast(new.ExpiresAt as text)` after coercion. Structurally satisfied by a
 * `CadreInviteRow` (`types.ts`), which adds the issuer pair the signature does not cover.
 */
export interface CadreInviteSignedFields {
  key: string;
  peerId: string | null;
  grantsOwner: boolean;
  expiresAt: string | null;
  totalUses: number | null;
  stampId: string;
}

/**
 * The row-field half of a `CadreInvite` `'add'` digest, shared by the signer
 * (`control-database.ts`'s `cadreInviteAddMessage`, raw bytes) and the verifier
 * (`peer-authorization.ts`'s `cadreInviteAddDigest`, base64url) so the two cannot
 * drift. SQL mirror, in `CadreInvite.AuthorizedInsert`:
 * `new.Key, coalesce(new.PeerId, ''), cast(new.GrantsOwner as text),
 * coalesce(cast(new.ExpiresAt as text), ''), coalesce(cast(new.TotalUses as text), ''), new.StampId`.
 */
export function cadreInviteRowFields(row: CadreInviteSignedFields): string[] {
  return [
    row.key,
    row.peerId ?? '',
    row.grantsOwner ? '1' : '0',
    row.expiresAt ?? '',
    row.totalUses === null ? '' : String(row.totalUses),
    row.stampId,
  ];
}

/**
 * The full ordered field vector a party-bound control-plane signature covers. Digest
 * this with the crypto plugin's injective multi-field encoding (every field TEXT);
 * the SQL mirror passes the same literals as leading `digest(...)` arguments and
 * reads the party from its node-local `party_id()`:
 *
 *   TS:  digest(controlAuthorizationFields('CadreControl.X', 'add', partyId, [a, b]), 'sha256', ...)
 *   SQL: digest('CadreControl.X', 'add', party_id(), new.A, new.B)
 */
export function controlAuthorizationFields(
  domain: BoundControlDomain,
  action: ControlAction,
  partyId: string,
  rowFields: string[],
): string[] {
  return [domain, action, partyId, ...rowFields];
}

/**
 * The field vector of the two party-free digests ({@link UnboundControlDomain}):
 *
 *   TS:  digest(unboundAuthorizationFields('CadreControl.FormationUsage', 'consent', [a, b]), 'sha256', ...)
 *   SQL: digest('CadreControl.FormationUsage', 'consent', new.A, new.B)
 */
export function unboundAuthorizationFields(
  domain: UnboundControlDomain,
  action: ControlAction,
  rowFields: string[],
): string[] {
  return [domain, action, ...rowFields];
}
