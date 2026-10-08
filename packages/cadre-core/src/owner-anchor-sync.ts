/**
 * How the node-local trusted-owner anchor follows the replicated `OwnerKey` table along
 * VERIFIABLE chains — the pure rule, with no I/O, so it can be tested without a database.
 * `CadreNode.syncOwnerAnchor` reads the table, the tombstones and the invitation chain,
 * calls {@link deriveOwnerAnchor}, and applies the difference to the store.
 *
 * Why not simply trust the table: an empty local copy can seat any key through the
 * schema's genesis branch and that row replicates (`docs/architecture.md` → "Node-local
 * trusted-owner anchor"). So every node grows its anchor only through rows whose stored
 * proof verifies against a key it already trusts, on every membership refresh. The terms
 * used throughout:
 *
 * - **base**: the anchor's entries whose provenance is not `chain` (trusted out of band).
 * - **live row**: an `OwnerKey` row whose stamp no tombstone retires.
 * - **kept**: a `chain` entry that still has a live row. A derived entry is state, not
 *   recomputed from the base each pass: it entered through a proof that verified then, and
 *   it stays until its own row is retired or a verifiable tombstone removes it. This is what
 *   lets an owner rotate (A adds A', A' removes A): A' keeps its place after A's row is
 *   retired, although nothing could re-derive it from the remaining base.
 * - **derivable from S**: a live row whose stored proof verifies against S — owner-signed
 *   (`vouchSig` set): `vouchOwner` is in S and `verifyOwnerKeyVoucher` holds;
 *   invitation-admitted (`vouchSig` null, `vouchUsage` set): `verifyInvitationOwnerAdmission`
 *   holds with S as the anchor. The founding row (all three null) is never derivable:
 *   founders enter anchors only out of band.
 * - **derived**: the least fixpoint from base ∪ kept — add every key whose live row is
 *   derivable from what is already in the set, until nothing changes. **chainDerived** is the
 *   keys whose live row was derivable in this pass, base keys included.
 * - **removed**: a key K in derived is removed when an `OwnerKey` tombstone names K, its
 *   signer is in derived and is not K, its stored signature verifies
 *   (`verifyRevocationSigner`), AND K is not in chainDerived. The last condition is what
 *   makes a re-add win over an older tombstone: a removed owner re-added under a fresh
 *   stamp has a live derivable row again, and the old stamp's tombstone no longer applies.
 * - **target** = derived minus removed. If that would be empty, no removal is applied this
 *   pass (target = derived) and the refused removals are reported for the caller to log.
 *
 * Every tombstone is judged against the pass-start set (derived) at once, so the outcome
 * does not depend on the order they are read in: a signer that is itself removed in this
 * pass still counts, and a mutual removal of the last two owners is refused rather than
 * decided by read order.
 *
 * An owner C that a removed owner B had added therefore stays where it was already derived
 * (its row is live) and cannot be derived on a machine that never held it (the chain from
 * that machine's base runs through B's retired row) until a remaining owner re-adds it or
 * an invitation pins it there. The rotation case above is the same shape with C = A', so the
 * two cannot be told apart from replicated state; keeping is the only rule under which a
 * sole owner can rotate at all.
 */
import { verifyInvitationOwnerAdmission, verifyOwnerKeyVoucher, verifyRevocationSigner } from './peer-authorization.js';
import type { TrustSource } from './trusted-owner-store.js';
import type { InvitationChain, OwnerKeyRow, RevocationRow } from './types.js';

export interface OwnerAnchorInputs {
	/** The party whose table is being read; every stored proof is judged for it, so a voucher or tombstone signed for another party neither seats nor removes a key. */
	partyId: string;
	/** The anchor at the start of the pass, every key with its provenance (`TrustedOwnerStore.sources`). */
	anchor: ReadonlyMap<string, TrustSource>;
	/** `OwnerKey` rows as read; rows whose stamp a tombstone in `tombstones` retires are dropped here too. */
	rows: readonly OwnerKeyRow[];
	/** `Revocation` rows; only those with `tableName === 'OwnerKey'` are consulted. */
	tombstones: readonly RevocationRow[];
	/** The usage and invitation rows, when some owner row is invitation-admitted; null skips those rows. */
	chain: InvitationChain | null;
}

export interface OwnerAnchorDerivation {
	/** The keys the anchor should hold after this pass. */
	target: ReadonlySet<string>;
	/** Keys whose verifiable removal was NOT applied because the anchor would have emptied. */
	refusedRemovals: readonly string[];
}

