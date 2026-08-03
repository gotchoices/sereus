/**
 * test-ids.ts — Stable automation identifiers for UI automation (Maestro).
 *
 * Centralised so both the XML views (via `automationText`) and the e2e flows
 * reference identical names. Ported from packages/reference-app-rn/src/test-ids.ts;
 * in NativeScript these strings are surfaced through each view's `automationText`
 * (→ iOS accessibilityIdentifier / Android content-description) rather than RN's
 * `testID`.
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
		peerId: 'value-peer-id',
		modalTitle: 'modal-title',
		modalOkBtn: 'btn-modal-ok',
	},
	chat: {
		statusBar: 'status-bar',
		messageInput: 'input-message',
		sendBtn: 'btn-send',
		messageList: 'message-list',
		/** Per-row id; pass the message Id. */
		messageRow: (id: number | string): string => `message-row-${id}`,
	},
} as const;
