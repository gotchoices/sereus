/**
 * join-cadre-section.tsx — Settings → "Join my existing cadre": this app joins the cadre another
 * Sereus app already holds, moves its chats there and removes its own cadre from this phone
 * (docs/reference-app-rn.md → "Joining an existing cadre"). The other side is the owner app's
 * "Add a device or app" (`add-device-section.tsx`).
 *
 * The request comes from the hook (`joinRequestText`) and a pasted or scanned response enters
 * through the hook's `joinExistingCadre`, which also refuses a response made for another app, so
 * a second way in (a link from another app on this phone) needs no logic of its own here. From
 * Join on, the flow the hook holds replaces the inputs.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CADRE_INVITATION_PREFIX } from '@serfab/cadre-core';
import { useCadre } from './cadre-context';
import { CodeScanner } from './code-scanner';
import { joinFailureAlert } from './join-failure';
import { joinFlowText, type JoinFlow } from './join-flow';
import { Btn, controlStyles, Fact, LabelledInput, Section, shortPeerId } from './settings-controls';
import { ShareCode } from './share-code';
import { TEST_IDS } from './test-ids';

const INTRO_LINE = 'If another Sereus app already holds your cadre, this app can join it. Its chats move with it, and its own cadre is then removed from this phone.';
const FIRST_LAUNCH_LINE = 'If another Sereus app already holds your cadre, this app can join it.';

const SCAN_HINT = 'Point the camera at the invitation the app holding your cadre shows.';
const SCAN_OTHER_CODE_HINT = 'That is not an invitation. Point the camera at the invitation the app holding your cadre shows under Add a device or app.';

type ShowAlert = (title: string, message: string, detail?: string) => void;

type JoinRequest =
	| { state: 'reading' }
	| { state: 'ready'; text: string; peerId: string }
	| { state: 'failed'; error: string };

export function JoinCadreSection({ showAlert, firstLaunch = false }: {
	showAlert: ShowAlert;
	/** This app has no cadre of its own yet, so nothing moves and nothing is removed. */
	firstLaunch?: boolean;
}) {
	const cadre = useCadre();
	// Kept here, not in the inputs, which unmount while a flow shows: a failed join keeps the paste.
	const [invitationText, setInvitationText] = useState('');
	const [scannerOpen, setScannerOpen] = useState(false);

	const join = async (text: string) => {
		const encoded = text.trim();
		if (!encoded) return;
		try {
			await cadre.joinExistingCadre(encoded);
			setInvitationText('');
		} catch (err) {
			console.warn('[settings] joining a cadre failed:', err);
			const { title, message } = joinFailureAlert(err);
			showAlert(title, message);
		}
	};

	const handleScanned = (text: string) => {
		setScannerOpen(false);
		setInvitationText(text);
		void join(text);
	};

	return (
		<Section title="Join my existing cadre">
			<Text style={controlStyles.hint}>{firstLaunch ? FIRST_LAUNCH_LINE : INTRO_LINE}</Text>
			{cadre.joinFlow ? (
				<JoinFlowView flow={cadre.joinFlow} />
			) : (
				<>
					<RequestView />
					<LabelledInput label="Paste response or invitation" value={invitationText} onChangeText={setInvitationText} placeholder="sereus-invite:1.…" multiline testID={TEST_IDS.settings.cadreInvitationInput} />
					<Btn label="Scan" onPress={() => setScannerOpen(true)} color="#444" testID={TEST_IDS.settings.scanCadreInvitationBtn} />
					<Btn label="Join" onPress={() => void join(invitationText)} disabled={!invitationText.trim()} testID={TEST_IDS.settings.joinCadreBtn} />
				</>
			)}
			<CodeScanner
				visible={scannerOpen}
				accepts={isInvitation}
				hint={SCAN_HINT}
				otherCodeHint={SCAN_OTHER_CODE_HINT}
				onScanned={handleScanned}
				onClose={() => setScannerOpen(false)}
			/>
		</Section>
	);
}

