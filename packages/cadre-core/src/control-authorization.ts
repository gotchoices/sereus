/**
 * The single definition of the field vector every signed control-plane message
 * covers. Both producers of signed bytes — `control-database.ts`'s
 * `buildAuthorizationMessage` (raw digest bytes) and `peer-authorization.ts`'s
 * digest helpers (base64url digest strings) — build their vector here, so the
 * byte layout cannot drift between them or away from the SQL constraints in
 * `schemas/control.qsql`.
 *
 * Every vector leads with two fixed literals:
 *
 *   digest(<domain>, <action>, <row field 1>, ..., <row field n>)
 *
 * so a signature verifies ONLY against the one rule it was minted for. Without
 * the tags, several rules built byte-identical tuples (e.g. `ValidationKey`
 * insert and `OwnerKey` insert both signed `digest(Key, StampId)`), so an
 * approval for a narrow grant doubled as an approval for full ownership.
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
 */
export const CONTROL_TABLES = [
  'OwnerKey',
  'ValidationKey',
  'Strand',
  'CadrePeer',
  'DeviceToken',
  'FormationInvite',
  'FormationUsage',
] as const;

/**
 * Name of a CadreControl table. Doubles as the table half of a
 * {@link ControlDomain} tag.
 */
export type ControlTable = typeof CONTROL_TABLES[number];

/**
 * What a signature authorizes, scoped to one table rule — or, for
 * `'Cadre.Enrollment'`, the offline peer vouch that `cadre enroll register`
 * verifies (no table checks it, so it needs its own domain to stay disjoint
 * from every table rule).
 */
export type ControlDomain = `CadreControl.${ControlTable}` | 'Cadre.Enrollment';

/**
 * The action half of the tag:
 *  - `'add'` / `'remove'` — insert / delete of the named row.
 *  - `'vouch'` — an owner (or validation key) vouches the row's semantics
 *    without adding or removing it: the `CadrePeer` membership vouch (shared,
 *    deliberately, by its insert and its owner-update branch), the
 *    `DeviceToken` owner re-touch, the `FormationUsage` disclosure validation,
 *    and the offline enrollment vouch.
 *  - `'publish'` — a peer self-signs its OWN record (the `CadrePeer` /
 *    `DeviceToken` self-update branches), with its own key rather than an
 *    owner key.
 */
export type ControlAction = 'add' | 'remove' | 'vouch' | 'publish';

/**
 * The full ordered field vector a control-plane signature covers. Digest this
 * with the crypto plugin's injective multi-field encoding (every field TEXT);
 * the SQL mirror passes the same literals as leading `digest(...)` arguments:
 *
 *   TS:  digest(controlAuthorizationFields('CadreControl.X', 'add', [a, b]), 'sha256', ...)
 *   SQL: digest('CadreControl.X', 'add', new.A, new.B)
 */
export function controlAuthorizationFields(
  domain: ControlDomain,
  action: ControlAction,
  rowFields: string[],
): string[] {
  return [domain, action, ...rowFields];
}
