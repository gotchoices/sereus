/**
 * `EdgeNode.redeemOwnerGrant`'s sequence: make the app an owner of the party it runs in with
 * owner-grant text, seating the owner slot's key (docs/architecture.md → "Owner grants"). Runs
 * over a narrow view of the runtime ({@link OwnerGrantRuntime}), inside one of its transitions,
 * as the join does.
 */

import type { CadreNode } from '../cadre-node.js';
import { decodeOwnerGrant, OwnerGrantRejectedError } from '../owner-grant-protocol.js';
import type { OwnerSigner } from '../owner-signer.js';
import type { OwnerGenesisResult } from './config.js';

/** The part of the edge-node runtime a redemption drives; the join's view has the same two calls. */
export interface OwnerGrantRuntime {
	/** The owner slot's key, created when the slot is empty: the key an owner grant seats. */
	ownerSlotSigner(): Promise<OwnerSigner>;
	/** `granted`: an owner grant has just seated the slot's key, so wait for the row. */
	wireJoinedOwner(node: CadreNode, granted: boolean): Promise<OwnerGenesisResult>;
}

/** What {@link redeemOwnerGrantText} settled. */
export interface RedeemedOwnerGrant {
	/** The owner slot's key: the one the grant seated, or found already an owner. */
	ownerKey: string;
	/** The key was already a live owner of the party: nothing was signed or written, and the grant spent no use. */
	alreadyOwner: boolean;
	/**
	 * The key is wired as the node's owner signer. False when its row has not reached this node
	 * within the owner-step bound (a redemption at another member); a later start wires it.
	 */
	wired: boolean;
}

/**
 * Decode `text`, refuse a grant for another party, answer a slot key that is already an owner
 * here, else redeem the grant for the slot's key (`CadreNode.redeemOwnerGrant`) and wire it.
 *
 * The already-owner answer comes first because the redemption's local path refuses `alone`
 * before it asks whether the key is an owner, and a device that is one should hear so whether
 * or not it is connected.
 *
 * @throws the decoder's error for text that is not an owner grant; `OwnerGrantRejectedError`
 *   `party-mismatch` for a grant of another party, the code a member serving another cadre answers;
 *   and what `CadreNode.redeemOwnerGrant` throws.
 */
export async function redeemOwnerGrantText(runtime: OwnerGrantRuntime, node: CadreNode, text: string): Promise<RedeemedOwnerGrant> {
	const bundle = decodeOwnerGrant(text);
	if (bundle.partyId !== node.partyId) {
		throw new OwnerGrantRejectedError('party-mismatch', `This grant is for cadre ${bundle.partyId}, not the one this app runs in`);
	}
	// NOTE: a key created here stays in the slot when the redemption then fails, as a failed grant
	// join's does (`edge-join.ts`), so a later import of a different exported key is refused as
	// slot-occupied until a grant seats this one. If users meet that, delete a key this call created
	// when the refusal is one that wrote nothing (every refusal but an unreachable member or an
	// unverifiable reply, after either of which the row may exist).
	const signer = await runtime.ownerSlotSigner();
	if (await node.wireOwnKeyIfOwner(signer)) {
		return { ownerKey: signer.publicKey, alreadyOwner: true, wired: true };
	}
	const { alreadyOwner } = await node.redeemOwnerGrant(bundle, signer);
	const wired = (await runtime.wireJoinedOwner(node, true)) === 'enrolled';
	return { ownerKey: signer.publicKey, alreadyOwner, wired };
}
