/**
 * Owner keys as an app lists and adds them (`CadreNode.listOwnerKeys`, `CadreNode.addOwner`):
 * the projection of the live `OwnerKey` rows an owner-key screen shows, and the refusal an add
 * made while this node is cut off from the rest of the cadre gets. The reads and writes
 * themselves are `CadreNode`'s and `ControlDatabase`'s.
 */

import type { CadreOwnerKey, OwnerKeyAddRefusal, OwnerKeyRow } from './types.js';

/**
 * `CadreNode.addOwner` refused by name, before any write. `code` says which rule
 * ({@link OwnerKeyAddRefusal}), for an app to switch on; the message is for a log.
 */
export class OwnerKeyAddRefusedError extends Error {
	readonly code: OwnerKeyAddRefusal;
	readonly key: string;

	constructor(key: string, code: OwnerKeyAddRefusal) {
		super(`Cannot add owner key ${key}: ${OWNER_KEY_ADD_REFUSAL_REASON[code]}`);
		this.name = 'OwnerKeyAddRefusedError';
		this.code = code;
		this.key = key;
	}
}

const OWNER_KEY_ADD_REFUSAL_REASON: Record<OwnerKeyAddRefusal, string> = {
	'alone': 'this node has no connection to the rest of the cadre, and an owner key added now would reach no other machine; try again once connected',
};

/**
 * One {@link CadreOwnerKey} per live row, in the rows' order. `heldKey` is the key of this
 * node's owner signer, if one is wired; `anchor` is this node's trusted-owner anchor.
 */
export function describeOwnerKeys(rows: readonly OwnerKeyRow[], heldKey: string | null, anchor: ReadonlySet<string>): CadreOwnerKey[] {
	return rows.map((row) => ({
		key: row.key,
		label: row.label,
		vouchedBy: row.vouchOwner,
		heldHere: row.key === heldKey,
		trusted: anchor.has(row.key),
	}));
}
