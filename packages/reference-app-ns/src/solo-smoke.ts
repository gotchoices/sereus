/**
 * solo-smoke.ts — the runtime-validation core of the NS parity effort.
 *
 * Boots a CadreNode in solo/forming mode (no drone, no network), creates a
 * local chat strand, inserts a message, and reads it back — proving the full
 * cadre / db-p2p / Quereus / Optimystic stack runs on the NativeScript V8/JSC
 * runtime. A programmatic helper (the chat UI now exercises the same path via
 * Settings → Connect → Create Strand → Chat); intended to be run on a
 * device/emulator (out-of-band — see README).
 */

import { startSolo } from './cadre-phone';
import { createChatStrand } from './chat-strand';
import {
	insertParticipant,
	insertMessage,
	newChatMessageId,
	queryMessages,
	type ChatMessage,
} from './chat-operations';

const DEFAULT_PARTY_ID = 'reference-chat-party-ns';

export interface SoloSmokeResult {
	/** Control-network PeerId — stable across cold launches (key in SQLite kv). */
	peerId: string;
	/** The created strand's id. */
	strandId: string;
	/** Messages read back after the local insert. */
	messages: ChatMessage[];
	/** Whether the inserted message was echoed back by the query. */
	echoed: boolean;
}

/**
 * Run the solo local-echo smoke. Idempotent at the node level (startSolo reuses
 * a running node) but creates a fresh strand per call.
 */
export async function runSoloSmoke(message = 'hello'): Promise<SoloSmokeResult> {
	const node = await startSolo(DEFAULT_PARTY_ID);

	const strandId = crypto.randomUUID();
	const strand = await createChatStrand(node, strandId);

	const participantId = crypto.randomUUID();
	await insertParticipant(strand, participantId, 'NS Solo');
	// Minted here: the smoke writes once and never re-presents the write, so nothing needs to
	// hold the key across attempts (the chat composer does — `chat-vm.ts`).
	await insertMessage(strand, newChatMessageId(), participantId, message);

	const messages = await queryMessages(strand);
	const echoed = messages.some((m) => m.Content === message);

	return {
		peerId: node.getControlNode()?.peerId.toString() ?? '(unknown)',
		strandId,
		messages,
		echoed,
	};
}
