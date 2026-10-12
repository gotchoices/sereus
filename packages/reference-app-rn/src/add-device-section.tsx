/**
 * add-device-section.tsx — Settings → "Add a device or app": an owner of this cadre makes
 * an invitation another app redeems to join it (docs/architecture.md → "Handing an
 * invitation from app to app").
 *
 * Two ways in. **Paste request** (recommended): the other app's join request names its
 * peer id, and after the owner approves, the invitation can be redeemed by that app alone.
 * **Copy invitation**: an open invitation that whoever holds the text can redeem. Either
 * way the invitation shows as a QR code and as text until Done; this phone keeps no copy of
 * the text. The cadre holds the invitation's row, which the outstanding list reads and
 * Withdraw retires.
 *
 * A request another app on this phone opened this one with, carrying a reply, is answered back
 * to that app instead (`join-link.ts`): the invitation, or why there is none.
 *
 * The encoded invitation carries its private key: log the row's key only.
 */

import { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import {
	CADRE_JOIN_REQUEST_PREFIX,
	decodeCadreJoinRequest,
	OWNER_INVITATION_DEFAULT_TTL_MS,
	parseNullableStoredDatetimeMs,
	type CadreInvitationReach,
	type CadreInviteStatus,
	type CadreJoinRequest,
	type CreateCadreInvitationOptions,
} from '@serfab/cadre-core';
import type { JoinRefusal } from '@serfab/cadre-rn/app-link';
import { useCadre } from './cadre-context';
import { CodeScanner } from './code-scanner';
import { answerJoinRequest, isAnswerable, OWN_REQUEST_LINE, type AnswerableJoinRequest } from './join-link';
import { Btn, controlStyles, Fact, LabelledInput, Section, shortPeerId } from './settings-controls';
import { ShareCode } from './share-code';
import { TEST_IDS } from './test-ids';

const SECTION_TITLE = 'Add a device or app';

const OWNER_SWITCH_LINE = 'An owner can add and remove devices and apps and approve everything in this cadre. Turn this off for an app that should only take part.';

const LINKED_PROMPT_TITLE = 'An app on this phone asks to join your cadre';

const LINKED_GRANT_LINE = 'Allowing lets it take part in your cadre. With Also an owner on, it can also add and remove devices and apps and approve everything in the cadre.';

/**
 * After a Deny, requests from another app are answered `denied` without a prompt for this long.
 * It bounds the prompts to one per this period whatever peer ids a repeating app sends, and
 * the user sees such an app anyway, since opening another app needs it in the foreground.
 */
const DENY_COOLDOWN_MS = 30_000;

/** Shown before an open owner invitation is made: whoever holds its text becomes an owner. */
const BEARER_WARNING = `Anyone who gets this invitation in the next ${OWNER_INVITATION_DEFAULT_TTL_MS / 60_000} minutes can manage your cadre. Send it only to your own app, and not through a chat or email others can read.`;

// Chosen on the relay status, not on which error core threw, so it states only what that
// status shows: the cadre's other machines are not checked here.
const NO_ADDRESS_LINE = 'This phone has no relay address, so an invitation can be made only while an always-on machine of your cadre has one.';

/** What a minted invitation's reach means for the new app; nothing to add when it is `anywhere`. */
const REACH_LINE: Record<CadreInvitationReach, { text: string; warning: boolean } | null> = {
	anywhere: null,
	'local-network': {
		text: 'Your cadre\'s other machines are reachable only on their home network: the new app must be on the same Wi-Fi to join.',
		warning: false,
	},
	'issuer-only': {
		text: 'No always-on machine of your cadre can answer this invitation, so the new app can join only while this app is open and reachable. Add an always-on node (below) to avoid this.',
		warning: true,
	},
};

type ShowAlert = (title: string, message: string, detail?: string) => void;

/** Whether this app may mint invitations, which only an owner of the cadre can. */
type Standing = 'checking' | 'owner' | 'member' | 'unreadable';

interface MintedInvitation {
	/** The row's key, which Withdraw names. */
	key: string;
	title: string;
	encoded: string;
	reach: CadreInvitationReach;
	expiresAtMs: number | null;
	/** Why it is shown for copying when it was meant to go back to the app that asked. */
	note?: string;
}

/** A read request waiting for the owner's approval. */
interface PendingRequest {
	request: CadreJoinRequest;
	/** The same request when it arrived as a link carrying a reply: the outcome is answered back to it. */
	answerTo: AnswerableJoinRequest | null;
}

// NOTE: screen state, as in AddNodeSection: the tab navigator keeps Settings mounted, so a
// minted invitation stays on screen across a tab switch. If Settings is ever unmounted on
// blur, it would be lost (the cadre still holds its row, and the list shows it), and so would
// the Deny cooldown.
export function AddDeviceSection({ showAlert, linkedRequest = null, onLinkedRequestTaken }: {
	showAlert: ShowAlert;
	/** A join request opened from another app on this phone, decoded by Settings and not yet handled. */
	linkedRequest?: CadreJoinRequest | null;
	onLinkedRequestTaken?: () => void;
}) {
	const cadre = useCadre();
	const [standing, setStanding] = useState<Standing>('checking');
	const [requestText, setRequestText] = useState('');
	const [scannerOpen, setScannerOpen] = useState(false);
	// The approval prompt shows while it is set.
	const [pending, setPending] = useState<PendingRequest | null>(null);
	const [requestOwner, setRequestOwner] = useState(true);
	const [openOwner, setOpenOwner] = useState(true);
	const [minting, setMinting] = useState(false);
	// Catches the same-frame double tap that `disabled` cannot: the prop only takes effect
	// after the re-render `setMinting` schedules.
	const mintingRef = useRef(false);
	const [minted, setMinted] = useState<MintedInvitation | null>(null);
	const [invitations, setInvitations] = useState<CadreInviteStatus[]>([]);
	const [listError, setListError] = useState<string | null>(null);
	// The invitation the withdraw confirmation is for; the prompt shows while it is set.
	const [withdrawing, setWithdrawing] = useState<CadreInviteStatus | null>(null);
	// What became of the last request opened from another app; cleared by the next one.
	const [linkNotice, setLinkNotice] = useState<string | null>(null);
	// When the user last denied a request from another app (`performance.now()`), for DENY_COOLDOWN_MS.
	const deniedAtRef = useRef(Number.NEGATIVE_INFINITY);

	const checkStanding = async () => {
		try {
			setStanding(await cadre.isOwnerDevice() ? 'owner' : 'member');
		} catch (err) {
			console.warn('[settings] could not read this cadre\'s owner keys:', err);
			setStanding('unreadable');
		}
	};

	const refreshInvitations = async () => {
		try {
			setInvitations(outstanding(await cadre.listCadreInvitations()));
			setListError(null);
		} catch (err) {
			console.warn('[settings] could not read this cadre\'s invitations:', err);
			setListError(errorMessage(err));
		}
	};

	const refresh = async () => {
		await checkStanding();
		await refreshInvitations();
	};

	// A join replaces the node, and the owner standing may change with it.
	useEffect(() => {
		void refresh();
	}, [cadre.node]);

	/** A pasted or scanned request. */
	const handleRequestText = (text: string) => {
		let request: CadreJoinRequest;
		try {
			request = decodeCadreJoinRequest(text);
		} catch (err) {
			showAlert('Cannot use this request', errorMessage(err));
			return;
		}
		void handleRequest(request, false);
	};

	/**
	 * Check a request, then prompt. `viaLink`: another app on this phone opened this one with
	 * it. Only then is a reply used, so a request pasted here never makes this app open another.
	 */
	const handleRequest = async (request: CadreJoinRequest, viaLink: boolean) => {
		if (request.peerId === cadre.peerId) {
			showAlert('Cannot use this request', OWN_REQUEST_LINE);
			return;
		}
		const answerTo = viaLink && isAnswerable(request) ? request : null;
		if (answerTo && performance.now() - deniedAtRef.current < DENY_COOLDOWN_MS) {
			console.info(`[settings] denied a join request from ${answerTo.appName} without asking: one was denied under ${DENY_COOLDOWN_MS / 1000} s ago`);
			void answerJoinRequest(answerTo, { refused: 'denied' });
			return;
		}
		// What is an alert for a pasted request is the answer for one that says where to send it.
		const refuse = (refused: JoinRefusal, title: string, message: string) => {
			if (answerTo) void answerJoinRequest(answerTo, { refused });
			else showAlert(title, message);
		};
		try {
			// The approval prompt renders only in the owner view, so a request opened from
			// another app while the standing was still unread (or unreadable) settles it here.
			const owner = await cadre.isOwnerDevice();
			setStanding(owner ? 'owner' : 'member');
			if (!owner) {
				refuse('not-owner', 'Only an owner can add a device or app', 'This app is a member of this cadre, not an owner.');
				return;
			}
			if (await cadre.isMemberPeer(request.peerId)) {
				refuse('already-member', 'Already in this cadre', `${request.appName} is already in this cadre.`);
				return;
			}
		} catch (err) {
			// Not answered: nothing is known about this cadre to answer with. The asking app's
			// waiting line and Cancel cover it.
			console.warn('[settings] could not read this cadre\'s owners and machines:', err);
			showAlert('Cannot use this request right now', 'Could not read this cadre\'s owners and machines. Try again.', errorMessage(err));
			return;
		}
		setRequestOwner(true);
		setPending({ request, answerTo });
	};

	// NOTE: the scanner closes and the approval prompt (or an alert) opens in the same
	// moment, as in AddNodeSection; see the NOTE there if iOS drops the second Modal.
	const handleScanned = (text: string) => {
		setScannerOpen(false);
		handleRequestText(text);
	};

	// One request at a time: one that arrives while a prompt is open or an invitation is
	// being made is dropped, not queued, so the prompt on screen is the one the user acted on.
	useEffect(() => {
		if (linkedRequest === null) return;
		onLinkedRequestTaken?.();
		if (mintingRef.current || pending) {
			setLinkNotice('A join request opened from another app was ignored: finish the one on screen first.');
			return;
		}
		setLinkNotice(null);
		setScannerOpen(false);
		void handleRequest(linkedRequest, true);
	}, [linkedRequest]);

	const showMintFailure = (err: unknown) => {
		// The core error names the cause; the relay line says why this phone cannot be the
		// address the invitation carries, when that is the case.
		if (cadre.relayStatus === 'reserved') {
			showAlert('Could not make an invitation', errorMessage(err));
		} else {
			showAlert('Could not make an invitation', NO_ADDRESS_LINE, errorMessage(err));
		}
	};

	/** Mint an invitation; null when none was made, after an alert saying why. */
	const mint = async (options: CreateCadreInvitationOptions, title: string): Promise<MintedInvitation | null> => {
		if (mintingRef.current) return null;
		mintingRef.current = true;
		setMinting(true);
		try {
			const { invitation, encoded, reach } = await cadre.createCadreInvitation(options);
			const { key, expiresAt } = invitation.invite;
			console.info(`[settings] made cadre invitation ${key} (for ${options.peerId ?? 'anyone'}, owner ${options.grantsOwner}, reach ${reach})`);
			void refreshInvitations();
			return { key, title, encoded, reach, expiresAtMs: parseNullableStoredDatetimeMs(expiresAt) };
		} catch (err) {
			console.warn('[settings] making a cadre invitation failed:', err);
			showMintFailure(err);
			return null;
		} finally {
			mintingRef.current = false;
			setMinting(false);
		}
	};

	const makeOpenInvitation = async () => {
		const made = await mint({ grantsOwner: openOwner }, 'Open invitation');
		if (made) setMinted(made);
	};

	const approveRequest = async ({ request, answerTo }: PendingRequest) => {
		const made = await mint({ peerId: request.peerId, grantsOwner: requestOwner }, `Invitation for ${request.appName}`);
		if (!made) return;
		if (!answerTo) {
			setRequestText('');
			setMinted(made);
		} else if (await answerJoinRequest(answerTo, { invitation: made.encoded })) {
			setLinkNotice(`Sent an invitation to ${request.appName}.`);
		} else {
			setMinted({ ...made, note: `Could not open ${request.appName}; copy this invitation into it.` });
		}
	};

	const handleApprove = () => {
		const approved = pending;
		setPending(null);
		if (approved) void approveRequest(approved);
	};

	// Cancel for a pasted request; Deny, answered back, for one another app opened this one with.
	const handleDeny = () => {
		const answerTo = pending?.answerTo;
		setPending(null);
		if (!answerTo) return;
		deniedAtRef.current = performance.now();
		void answerJoinRequest(answerTo, { refused: 'denied' });
	};

	const withdraw = async (key: string) => {
		try {
			if (!await cadre.withdrawCadreInvitation(key)) {
				console.info(`[settings] cadre invitation ${key} was already withdrawn`);
			}
			if (minted?.key === key) setMinted(null);
		} catch (err) {
			console.warn(`[settings] withdrawing cadre invitation ${key} failed:`, err);
			showAlert('Could not withdraw the invitation', errorMessage(err));
		}
		await refreshInvitations();
	};

	const handleConfirmWithdraw = () => {
		const status = withdrawing;
		setWithdrawing(null);
		if (status) void withdraw(status.invite.key);
	};

	if (standing !== 'owner') {
		return (
			<Section title={SECTION_TITLE}>
				{standing === 'member' && (
					<Text style={controlStyles.hint}>Only an owner of this cadre can add a device or app. This app is a member.</Text>
				)}
				{standing === 'unreadable' && (
					<>
						<Text style={controlStyles.hint}>Could not check whether this app is an owner of this cadre.</Text>
						<Btn label="Try again" onPress={() => void refresh()} testID={TEST_IDS.settings.refreshInvitationsBtn} />
					</>
				)}
			</Section>
		);
	}

	return (
		<Section title={SECTION_TITLE}>
			{/* Above both views: a sent invitation's notice belongs with whichever is on screen. */}
			{linkNotice && <Text style={controlStyles.hint} testID={TEST_IDS.settings.joinRequestLinkNotice}>{linkNotice}</Text>}
			{minted ? (
				<MintedView minted={minted} onDone={() => setMinted(null)} />
			) : (
				<>
					<Text style={styles.subTitle}>Paste request</Text>
					<Text style={controlStyles.hint}>
						In the other app, choose Join my existing cadre and copy its request, then paste or scan it here. Only that app can use the invitation this makes.
					</Text>
					<LabelledInput label="The other app's request" value={requestText} onChangeText={setRequestText} placeholder="sereus-join-request:1.…" multiline testID={TEST_IDS.settings.joinRequestInput} />
					<Btn label="Scan request" onPress={() => setScannerOpen(true)} disabled={minting} testID={TEST_IDS.settings.scanJoinRequestBtn} />
					<Btn label="Use request" onPress={() => handleRequestText(requestText)} disabled={minting || !requestText.trim()} testID={TEST_IDS.settings.useJoinRequestBtn} />

					<Text style={styles.subTitle}>Copy invitation</Text>
					<Text style={controlStyles.hint}>
						An open invitation: whichever app is given its text first can join with it.
					</Text>
					<OwnerSwitch value={openOwner} onChange={setOpenOwner} testID={TEST_IDS.settings.openInviteOwnerSwitch} />
					{openOwner && <Text style={controlStyles.slowHint}>{BEARER_WARNING}</Text>}
					<Btn
						label={minting ? 'Making the invitation…' : 'Make invitation'}
						onPress={() => void makeOpenInvitation()}
						disabled={minting}
						testID={TEST_IDS.settings.makeInvitationBtn}
					/>
				</>
			)}

			<OutstandingInvitations
				invitations={invitations}
				listError={listError}
				onWithdraw={setWithdrawing}
				onRefresh={() => void refresh()}
			/>

			<CodeScanner
				visible={scannerOpen}
				accepts={isJoinRequest}
				hint="Point the camera at the request the other app shows under Join my existing cadre."
				otherCodeHint="That is not a join request. Point the camera at the request the other app shows under Join my existing cadre."
				onScanned={handleScanned}
				onClose={() => setScannerOpen(false)}
			/>
			<RequestPrompt
				pending={pending}
				grantsOwner={requestOwner}
				onGrantsOwnerChange={setRequestOwner}
				onApprove={handleApprove}
				onDeny={handleDeny}
			/>
			<WithdrawPrompt open={withdrawing !== null} onConfirm={handleConfirmWithdraw} onCancel={() => setWithdrawing(null)} />
		</Section>
	);
}

function MintedView({ minted, onDone }: { minted: MintedInvitation; onDone: () => void }) {
	const reachLine = REACH_LINE[minted.reach];
	return (
		<View>
			{minted.note && <Text style={controlStyles.slowHint}>{minted.note}</Text>}
			<ShareCode title={minted.title} text={minted.encoded} testIDPrefix={TEST_IDS.settings.invitationShare} />
			<Text style={controlStyles.hint}>{validUntilText(minted.expiresAtMs)}</Text>
			{reachLine && <Text style={reachLine.warning ? controlStyles.slowHint : controlStyles.hint}>{reachLine.text}</Text>}
			<Btn label="Done" onPress={onDone} color="#444" testID={TEST_IDS.settings.invitationDoneBtn} />
		</View>
	);
}

/** `explained`: show what an owner can do under the switch; off where the prompt says it above. */
function OwnerSwitch({ value, onChange, testID, explained = true }: { value: boolean; onChange: (value: boolean) => void; testID: string; explained?: boolean }) {
	return (
		<View>
			<View style={styles.switchRow}>
				<Text style={styles.switchLabel}>Also an owner</Text>
				<Switch value={value} onValueChange={onChange} testID={testID} />
			</View>
			{explained && <Text style={controlStyles.hint}>{OWNER_SWITCH_LINE}</Text>}
		</View>
	);
}

function OutstandingInvitations({ invitations, listError, onWithdraw, onRefresh }: {
	invitations: CadreInviteStatus[];
	listError: string | null;
	onWithdraw: (status: CadreInviteStatus) => void;
	onRefresh: () => void;
}) {
	return (
		<View>
			<Text style={styles.subTitle}>Outstanding invitations</Text>
			{listError && <Text style={controlStyles.slowHint}>Could not read the invitations: {listError}</Text>}
			{!listError && invitations.length === 0 && <Text style={controlStyles.hint}>None.</Text>}
			{invitations.map((status) => (
				<InvitationRow key={status.invite.key} status={status} onWithdraw={() => onWithdraw(status)} />
			))}
			<Btn label="Refresh" onPress={onRefresh} color="#444" testID={TEST_IDS.settings.refreshInvitationsBtn} />
		</View>
	);
}

function InvitationRow({ status, onWithdraw }: { status: CadreInviteStatus; onWithdraw: () => void }) {
	const { invite } = status;
	const uses = invite.totalUses !== null && invite.totalUses > 1 ? ` · ${status.usesRecorded} of ${invite.totalUses} used` : '';
	return (
		<View style={styles.inviteRow}>
			<View style={styles.inviteText}>
				<Text style={styles.inviteFor}>{invite.peerId ? `For ${shortPeerId(invite.peerId)}` : 'Anyone with the text'}</Text>
				<Text style={styles.inviteMeta}>
					{invite.grantsOwner ? 'owner' : 'member'} · {validUntilText(parseNullableStoredDatetimeMs(invite.expiresAt))}{uses}
				</Text>
			</View>
			<View style={styles.withdrawBtn}>
				<Btn label="Withdraw" onPress={onWithdraw} color="#444" testID={TEST_IDS.settings.withdrawInvitationBtn(invite.key)} />
			</View>
		</View>
	);
}

/**
 * Nothing is minted until the owner agrees, because the prompt is where they see which app they
 * are letting in. A request another app opened this one with is worded for that (Allow / Deny);
 * the system back button denies it, so the asking app is not left waiting.
 */
function RequestPrompt({ pending, grantsOwner, onGrantsOwnerChange, onApprove, onDeny }: {
	pending: PendingRequest | null;
	grantsOwner: boolean;
	onGrantsOwnerChange: (value: boolean) => void;
	onApprove: () => void;
	onDeny: () => void;
}) {
	const appName = pending?.request.appName ?? '';
	const code = pending ? shortPeerId(pending.request.peerId) : '';
	const linked = Boolean(pending?.answerTo);
	return (
		<Modal visible={pending !== null} transparent animationType="fade" onRequestClose={onDeny}>
			<View style={controlStyles.modalOverlay}>
				<View style={controlStyles.modalBox}>
					<Text style={controlStyles.modalTitle}>{linked ? LINKED_PROMPT_TITLE : `Add ${appName} to your cadre?`}</Text>
					<ScrollView>
						{linked ? (
							<>
								<Text style={styles.promptText}>{`It calls itself ${appName}. That name cannot be checked.`}</Text>
								<Fact label="Code" value={code} note="Check it matches the code the asking app showed." />
								<Text style={styles.promptText}>{LINKED_GRANT_LINE}</Text>
							</>
						) : (
							<>
								<Fact
									label="App"
									value={appName}
									note="The name is what the app calls itself; check the code below matches the one it shows."
								/>
								<Fact label="Code" value={code} />
							</>
						)}
						<OwnerSwitch value={grantsOwner} onChange={onGrantsOwnerChange} explained={!linked} testID={TEST_IDS.settings.requestOwnerSwitch} />
					</ScrollView>
					<Btn label={linked ? 'Allow' : 'Add'} onPress={onApprove} testID={TEST_IDS.settings.approveJoinRequestBtn} />
					<Btn label={linked ? 'Deny' : 'Cancel'} onPress={onDeny} color="#444" testID={TEST_IDS.settings.cancelJoinRequestBtn} />
				</View>
			</View>
		</Modal>
	);
}

function WithdrawPrompt({ open, onConfirm, onCancel }: { open: boolean; onConfirm: () => void; onCancel: () => void }) {
	return (
		<Modal visible={open} transparent animationType="fade" onRequestClose={onCancel}>
			<View style={controlStyles.modalOverlay}>
				<View style={controlStyles.modalBox}>
					<Text style={controlStyles.modalTitle}>Withdraw this invitation?</Text>
					<Text style={styles.promptText}>Nobody can join with it afterwards.</Text>
					<Btn label="Withdraw" onPress={onConfirm} color="#f44336" testID={TEST_IDS.settings.confirmWithdrawBtn} />
					<Btn label="Cancel" onPress={onCancel} color="#444" testID={TEST_IDS.settings.cancelWithdrawBtn} />
				</View>
			</View>
		</Modal>
	);
}

function isJoinRequest(text: string): boolean {
	return text.trim().startsWith(CADRE_JOIN_REQUEST_PREFIX);
}

/**
 * The invitations still redeemable, latest expiry first. A row records no creation time;
 * among invitations of one kind the newest expires last.
 */
function outstanding(statuses: CadreInviteStatus[]): CadreInviteStatus[] {
	const expiry = (status: CadreInviteStatus) => parseNullableStoredDatetimeMs(status.invite.expiresAt) ?? Number.MAX_SAFE_INTEGER;
	return statuses.filter((status) => status.live).sort((a, b) => expiry(b) - expiry(a));
}

/** "Valid until 14:32", with the weekday when that is not today, in the phone's own time zone. */
function validUntilText(expiresAtMs: number | null): string {
	if (expiresAtMs === null) return 'No expiry';
	const at = new Date(expiresAtMs);
	const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	if (at.toDateString() === new Date().toDateString()) return `Valid until ${time}`;
	return `Valid until ${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const styles = StyleSheet.create({
	subTitle: { color: '#fff', fontSize: 14, fontWeight: '600', marginTop: 12, marginBottom: 6 },
	switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
	switchLabel: { color: '#fff', fontSize: 14 },
	inviteRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
	inviteText: { flex: 1 },
	inviteFor: { color: '#fff', fontSize: 13 },
	inviteMeta: { color: '#888', fontSize: 12, marginTop: 2 },
	withdrawBtn: { width: 110 },
	promptText: { color: '#ccc', fontSize: 14, lineHeight: 20, marginBottom: 8 },
});
