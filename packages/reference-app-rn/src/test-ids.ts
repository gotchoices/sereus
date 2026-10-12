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
		/** First launch, no cadre yet: "Do you already use Sereus apps?" — Yes shows the join section, No the Connect form. */
		firstLaunchJoinBtn: 'btn-first-launch-join',
		firstLaunchFreshBtn: 'btn-first-launch-fresh',
		/** After Yes: back to the question. */
		firstLaunchBackBtn: 'btn-first-launch-back',
		disconnectBtn: 'btn-disconnect',
		seedInput: 'input-seed',
		applySeedBtn: 'btn-apply-seed',
		/** Join my existing cadre: opens the app holding the cadre with this app's request (Android's chooser, or the iOS list below). */
		chooseOwnerAppBtn: 'btn-choose-owner-app',
		/** iOS: one installed Sereus app in the list; pass its scheme. */
		ownerAppOption: (scheme: string) => `btn-owner-app-${scheme}`,
		/** iOS: the list's line when no other Sereus app is installed, and its Close button. */
		ownerAppListEmpty: 'text-owner-app-list-empty',
		ownerAppListCloseBtn: 'btn-owner-app-list-close',
		/** "Waiting for ‹app› to answer…" while a request opened as a link is open, and its Cancel. */
		linkRequestWaiting: 'text-link-request-waiting',
		cancelLinkRequestBtn: 'btn-cancel-link-request',
		/** This app's own request opened this app again (picked in Android's chooser). */
		linkRequestReturned: 'text-link-request-returned',
		/** Join my existing cadre: the `ShareCode` prefix of this app's join request; see `shareCodeText` and `shareCodeCopyBtn`. */
		joinRequestShare: 'join-request',
		/** A pasted response or open invitation (`sereus-invite:1.…`), redeemed by `btn-join-cadre`. */
		cadreInvitationInput: 'input-cadre-invitation',
		/** Opens the camera to scan a response or invitation. */
		scanCadreInvitationBtn: 'btn-scan-cadre-invitation',
		joinCadreBtn: 'btn-join-cadre',
		/** The join flow's line and its detail line, shown in place of the inputs from Join on. */
		joinFlowLine: 'text-join-flow',
		joinFlowDetail: 'text-join-flow-detail',
		/** While the join waits for a member: go back to this app's own cadre. */
		cancelJoinBtn: 'btn-cancel-join',
		/** After a move that did not finish: Retry moving, or Later (also offered while the old cadre remains). */
		retryStrandMoveBtn: 'btn-retry-strand-move',
		joinFlowLaterBtn: 'btn-join-flow-later',
		/** The old cadre holds what the joined one does not: Delete them with it, or Keep the old cadre. */
		discardOldCadreItemsBtn: 'btn-discard-old-cadre-items',
		keepOldCadreBtn: 'btn-keep-old-cadre',
		/** The old cadre is still on this phone: Remove it now. */
		removeOldCadreBtn: 'btn-remove-old-cadre',
		/** Clears a finished flow (done, or the old cadre kept). */
		joinFlowOkBtn: 'btn-join-flow-ok',
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
		/** Add a device or app: another app's pasted join request (`sereus-join-request:1.…`), read by `btn-use-join-request`. */
		joinRequestInput: 'input-join-request',
		/** Opens the camera to scan another app's join request. */
		scanJoinRequestBtn: 'btn-scan-join-request',
		useJoinRequestBtn: 'btn-use-join-request',
		/**
		 * The join request's approval prompt: its "Also an owner" switch, and mint the invitation or not
		 * (Add / Cancel; Allow / Deny for a request another app on this phone opened this one with).
		 */
		requestOwnerSwitch: 'switch-request-owner',
		approveJoinRequestBtn: 'btn-approve-join-request',
		cancelJoinRequestBtn: 'btn-cancel-join-request',
		/** What became of the last join request another app opened this one with (sent, or ignored). */
		joinRequestLinkNotice: 'text-join-request-link-notice',
		/** On the Node card: a join request another app opened this one with waits for Connect. */
		waitingJoinRequest: 'text-waiting-join-request',
		/** The open invitation's "Also an owner" switch, and the button that mints it. */
		openInviteOwnerSwitch: 'switch-open-invite-owner',
		makeInvitationBtn: 'btn-make-invitation',
		/** The `ShareCode` prefix of a minted invitation; see `shareCodeText` and `shareCodeCopyBtn`. */
		invitationShare: 'invitation',
		/** Clears the minted invitation off the screen. */
		invitationDoneBtn: 'btn-invitation-done',
		/** Re-reads the outstanding invitations. */
		refreshInvitationsBtn: 'btn-refresh-invitations',
		/** Per-row Withdraw on an outstanding invitation; pass the invitation's key. */
		withdrawInvitationBtn: (key: string) => `btn-withdraw-invitation-${key}`,
		/** The withdraw confirmation's buttons. */
		confirmWithdrawBtn: 'btn-confirm-withdraw-invitation',
		cancelWithdrawBtn: 'btn-cancel-withdraw-invitation',
		/** A `ShareCode`'s selectable text and its Copy button; pass the component's `testIDPrefix`. */
		shareCodeText: (prefix: string) => `text-${prefix}-code`,
		shareCodeCopyBtn: (prefix: string) => `btn-${prefix}-copy`,
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
