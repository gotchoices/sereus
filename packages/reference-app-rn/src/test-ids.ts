/**
 * test-ids.ts — Stable testID strings for UI automation (Maestro).
 *
 * Centralised so both components and test flows reference identical names.
 */

export const TEST_IDS = {
	settings: {
		partyIdInput: 'input-party-id',
		bootstrapAddrInput: 'input-bootstrap-addr',
		connectBtn: 'btn-connect',
		disconnectBtn: 'btn-disconnect',
		seedInput: 'input-seed',
		applySeedBtn: 'btn-apply-seed',
		addPeerInput: 'input-add-peer',
		addPeerBtn: 'btn-add-peer',
		createStrandBtn: 'btn-create-strand',
		createClosedStrandBtn: 'btn-create-closed-strand',
		inviteInput: 'input-invite',
		joinViaInviteBtn: 'btn-join-via-invite',
		modalTitle: 'modal-title',
		modalOkBtn: 'btn-modal-ok',
	},
	chat: {
		statusBar: 'status-bar',
		messageInput: 'input-message',
		sendBtn: 'btn-send',
		messageList: 'message-list',
		/** Per-row id; pass the message Id. */
		messageRow: (id: number | string) => `message-row-${id}`,
	},
} as const;
