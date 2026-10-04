/**
 * The reference app's storage names, passed to `createPhoneNode` (`cadre-phone.ts`): the
 * prefix of each storage scope's LevelDB database, the database and key prefix the
 * `@serfab/cadre-rn/node-local` slots live in, and the key of the saved start options. Each is a persistence contract: renaming one makes every installed
 * phone lose the records filed under it. No native imports, so the names are pinned by
 * a Node test (`test/node-local-names.spec.ts`).
 */

/**
 * Prefix of each cadre-core storage scope's LevelDB database: `sereus-<scope>`, the
 * control scope carrying the party id.
 */
export const STORAGE_PREFIX = 'sereus-';

/**
 * LevelDB database holding the node-local records that are NOT trust-bearing, and
 * the saved start options. Its own database (not a strand's) so clearing it cannot
 * disturb replicated strand data.
 */
export const NODE_LOCAL_DB_NAME = 'sereus-node-local';

/** `LevelDBKVStore` key prefix inside {@link NODE_LOCAL_DB_NAME}. */
export const NODE_LOCAL_KV_PREFIX = 'sereus:node-local:';

/**
 * Key for the saved start options (the kit's saved-start record). One per install, not per
 * party: it is what names the party every other record is filed under. Nothing in it
 * is secret or trust-bearing — a group identifier and public network addresses — and a
 * relay list can outgrow the secure store's value limit, so it sits in LevelDB too.
 * Dot-free, so it cannot collide with the kit's `<record>.<partyId>` keys.
 *
 * NOTE: accepted tradeoff — the trusted-owner anchor and the saved party id do not
 * share a fate across an iOS reinstall. The Keychain survives it, this LevelDB does
 * not, so a reinstalled phone picks a new party id and the surviving anchor, filed
 * under the old one, is simply never read again. Revisit if a reinstall ever needs to
 * rejoin its old party unaided (the party id would then belong in the Keychain beside
 * the anchor).
 */
export const START_OPTIONS_KV_KEY = 'start-options';
