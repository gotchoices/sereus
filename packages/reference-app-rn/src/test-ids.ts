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
		enrollInviteInput: 'input-enroll-invite',
		applySeedBtn: 'btn-apply-seed',
		addPeerInput: 'input-add-peer',
		addPeerBtn: 'btn-add-peer',
		createStrandBtn: 'btn-create-strand',
		createClosedStrandBtn: 'btn-create-closed-strand',
		inviteInput: 'input-invite',
		joinViaInviteBtn: 'btn-join-via-invite',
		ownerKeyRow: 'row-owner-key',
		modalTitle: 'modal-title',
		modalOkBtn: 'btn-modal-ok',
	},
	chat: {
		statusBar: 'status-bar',
		messageInput: 'input-message',
		sendBtn: 'btn-send',
		messageList: 'message-list',
		/** Horizontal row of selectable strand chips. */
		strandPicker: 'chat-strand-picker',
		/** Renders the FULL active strand id (for Maestro determinism asserts). */
		strandLabel: 'chat-strand-label',
		/** Per-chip id; pass the strand id. */
		strandRow: (id: string) => `chat-strand-${id}`,
		/** Per-row id; pass the message Id. */
		messageRow: (id: number | string) => `message-row-${id}`,
	},
} as const;
