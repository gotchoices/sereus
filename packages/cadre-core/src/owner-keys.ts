/**
 * Owner keys as an app lists, adds and removes them (`CadreNode.listOwnerKeys`,
 * `CadreNode.addOwner`, `CadreNode.planOwnerKeyRemoval`, `CadreNode.removeOwner`): the
 * projection of the live `OwnerKey` rows an owner-key screen shows, the read-only plan behind a
 * removal's confirmation step, the check that a requested re-vouch stays inside that plan, and
 * the by-name refusals. Pure; the reads and writes themselves are `CadreNode`'s and
 * `ControlDatabase`'s.
 */

import type {
	CadreOwnerKey,
	CadrePeerRow,
	OwnerKeyAddRefusal,
	OwnerKeyDependents,
	OwnerKeyRemovalPlan,
	OwnerKeyRemovalRefusal,
	OwnerKeyRow,
	RemoveOwnerOptions,
} from './types.js';

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
 * `CadreNode.removeOwner` refused by name, before any write. `code` says which rule
 * ({@link OwnerKeyRemovalRefusal}), for an app to switch on; the message is for a log.
 */
export class OwnerKeyRemovalRefusedError extends Error {
	readonly code: OwnerKeyRemovalRefusal;
	readonly key: string;

	constructor(key: string, code: OwnerKeyRemovalRefusal) {
		super(`Cannot remove owner key ${key}: ${OWNER_KEY_REMOVAL_REFUSAL_REASON[code]}`);
		this.name = 'OwnerKeyRemovalRefusedError';
		this.code = code;
		this.key = key;
	}
}

const OWNER_KEY_REMOVAL_REFUSAL_REASON: Record<OwnerKeyRemovalRefusal, string> = {
	'not-an-owner': 'this node holds no enrolled owner key',
	'unknown': 'it is not a live owner key here',
	'last-owner': 'it is the only live owner key',
	'self': 'it is the owner key of this node, and an owner key cannot sign its own removal; ask another owner key',
	'alone': 'this node has no connection to the rest of the cadre, and an owner key re-vouched now would reach no other machine; try again once connected',
};

/** An owner key as an approval prompt names it: `"label" (key)`, or the key alone when it has no label. */
export function namedOwnerKey(key: string, label: string | null): string {
	return label === null ? key : `"${label}" (${key})`;
}

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

/** What {@link planOwnerKeyRemoval} judges from: one node's live rows and its own standing. */
export interface OwnerKeyRemovalPlanInput {
	key: string;
	/** Live `CadrePeer` rows (`ControlDatabase.queryCadrePeers`). */
	rows: readonly CadrePeerRow[];
	/** Live `OwnerKey` rows (`ControlDatabase.queryOwnerKeyRows`). */
	owners: readonly OwnerKeyRow[];
	selfPeerId: string | null;
	/** The key of this node's owner signer when it is an enrolled owner (`CadreNode.ownerSignerEnrolledIn`), or null when it cannot sign owner writes. */
	selfOwnerKey: string | null;
	/** This node's trusted-owner anchor, for the listed entry's `trusted`. */
	anchor: ReadonlySet<string>;
}

/**
 * The plan for removing owner key `key` from these rows. The refusals come first and by name: a
 * node that cannot sign; a key with no live row; the only live owner key (`MinOneOwner`), ahead
 * of `self` so a sole owner asking to remove its own key hears the rule no other owner could
 * get past either; and this node's own key, since the schema's remove branch wants a signer
 * other than the removed key. With this node enrolled, a different live key always leaves two
 * owners in one read, so `last-owner` reaches only that case, and concurrent removals elsewhere
 * leave the schema to decide.
 *
 * `dependents` are the rows the key vouched, which every reader judges against its anchor
 * through `VouchOwner`: once the key is removed they stop passing the membership predicate on
 * every machine unless re-vouched first. This node's own rows are reported as `ownDependency`
 * instead, since it cannot re-vouch them itself.
 */
export function planOwnerKeyRemoval(input: OwnerKeyRemovalPlanInput): OwnerKeyRemovalPlan {
	const row = input.owners.find((owner) => owner.key === input.key) ?? null;
	return {
		ownerKey: row === null ? null : describeOwnerKeys([row], input.selfOwnerKey, input.anchor)[0],
		refusal: removalRefusalFor(input, row !== null),
		dependents: dependentsOf(input),
		ownDependency: isOwnDependency(input),
	};
}

function removalRefusalFor(input: OwnerKeyRemovalPlanInput, live: boolean): OwnerKeyRemovalPlan['refusal'] {
	if (input.selfOwnerKey === null) {
		return 'not-an-owner';
	}
	if (!live) {
		return 'unknown';
	}
	if (input.owners.length <= 1) {
		return 'last-owner';
	}
	if (input.key === input.selfOwnerKey) {
		return 'self';
	}
	return null;
}

function dependentsOf(input: OwnerKeyRemovalPlanInput): OwnerKeyDependents {
	return {
		owners: input.owners
			.filter((owner) => owner.vouchOwner === input.key && owner.key !== input.key && owner.key !== input.selfOwnerKey)
			.map((owner) => owner.key),
		peers: input.rows
			.filter((row) => row.vouchOwner === input.key && row.peerId !== input.selfPeerId)
			.map((row) => row.peerId),
	};
}

function isOwnDependency(input: OwnerKeyRemovalPlanInput): boolean {
	const ownRow = input.rows.find((row) => row.peerId === input.selfPeerId);
	const ownOwner = input.owners.find((owner) => owner.key === input.selfOwnerKey);
	return ownRow?.vouchOwner === input.key || ownOwner?.vouchOwner === input.key;
}

/**
 * The re-vouch a caller asked for, checked against the plan: every key and peer must be in
 * `plan.dependents`, so a caller cannot re-vouch a row the removed key never vouched. Throws
 * naming the offenders, before `CadreNode.removeOwner` writes anything. Duplicates are dropped.
 */
export function revouchWithinPlan(plan: OwnerKeyRemovalPlan, revouch: RemoveOwnerOptions['revouch']): OwnerKeyDependents {
	const owners = [...new Set(revouch?.owners ?? [])];
	const peers = [...new Set(revouch?.peers ?? [])];
	const strayOwners = owners.filter((key) => !plan.dependents.owners.includes(key));
	const strayPeers = peers.filter((peerId) => !plan.dependents.peers.includes(peerId));
	if (strayOwners.length > 0 || strayPeers.length > 0) {
		throw new Error(
			`removeOwner: re-vouch names rows the removed owner key did not vouch: ${[...strayOwners, ...strayPeers].join(', ')}`,
		);
	}
	return { owners, peers };
}
