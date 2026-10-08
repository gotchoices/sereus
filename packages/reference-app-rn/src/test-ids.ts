/**
 * test-ids.ts — Stable testID strings for UI automation (Maestro).
 *
 * Centralised so both components and test flows reference identical names.
 */

export const TEST_IDS = {
	settings: {
		partyIdInput: 'input-party-id',
		bootstrapAddrInput: 'input-bootstrap-addr',
		/** Circuit-relay multiaddr(s) this phone reserves through — what makes it invitable. */
		relayAddrInput: 'input-relay-addr',
		/** One option of the "Connection encryption" choice; pass the mode (`symmetric`, `full`, `off`). */
		noiseCryptoOption: (mode: string) => `option-noise-crypto-${mode}`,
		/** Connected Node card row naming the mode the running node was built with. */
		noiseCryptoRow: 'row-noise-crypto',
		connectBtn: 'btn-connect',
		disconnectBtn: 'btn-disconnect',
		seedInput: 'input-seed',
		applySeedBtn: 'btn-apply-seed',
		/** A pasted cadre invitation, redeemed by `btn-join-cadre`. */
		cadreInvitationInput: 'input-cadre-invitation',
		joinCadreBtn: 'btn-join-cadre',
		addPeerInput: 'input-add-peer',
		addPeerBtn: 'btn-add-peer',
		createStrandBtn: 'btn-create-strand',
		createClosedStrandBtn: 'btn-create-closed-strand',
		inviteInput: 'input-invite',
		joinViaInviteBtn: 'btn-join-via-invite',
		/** Opens the camera to scan a cadre-host node code. */
		scanNodeCodeBtn: 'btn-scan-node-code',
		/** Closes the camera without a scan. */
		scannerCloseBtn: 'btn-scanner-close',
		/** A pasted node code (`sereus-join:…`), read by `btn-use-node-code`. */
		nodeCodeInput: 'input-node-code',
		useNodeCodeBtn: 'btn-use-node-code',
		/** The approval prompt's buttons: claim the node into this cadre, or not. */
		approveNodeClaimBtn: 'btn-approve-node-claim',
		cancelNodeClaimBtn: 'btn-cancel-node-claim',
		/** Progress line while a node claim runs. */
		nodeClaimProgress: 'text-node-claim-progress',
		/** After a failed claim that may succeed again: Try again with the kept code, or Discard it. */
		retryNodeClaimBtn: 'btn-retry-node-claim',
		discardNodeClaimBtn: 'btn-discard-node-claim',
		/** On the disconnected Node card: a node code opened from another app waits for Connect. */
		waitingNodeCode: 'text-waiting-node-code',
		ownerKeyRow: 'row-owner-key',
		modalTitle: 'modal-title',
		/** Elapsed-time line under the modal title; shown only for strand-creation results. */
		modalDetail: 'modal-detail',
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