function RequestView() {
	const request = useJoinRequest();
	if (request.state === 'reading') return <Text style={controlStyles.hint}>Reading this app&apos;s identity…</Text>;
	if (request.state === 'failed') {
		return <Text style={controlStyles.slowHint}>Could not read this app&apos;s identity, so it has no request to show: {request.error}</Text>;
	}
	return (
		<View>
			<ShareCode title="This app's request" text={request.text} testIDPrefix={TEST_IDS.settings.joinRequestShare} />
			<Fact
				label="Code"
				value={shortPeerId(request.peerId)}
				note="The app holding your cadre shows this code when it asks you to add this app; check that they match."
			/>
			<Text style={controlStyles.hint}>
				Paste this in the app that holds your cadre, under Add a device or app → Paste request. Or ask that app for an open invitation.
			</Text>
		</View>
	);
}

function JoinFlowView({ flow }: { flow: JoinFlow }) {
	const { line, detail } = joinFlowText(flow);
	return (
		<View>
			<Text style={styles.line} testID={TEST_IDS.settings.joinFlowLine}>{line}</Text>
			{detail ? <Text style={controlStyles.hint} testID={TEST_IDS.settings.joinFlowDetail}>{detail}</Text> : null}
			<FlowActions flow={flow} />
		</View>
	);
}

/** No action while the app is admitted and the kit is still moving or removing: none of it rolls back. */
function FlowActions({ flow }: { flow: JoinFlow }) {
	const cadre = useCadre();
	switch (flow.step) {
		case 'joining':
			return <Btn label="Cancel" onPress={cadre.cancelJoin} color="#444" testID={TEST_IDS.settings.cancelJoinBtn} />;
		case 'move-incomplete':
			return (
				<>
					<Btn label="Retry moving" onPress={() => void cadre.retryStrandMove()} testID={TEST_IDS.settings.retryStrandMoveBtn} />
					<Btn label="Later" onPress={cadre.dismissJoinFlow} color="#444" testID={TEST_IDS.settings.joinFlowLaterBtn} />
				</>
			);
		case 'confirm-discard':
			return (
				<>
					<Btn
						label="Delete them"
						onPress={() => void cadre.removeOldCadre([...flow.strandIds, ...flow.pendingJoinIds])}
						color="#f44336"
						testID={TEST_IDS.settings.discardOldCadreItemsBtn}
					/>
					<Btn label="Keep old cadre" onPress={cadre.keepOldCadre} color="#444" testID={TEST_IDS.settings.keepOldCadreBtn} />
				</>
			);
		case 'old-cadre-remains':
			return (
				<>
					<Btn label="Remove it now" onPress={() => void cadre.removeOldCadre()} testID={TEST_IDS.settings.removeOldCadreBtn} />
					<Btn label="Later" onPress={cadre.dismissJoinFlow} color="#444" testID={TEST_IDS.settings.joinFlowLaterBtn} />
				</>
			);
		case 'old-cadre-kept':
		case 'done':
			return <Btn label="OK" onPress={cadre.dismissJoinFlow} testID={TEST_IDS.settings.joinFlowOkBtn} />;
		default:
			return null;
	}
}

/** This app's join request and its peer id, read once the section shows; neither changes, whichever party runs. */
function useJoinRequest(): JoinRequest {
	const { identityPeerId, joinRequestText } = useCadre();
	const [request, setRequest] = useState<JoinRequest>({ state: 'reading' });
	useEffect(() => {
		let current = true;
		const read = async () => {
			try {
				const [peerId, text] = await Promise.all([identityPeerId(), joinRequestText()]);
				if (current) setRequest({ state: 'ready', text, peerId });
			} catch (err) {
				console.warn('[settings] could not read this app\'s identity for its join request:', err);
				if (current) setRequest({ state: 'failed', error: err instanceof Error ? err.message : String(err) });
			}
		};
		void read();
		return () => {
			current = false;
		};
	}, [identityPeerId, joinRequestText]);
	return request;
}

function isInvitation(text: string): boolean {
	return text.trim().startsWith(CADRE_INVITATION_PREFIX);
}

const styles = StyleSheet.create({
	line: { color: '#fff', fontSize: 14, lineHeight: 20, marginBottom: 8 },
});