/** The rule above, as one pure function. */
export function deriveOwnerAnchor({ partyId, anchor, rows, tombstones, chain }: OwnerAnchorInputs): OwnerAnchorDerivation {
	const ownerTombstones = tombstones.filter(tombstone => tombstone.tableName === 'OwnerKey');
	// NOTE: a stamp is retired by any tombstone that names it, verified or not — the same
	// reading `queryCadrePeers` and `getOwnerKeys` give the table. A forged tombstone can
	// therefore prune a derived entry (its row goes) but never seat or keep one; if tombstone
	// pollution is ever closed at the write side, judge retirement by the verified signer too.
	const retired = new Set(ownerTombstones.map(tombstone => tombstone.stampId));
	const liveRows = rows.filter(row => !retired.has(row.stampId));

	const derived = passStartSet(anchor, liveRows);
	const chainDerived = deriveFixpoint(partyId, derived, liveRows, chain);

	const removed = removedKeys(partyId, derived, chainDerived, ownerTombstones);
	if (removed.size > 0 && removed.size === derived.size) {
		return { target: derived, refusedRemovals: Array.from(removed) };
	}
	const target = new Set(Array.from(derived).filter(key => !removed.has(key)));
	return { target, refusedRemovals: [] };
}

/** base ∪ kept: every out-of-band entry, and every `chain` entry whose row is still live. */
function passStartSet(anchor: ReadonlyMap<string, TrustSource>, liveRows: readonly OwnerKeyRow[]): Set<string> {
	const liveKeys = new Set(liveRows.map(row => row.key));
	const start = new Set<string>();
	for (const [key, source] of anchor) {
		if (source !== 'chain' || liveKeys.has(key)) {
			start.add(key);
		}
	}
	return start;
}

/**
 * Grow `derived` to the least fixpoint and return chainDerived: every key whose live row was
 * derivable. A row is judged once its voucher is in the set, and settled either way then:
 * trust only grows within a pass, and a proof that failed against a trusted voucher cannot
 * pass later, so no row is verified twice.
 */
function deriveFixpoint(partyId: string, derived: Set<string>, liveRows: readonly OwnerKeyRow[], chain: InvitationChain | null): Set<string> {
	const chainDerived = new Set<string>();
	const pending = new Set(liveRows);
	let progress = true;
	while (progress) {
		progress = false;
		for (const row of pending) {
			if (row.vouchOwner === null || !derived.has(row.vouchOwner)) {
				continue;
			}
			pending.delete(row);
			if (proofVerifies(partyId, row, derived, chain)) {
				chainDerived.add(row.key);
				derived.add(row.key);
				progress = true;
			}
		}
	}
	return chainDerived;
}

/** Does `row`'s stored proof verify against `trusted`, for `partyId`, by the kind of proof it carries (see the module doc)? */
function proofVerifies(partyId: string, row: OwnerKeyRow, trusted: ReadonlySet<string>, chain: InvitationChain | null): boolean {
	if (row.vouchOwner === null) {
		return false;
	}
	if (row.vouchSig !== null) {
		return verifyOwnerKeyVoucher(partyId, row.key, row.stampId, row.vouchOwner, row.vouchSig);
	}
	if (row.vouchUsage === null) {
		return false;
	}
	const usage = chain?.usages.get(row.vouchUsage);
	const invite = usage === undefined ? undefined : chain?.invites.get(usage.inviteKey);
	if (usage === undefined || invite === undefined) {
		return false;
	}
	return verifyInvitationOwnerAdmission(partyId, row, usage, invite, key => trusted.has(key));
}

/**
 * The keys of `derived` that a verifiable tombstone removes (see the module doc), every
 * tombstone judged against the same pass-start set. A tombstone for a key outside `derived`
 * changes nothing and is skipped before any signature work.
 */
function removedKeys(partyId: string, derived: ReadonlySet<string>, chainDerived: ReadonlySet<string>, ownerTombstones: readonly RevocationRow[]): Set<string> {
	const removed = new Set<string>();
	for (const tombstone of ownerTombstones) {
		const key = tombstone.rowKey;
		if (!derived.has(key) || chainDerived.has(key) || removed.has(key)) {
			continue;
		}
		if (tombstone.signerKey === key || !derived.has(tombstone.signerKey)) {
			continue;
		}
		if (verifyRevocationSigner(partyId, tombstone)) {
			removed.add(key);
		}
	}
	return removed;
}
